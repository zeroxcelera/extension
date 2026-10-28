import { useEffect, useMemo, useState } from 'preact/hooks';
import { english, generateMnemonic } from 'viem/accounts';
import { MIN_PASSWORD_LENGTH } from '../../background/vault/constants';
import { passwordStrength } from '../../shared/password';
import { shortAddress, type WalletAccount } from '../../shared/wallet';
import { errorText, send } from '../../ui/api';
import { BirdMark } from '../../ui/BirdMark';
import { Button, Checkbox, Notice, PasswordField, useAutoFocus } from '../../ui/components';

type Step =
  | { name: 'loading' }
  | { name: 'exists' }
  | { name: 'welcome' }
  | { name: 'password'; mode: 'create' | 'import' }
  | { name: 'show'; password: string; mnemonic: string }
  | { name: 'confirm'; password: string; mnemonic: string }
  | { name: 'import'; password: string }
  | { name: 'done'; account: WalletAccount | undefined };

export function Onboarding() {
  const [step, setStep] = useState<Step>({ name: 'loading' });

  useEffect(() => {
    void send({ type: 'vault.status' }).then((r) =>
      setStep(r.ok && r.data.exists ? { name: 'exists' } : { name: 'welcome' }),
    );
  }, []);

  const progress =
    step.name === 'password'
      ? 1
      : step.name === 'show' || step.name === 'import'
        ? 2
        : step.name === 'confirm'
          ? 3
          : step.name === 'done'
            ? 4
            : 0;

  return (
    <main class="onb">
      <header class="row">
        <h1 class="brand">
          <BirdMark size={22} />
          Celera
        </h1>
        <span class="muted">Wallet setup</span>
      </header>
      <div class="steps" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} data-on={String(progress >= i)} />
        ))}
      </div>
      <section class="card onb-card">
        {step.name === 'loading' && <p class="muted">Loading…</p>}
        {step.name === 'exists' && <Exists />}
        {step.name === 'welcome' && (
          <Welcome
            onCreate={() => setStep({ name: 'password', mode: 'create' })}
            onImport={() => setStep({ name: 'password', mode: 'import' })}
          />
        )}
        {step.name === 'password' && (
          <ChoosePassword
            onBack={() => setStep({ name: 'welcome' })}
            onNext={(password) =>
              setStep(
                step.mode === 'create'
                  ? { name: 'show', password, mnemonic: generateMnemonic(english) }
                  : { name: 'import', password },
              )
            }
          />
        )}
        {step.name === 'show' && (
          <ShowPhrase
            mnemonic={step.mnemonic}
            onNext={() =>
              setStep({ name: 'confirm', password: step.password, mnemonic: step.mnemonic })
            }
          />
        )}
        {step.name === 'confirm' && (
          <ConfirmPhrase
            mnemonic={step.mnemonic}
            password={step.password}
            onBack={() =>
              setStep({ name: 'show', password: step.password, mnemonic: step.mnemonic })
            }
            onDone={(account) => setStep({ name: 'done', account })}
          />
        )}
        {step.name === 'import' && (
          <ImportPhrase
            password={step.password}
            onBack={() => setStep({ name: 'password', mode: 'import' })}
            onDone={(account) => setStep({ name: 'done', account })}
          />
        )}
        {step.name === 'done' && <Done account={step.account} />}
      </section>
    </main>
  );
}

function Exists() {
  return (
    <div class="stack">
      <h2>Celera is already set up</h2>
      <p class="muted">Open the Celera popup from the toolbar to unlock. You can close this tab.</p>
    </div>
  );
}

function Welcome({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <div class="stack">
      <h2>Set up your trading wallet</h2>
      <p class="muted">
        Keys are generated and encrypted on this device. Nothing is sent to any server.
      </p>
      <button type="button" class="choice" onClick={onCreate}>
        <strong>Create a new wallet</strong>
        <span class="muted">Generates a new 12-word recovery phrase.</span>
      </button>
      <button type="button" class="choice" onClick={onImport}>
        <strong>Import a recovery phrase</strong>
        <span class="muted">Use an existing 12 or 24-word phrase.</span>
      </button>
      <Notice tone="warn">
        Celera trades on mainnet with real funds. Start with a fresh wallet holding a small amount.
      </Notice>
    </div>
  );
}

const STRENGTH_HINT = {
  weak: 'Strength: weak. Anyone who copies the encrypted wallet could guess it; use 12+ characters or a passphrase of 4+ words.',
  fair: 'Strength: fair. Longer is better: a passphrase of 4+ words is easy to remember.',
  strong: 'Strength: strong.',
} as const;

function ChoosePassword({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = password.length >= MIN_PASSWORD_LENGTH && confirm === password;

  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onNext(password);
      }}
    >
      <h2>Choose a password</h2>
      <p class="muted">
        Unlocks Celera on this browser. It cannot be recovered — your recovery phrase is the backup.
      </p>
      <PasswordField
        label="Password"
        value={password}
        onInput={setPassword}
        autoFocus
        autoComplete="new-password"
        hint={
          password.length >= MIN_PASSWORD_LENGTH
            ? STRENGTH_HINT[passwordStrength(password)]
            : `At least ${MIN_PASSWORD_LENGTH} characters. A long passphrase is best.`
        }
        error={tooShort ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
      />
      <PasswordField
        label="Confirm password"
        value={confirm}
        onInput={setConfirm}
        autoComplete="new-password"
        error={mismatch ? 'Passwords do not match.' : undefined}
      />
      <div class="row">
        <Button onClick={onBack}>Back</Button>
        <span class="spacer" />
        <Button variant="primary" type="submit" disabled={!valid}>
          Continue
        </Button>
      </div>
    </form>
  );
}

