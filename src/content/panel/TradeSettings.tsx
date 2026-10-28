import { useEffect, useState } from 'preact/hooks';
import { formatPercent, parseDecimalInput } from '../../shared/format';
import type { PanelState } from '../../shared/panel';
import {
  MAX_TAX_CHOICES_BPS,
  PRIORITY_LEVELS,
  SLIPPAGE_CHOICES_BPS,
  type PriorityLevel,
} from '../../shared/settings/defaults';
import { trusted } from './hooks';

export interface TradePatch {
  quickBuyAmounts?: string[];
  quickSellBps?: number[];
  slippageBps?: number;
  priority?: PriorityLevel;
  customPriorityGwei?: string;
  mevEnabled?: boolean;
  maxTaxBps?: number;
}

const LEVEL_LABEL: Record<(typeof PRIORITY_LEVELS)[number], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** Small numeric input that commits on Enter or blur; reverts when invalid. */
function InlineNumber(props: {
  value: string;
  suffix: string;
  label: string;
  active: boolean;
  onCommit: (v: string) => boolean;
}) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  const commit = () => {
    const parsed = parseDecimalInput(v);
    if (parsed === null || !props.onCommit(parsed)) setV(props.value);
  };
  return (
    <label class={`inl${props.active ? ' on' : ''}`}>
      <input
        aria-label={props.label}
        inputMode="decimal"
        value={v}
        onInput={(e) => setV(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
      <span>{props.suffix}</span>
    </label>
  );
}

/** Slippage, priority fee and MEV protection, right under the quick-buy buttons. */
export function TradeSettings({
  chain,
  onChange,
}: {
  chain: PanelState['chain'];
  onChange: (patch: TradePatch) => void;
}) {
  const customSlippage = !SLIPPAGE_CHOICES_BPS.some((b) => b === chain.slippageBps);
  const customTax =
    chain.maxTaxBps < 10_000 && !MAX_TAX_CHOICES_BPS.some((b) => b === chain.maxTaxBps);
  return (
    <div class="opts">
      <div class="opt-row">
        <span class="opt-label">Slippage</span>
        <div class="opt-chips" role="group" aria-label="Slippage">
          {SLIPPAGE_CHOICES_BPS.map((bps) => (
            <button
              key={bps}
              type="button"
              class="opt"
              aria-pressed={chain.slippageBps === bps}
              onClick={trusted(() => onChange({ slippageBps: bps }))}
            >
              {formatPercent(bps)}
            </button>
          ))}
          <InlineNumber
            label="Custom slippage in percent"
            value={customSlippage ? String(chain.slippageBps / 100) : ''}
            suffix="%"
            active={customSlippage}
            onCommit={(v) => {
              const bps = Math.round(Number(v) * 100);
              if (!(bps >= 1 && bps <= 5000)) return false;
              onChange({ slippageBps: bps });
              return true;
            }}
          />
        </div>
      </div>

      <div class="opt-row">
        <span class="opt-label">Max tax</span>
        <div class="opt-chips" role="group" aria-label="Max token tax">
          <button
            type="button"
            class="opt"
            aria-pressed={chain.maxTaxBps >= 10_000}
            title="Buy whatever the token tax"
            onClick={trusted(() => onChange({ maxTaxBps: 10_000 }))}
          >
            Off
          </button>
          {MAX_TAX_CHOICES_BPS.map((bps) => (
            <button
              key={bps}
              type="button"
              class="opt"
              aria-pressed={chain.maxTaxBps === bps}
              title={`Refuse buys when the buy or sell tax is above ${formatPercent(bps)}`}
              onClick={trusted(() => onChange({ maxTaxBps: bps }))}
            >
              {formatPercent(bps)}
            </button>
          ))}
          <InlineNumber
            label="Custom max tax in percent"
            value={customTax ? String(chain.maxTaxBps / 100) : ''}
            suffix="%"
            active={customTax}
            onCommit={(v) => {
              const bps = Math.round(Number(v) * 100);
              if (!(bps >= 0 && bps < 10_000)) return false;
              onChange({ maxTaxBps: bps });
              return true;
            }}
          />
        </div>
      </div>

      {chain.priorityApplies && (
        <div class="opt-row">
          <span class="opt-label">Priority</span>
          <div class="opt-chips" role="group" aria-label="Priority fee">
            {PRIORITY_LEVELS.map((lvl) => (
              <button
                key={lvl}
                type="button"
                class="opt"
                aria-pressed={chain.priority === lvl}
                title={`${chain.priorityGwei[lvl]} gwei`}
                onClick={trusted(() => onChange({ priority: lvl }))}
              >
                {LEVEL_LABEL[lvl]}
              </button>
            ))}
            <InlineNumber
              label="Custom priority fee in gwei"
              value={chain.priority === 'custom' ? chain.customPriorityGwei : ''}
              suffix="gwei"
              active={chain.priority === 'custom'}
              onCommit={(v) => {
                onChange({ priority: 'custom', customPriorityGwei: v });
                return true;
              }}
            />
          </div>
        </div>
      )}

      <div class="opt-row">
        <span class="opt-label">Protection</span>
        <div class="opt-chips">
          {chain.mev.supported ? (
            <button
              type="button"
              class="opt mev"
              aria-pressed={chain.mev.enabled && chain.mev.configured}
              disabled={!chain.mev.configured}
              title={
                chain.mev.configured
                  ? 'Send through your private RPC'
                  : 'Set a private RPC in Settings → Chains to enable'
              }
              onClick={trusted(() => onChange({ mevEnabled: !chain.mev.enabled }))}
            >
              🛡 MEV
            </button>
          ) : (
            <span class="faint" title={chain.mev.reason ?? ''}>
              Not needed on this chain
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Edit mode for the four quick-buy amounts or quick-sell percentages (opened with the
 * pencil icon). Values are decimal strings; `validate` decides what can be saved.
 */
export function QuickValuesEditor({
  values: initial,
  unit,
  what,
  columns,
  validate,
  onSave,
  onCancel,
}: {
  values: string[];
  unit: string;
  /** e.g. "Quick-buy amount" — used for accessible labels. */
  what: string;
  columns: 2 | 4;
  validate: (n: number) => boolean;
  onSave: (values: string[]) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const parsed = values.map((v) => parseDecimalInput(v));
  // Two buttons with the same value would share a hotkey slot and a busy state.
  const repeated = parsed.map(
    (v, i) => v !== null && parsed.findIndex((w) => w !== null && Number(w) === Number(v)) !== i,
  );
  const ok = parsed.map((v, i) => v !== null && validate(Number(v)) && !repeated[i]);
  const valid = ok.every(Boolean);
  return (
    <form
      class="qa-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (e.isTrusted && valid) onSave(parsed as string[]);
      }}
    >
      <div class={columns === 4 ? 'grid4' : 'grid'}>
        {values.map((v, i) => (
          <label key={i} class="qa-field">
            <span class="qa-input">
              <input
                aria-label={`${what} ${i + 1} in ${unit}`}
                inputMode="decimal"
                value={v}
                aria-invalid={!ok[i]}
                onInput={(e) => {
                  const next = [...values];
                  next[i] = e.currentTarget.value;
                  setValues(next);
                }}
              />
              <span>{unit}</span>
            </span>
          </label>
        ))}
      </div>
      {repeated.some(Boolean) && (
        <span class="qa-err" role="alert">
          Each value must be different.
        </span>
      )}
      <div class="row">
        <span class="sp" />
        <button type="button" class="btn" onClick={trusted(onCancel)}>
          Cancel
        </button>
        <button type="submit" class="btn accent" disabled={!valid}>
          Save
        </button>
      </div>
    </form>
  );
}

/** A quick-sell size: above 0, at most 100, and at most two decimals (whole basis points). */
export function isSellPercent(n: number): boolean {
  return n > 0 && n <= 100 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

/** Pencil icon; the tip points down-left, towards the label it sits next to. */
export function PenIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21.17 6.81a2.82 2.82 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}
