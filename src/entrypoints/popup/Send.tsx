import { useEffect, useState } from 'preact/hooks';
import { formatEther, formatUnits, getAddress, isAddress, parseUnits, type Address } from 'viem';
import { CHAINS } from '../../shared/chains';
import { formatCompact, formatUsd, parseDecimalInput } from '../../shared/format';
import type { Portfolio, RecipientCheck, SendPrep } from '../../shared/messages';
import type { GlobalSettings } from '../../shared/settings/defaults';
import { shortAddress, type WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { Button, Notice, PasswordField, TextField } from '../../ui/components';
import { ChainMark, Picker } from './Picker';

const NATIVE = 'native';

/** Splits an address into groups of four so it can be checked by eye. */
function grouped(a: string): string {
  return `0x ${
    a
      .slice(2)
      .match(/.{1,4}/g)
      ?.join(' ') ?? ''
  }`;
}

type Check = { tone: 'ok' | 'warn' | 'bad' | 'info'; text: string };

/**
 * Send native or a token to any address. Two steps: the form, then a review screen
 * with the full address. The background re-checks everything and asks for the
 * password above the confirmation threshold.
 */
export function Send({
  accounts,
  defaultChainId,
  initialWalletId,
  onSent,
}: {
  accounts: WalletAccount[];
  defaultChainId: number;
  initialWalletId: string | null;
  onSent: (ticketId: string) => void;
}) {
  const chains = [...CHAINS.values()];
  const visible = accounts.filter((a) => !a.hidden || a.id === initialWalletId);
  const fallback = accounts.find((a) => a.primary) ?? visible[0];
  const [chainId, setChainId] = useState(defaultChainId);
  const [walletId, setWalletId] = useState(initialWalletId ?? fallback?.id ?? '');
  const [asset, setAsset] = useState<string>(NATIVE);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [prep, setPrep] = useState<SendPrep | null>(null);
  const [check, setCheck] = useState<RecipientCheck | null>(null);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chain = chains.find((c) => c.id === chainId);
  const sym = chain?.nativeCurrency.symbol ?? 'ETH';
  const wallet = accounts.find((a) => a.id === walletId);

  useEffect(() => {
    void send({ type: 'settings.get' }).then((r) => r.ok && setSettings(r.data));
  }, []);

  useEffect(() => {
    setPortfolio(null);
    if (!walletId) return;
    void send({ type: 'portfolio.get', chainId, walletIds: [walletId] }).then(
      (r) => r.ok && setPortfolio(r.data),
    );
  }, [chainId, walletId]);

  // A token held on one chain or wallet may not exist on the next.
  useEffect(() => setAsset(NATIVE), [chainId, walletId]);

  useEffect(() => {
    setPrep(null);
    if (!walletId) return;
    void send({
      type: 'send.prepare',
      chainId,
      walletId,
      ...(asset !== NATIVE ? { token: asset as Address } : {}),
    }).then((r) => r.ok && setPrep(r.data));
  }, [chainId, walletId, asset]);

  const toTrim = to.trim();
  const validTo = isAddress(toTrim, { strict: true });
  // Mixed case that fails the checksum usually means a typo.
  const badChecksum =
    !validTo &&
    isAddress(toTrim, { strict: false }) &&
    /[A-F]/.test(toTrim) &&
    /[a-f]/.test(toTrim);
  const toAddr = validTo ? getAddress(toTrim) : null;

  useEffect(() => {
    setCheck(null);
    if (!toAddr) return;
    const id = setTimeout(() => {
      void send({ type: 'send.checkRecipient', chainId, to: toAddr }).then(
        (r) => r.ok && setCheck(r.data),
      );
    }, 300);
    return () => clearTimeout(id);
  }, [toAddr, chainId]);

  const token = asset === NATIVE ? null : portfolio?.tokens.find((t) => t.address === asset);
  const decimals = token ? token.decimals : 18;
  const unit = token ? token.symbol : sym;
  const held = token
    ? BigInt(token.perWallet[walletId] ?? '0')
    : BigInt(portfolio?.native[walletId] ?? '0');

  const parsed = parseDecimalInput(amount);
  let raw: bigint | null = null;
  try {
    raw = parsed ? parseUnits(parsed, decimals) : null;
  } catch {
    raw = null;
  }
  const max = prep ? BigInt(prep.maxAmount) : null;
  const tooMuch = raw !== null && max !== null && raw > max;

  const nativeUsd = portfolio?.nativeUsd ?? null;
  const usd =
    raw === null
      ? null
      : token
        ? token.valueUsd !== null && BigInt(token.total) > 0n
          ? (token.valueUsd * Number(formatUnits(raw, decimals))) /
            Number(formatUnits(BigInt(token.total), decimals))
          : null
        : nativeUsd !== null
          ? Number(formatEther(raw)) * nativeUsd
          : null;
  const feeWei = prep ? BigInt(prep.feeWei) : null;
  const feeText =
    feeWei === null
      ? '…'
      : `${formatCompact(Number(formatEther(feeWei)))} ${sym}${
          nativeUsd !== null ? ` (${formatUsd(Number(formatEther(feeWei)) * nativeUsd)})` : ''
        }`;

  const checks: Check[] = [];
  if (badChecksum)
    checks.push({ tone: 'bad', text: 'Checksum does not match. Check the address for typos.' });
  else if (toTrim && !validTo) checks.push({ tone: 'bad', text: 'Not a valid address.' });
  if (toAddr) checks.push({ tone: 'ok', text: 'Valid address' });
  if (check?.tokenSymbol)
    checks.push({
      tone: 'bad',
      text: `This is the ${check.tokenSymbol} token contract. Funds sent here are usually lost.`,
    });
  else if (check?.contract)
    checks.push({
      tone: 'warn',
      text: `This is a contract. Continue only if it accepts ${unit} on ${chain?.name}, like an exchange deposit or smart wallet.`,
    });
  if (check?.ownName)
    checks.push({
      tone: 'info',
      text: `This is your wallet "${check.ownName}". Fund and Collect move funds between your wallets.`,
    });
  else if (check && !check.sentBefore)
    checks.push({ tone: 'warn', text: 'First time sending to this address.' });
  if (toAddr && wallet && toAddr.toLowerCase() === wallet.address.toLowerCase())
    checks.push({ tone: 'bad', text: 'This is the wallet you are sending from.' });

  const blocked = checks.some((c) => c.tone === 'bad');
  const ready = !!toAddr && !!check && raw !== null && raw > 0n && !tooMuch && !blocked;
  const passwordNeeded =
    needPassword || usd === null || (settings !== null && usd > settings.confirmAboveUsd);

  const assetOptions = [
    {
      value: NATIVE,
      label: sym,
      sub: `${formatCompact(Number(formatEther(BigInt(portfolio?.native[walletId] ?? '0'))))} ${sym}`,
    },
    ...(portfolio?.tokens ?? [])
      // Unrequested airdrops stay out until the user marks them as theirs in Wallets.
      .filter((t) => !t.unsolicited && BigInt(t.perWallet[walletId] ?? '0') > 0n)
      .map((t) => ({
        value: t.address,
        label: t.symbol,
        sub: `${formatCompact(Number(formatUnits(BigInt(t.perWallet[walletId] ?? '0'), t.decimals)))} ${t.symbol}`,
      })),
  ];

  const submit = async () => {
    if (!toAddr || raw === null || !parsed) return;
    setError(null);
    setBusy(true);
    const r = await send({
      type: 'send.execute',
      chainId,
      walletId,
      to: toAddr,
      amount: parsed,
      ...(asset !== NATIVE ? { token: asset as Address } : {}),
      ...(passwordNeeded && password ? { password } : {}),
    });
    setBusy(false);
    setPassword('');
    if (r.ok) onSent(r.data.id);
    else if (r.error === 'needs_password') {
      setNeedPassword(true);
      setError('Enter your password to send this.');
    } else setError(errorText(r));
  };

  if (step === 'review' && toAddr && raw !== null) {
    return (
      <div class="stack">
        <h2>Review send</h2>
        <div class="card td-card">
          <div class="kv">
            <span class="muted">Amount</span>
            <span class="kv-v">
              {formatCompact(Number(formatUnits(raw, decimals)))} {unit}
              {usd !== null && <span class="usd">{formatUsd(usd)}</span>}
            </span>
          </div>
          <div class="kv">
            <span class="muted">From</span>
            <span class="kv-v">{wallet?.name}</span>
          </div>
          <div class="kv">
            <span class="muted">Network</span>
            <span class="kv-v">{chain?.name}</span>
          </div>
          <div class="kv">
            <span class="muted">Network fee</span>
            <span class="kv-v">≈ {feeText}</span>
          </div>
        </div>
        <div class="field">
          <span class="label">To</span>
          <div class="addr-full mono">{grouped(toAddr)}</div>
        </div>
        {checks
          .filter((c) => c.tone === 'warn')
          .map((c) => (
            <Notice key={c.text} tone="warn">
              {c.text}
            </Notice>
          ))}
        <p class="hint">Sends cannot be undone. Check the address against the source.</p>
        {passwordNeeded && (
          <PasswordField label="Password" value={password} onInput={setPassword} autoFocus />
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <Button
          variant="primary"
          block
          disabled={busy || (passwordNeeded && !password)}
          onClick={() => void submit()}
        >
          {busy ? 'Sending…' : `Send ${formatCompact(Number(formatUnits(raw, decimals)))} ${unit}`}
        </Button>
        <Button variant="ghost" block onClick={() => setStep('form')}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div class="stack">
      <h2>Send</h2>
      <div class="field">
        <span class="label">Network</span>
        <Picker
          title="Send on"
          value={chainId}
          onChange={setChainId}
          options={chains.map((c) => ({
            value: c.id,
            label: c.name,
            sub: c.nativeCurrency.symbol,
            mark: <ChainMark chainId={c.id} />,
          }))}
        />
      </div>
      <div class="field">
        <span class="label">From</span>
        <Picker
          title="Send from"
          value={walletId}
          onChange={setWalletId}
          options={visible.map((a) => ({
            value: a.id,
            label: `${a.name}${a.primary ? ' ★' : ''}`,
            sub: shortAddress(a.address),
          }))}
        />
      </div>
      <div class="field">
        <span class="label">Asset</span>
        <Picker title="Asset" value={asset} onChange={setAsset} options={assetOptions} />
      </div>
      <TextField label="To" value={to} onInput={setTo} placeholder="0x…" mono maxLength={64} />
      {checks.length > 0 && (
        <ul class="checks">
          {checks.map((c) => (
            <li key={c.text} class={`chk chk--${c.tone}`}>
              {c.text}
            </li>
          ))}
        </ul>
      )}
      <div class="field">
        <div class="row">
          <label class="label" for="send-amount">
            Amount ({unit})
          </label>
          <span class="spacer" />
          <button
            type="button"
            class="link"
            disabled={!max}
            onClick={() => max !== null && setAmount(formatUnits(max, decimals))}
          >
            Max
          </button>
        </div>
        <input
          id="send-amount"
          class="input"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onInput={(e) => setAmount(e.currentTarget.value)}
        />
        <p class={tooMuch ? 'error' : 'hint'}>
          {tooMuch
            ? asset === NATIVE
              ? `More than the balance after the fee (${formatCompact(Number(formatUnits(max ?? 0n, decimals)))} ${unit}).`
              : 'More than the balance.'
            : `Balance ${formatCompact(Number(formatUnits(held, decimals)))} ${unit}${
                usd !== null ? ` · ≈ ${formatUsd(usd)}` : ''
              } · fee ≈ ${feeText}`}
        </p>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <Button
        variant="primary"
        block
        disabled={!ready}
        onClick={() => {
          setError(null);
          setStep('review');
        }}
      >
        Review
      </Button>
    </div>
  );
}
