import { useState } from 'preact/hooks';
import { errorText, send } from '../../ui/api';
import { Button, PasswordField, TextField } from '../../ui/components';

export function ImportKey({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  return (
    <form
      class="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const res = await send({
          type: 'wallets.importKey',
          privateKey: key,
          ...(name.trim() ? { name } : {}),
        });
        setBusy(false);
        if (res.ok) {
          setKey('');
          onDone();
        } else setError(errorText(res));
      }}
    >
      <h2>Import private key</h2>
      <PasswordField
        label="Private key"
        value={key}
        onInput={(v) => (setKey(v), setError(undefined))}
        autoFocus
        mono
        error={error}
      />
      <TextField label="Name (optional)" value={name} onInput={setName} maxLength={32} />
      <Button variant="primary" type="submit" block disabled={busy || !key.trim()}>
        Import
      </Button>
    </form>
  );
}
