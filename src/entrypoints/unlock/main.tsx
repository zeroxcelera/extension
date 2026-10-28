import { render } from 'preact';
import { useState } from 'preact/hooks';
import { errorText, send } from '../../ui/api';
import { Button, PasswordField } from '../../ui/components';

/**
 * Embedded in the panel as an extension-origin iframe: the trading page cannot read
 * what is typed here. It can only unlock (FRAME_TYPES), nothing else.
 */
function Unlock() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (done) return <p class="muted">Unlocked.</p>;

  return (
    <form
      class="stack"
      style={{ gap: '8px' }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!e.isTrusted) return;
        setBusy(true);
        const res = await send({ type: 'vault.unlock', password });
        setBusy(false);
        setPassword('');
        if (res.ok) setDone(true);
        else setError(errorText(res));
      }}
    >
      <PasswordField
        label="Password"
        value={password}
        onInput={(v) => (setPassword(v), setError(undefined))}
        error={error}
      />
      <Button variant="primary" type="submit" block disabled={busy || !password}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </Button>
    </form>
  );
}

const root = document.getElementById('app');
if (root) render(<Unlock />, root);