function ShowPhrase({ mnemonic, onNext }: { mnemonic: string; onNext: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const [saved, setSaved] = useState(false);
  const words = mnemonic.split(' ');

  return (
    <div class="stack">
      <h2>Back up your recovery phrase</h2>
      <p class="muted">
        Write these 12 words down in order and keep them offline. Anyone with them controls your
        funds.
      </p>
      <div style={{ position: 'relative' }}>
        <ol class="words" data-hidden={String(!revealed)} aria-hidden={!revealed}>
          {words.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
        {!revealed && (
          <div class="reveal">
            <Button variant="primary" onClick={() => setRevealed(true)}>
              Reveal phrase
            </Button>
          </div>
        )}
      </div>
      <Notice tone="warn">
        Never type this phrase into a website. Celera will never ask for it on a trading page.
      </Notice>
      <Checkbox checked={saved} onChange={setSaved}>
        I wrote down my recovery phrase.
      </Checkbox>
      <div class="row">
        <span class="spacer" />
        <Button variant="primary" disabled={!revealed || !saved} onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function pickPositions(count: number, total: number): number[] {
  const picks = new Set<number>();
  const rand = new Uint32Array(1);
  while (picks.size < count) {
    crypto.getRandomValues(rand);
    picks.add((rand[0] ?? 0) % total);
  }
  return [...picks].sort((a, b) => a - b);
}

function ConfirmPhrase({
  mnemonic,
  password,
  onBack,
  onDone,
}: {
  mnemonic: string;
  password: string;
  onBack: () => void;
  onDone: (account: WalletAccount | undefined) => void;
}) {
  const words = mnemonic.split(' ');
  const positions = useMemo(() => pickPositions(3, words.length), [mnemonic]);
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstRef = useAutoFocus<HTMLInputElement>();

  const correct = positions.every((p, i) => answers[i]?.trim().toLowerCase() === words[p]);

  const submit = async () => {
    if (!correct) {
      setError('Those words do not match your phrase. Check your backup.');
      return;
    }
    setBusy(true);
    const res = await send({ type: 'vault.create', mnemonic, password });
    setBusy(false);
    if (res.ok) onDone(res.data[0]);
    else setError(errorText(res));
  };

  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>Confirm your backup</h2>
      <p class="muted">Enter the requested words from your recovery phrase.</p>
      <div class="confirm-grid">
        {positions.map((p, i) => (
          <div class="field" key={p}>
            <label for={`w${p}`}>Word #{p + 1}</label>
            <input
              ref={i === 0 ? firstRef : null}
              id={`w${p}`}
              class="input mono"
              value={answers[i]}
              autoComplete="off"
              spellcheck={false}
              onInput={(e) => {
                const next = [...answers];
                next[i] = e.currentTarget.value;
                setAnswers(next);
                setError(null);
              }}
            />
          </div>
        ))}
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {busy && <p class="muted">Encrypting your wallet… (about a second)</p>}
      <div class="row">
        <Button onClick={onBack} disabled={busy}>
          Show phrase again
        </Button>
        <span class="spacer" />
        <Button variant="primary" type="submit" disabled={busy || answers.some((a) => !a.trim())}>
          Create wallet
        </Button>
      </div>
    </form>
  );
}

function ImportPhrase({
  password,
  onBack,
  onDone,
}: {
  password: string;
  onBack: () => void;
  onDone: (account: WalletAccount | undefined) => void;
}) {
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useAutoFocus<HTMLTextAreaElement>();

  const submit = async () => {
    setBusy(true);
    const res = await send({ type: 'vault.create', mnemonic: phrase, password });
    setBusy(false);
    if (res.ok) {
      setPhrase('');
      onDone(res.data[0]);
    } else setError(errorText(res));
  };

  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>Import recovery phrase</h2>
      <div class="field">
        <label for="phrase">Recovery phrase (12 or 24 words)</label>
        <textarea
          ref={ref}
          id="phrase"
          class="textarea"
          value={phrase}
          autoComplete="off"
          spellcheck={false}
          onInput={(e) => {
            setPhrase(e.currentTarget.value);
            setError(null);
          }}
        />
      </div>
      <p class="hint">
        Wallets 1, 2, 3… use the standard paths m/44'/60'/0'/0/0, /1, /2… (same as MetaMask accounts
        1, 2, 3…).
      </p>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {busy && <p class="muted">Encrypting your wallet… (about a second)</p>}
      <div class="row">
        <Button onClick={onBack} disabled={busy}>
          Back
        </Button>
        <span class="spacer" />
        <Button variant="primary" type="submit" disabled={busy || !phrase.trim()}>
          Import wallet
        </Button>
      </div>
    </form>
  );
}

function Done({ account }: { account: WalletAccount | undefined }) {
  return (
    <div class="stack">
      <h2>You're set</h2>
      {account && (
        <p>
          Wallet 1: <span class="mono">{shortAddress(account.address)}</span>
        </p>
      )}
      <ol class="stack muted" style={{ paddingLeft: '18px', margin: 0 }}>
        <li>Pin Celera from the extensions menu in the toolbar.</li>
        <li>Fund Wallet 1 with a small amount to start.</li>
        <li>Open a token page on GMGN or DEX Screener — the Celera panel appears there.</li>
      </ol>
      <p class="muted">You can close this tab.</p>
    </div>
  );
}
