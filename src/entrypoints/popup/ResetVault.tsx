import { useState } from 'preact/hooks';
import { errorText, send } from '../../ui/api';
import { Button, Checkbox, TextField } from '../../ui/components';

/**
 * Deletes every wallet from this browser. Reachable from Settings and from the unlock
 * screen ("Forgot password?"), so it needs no password, only a deliberate confirmation.
 */
export function ResetVault({
  onReset,
  walletCount,
}: {
  onReset: () => void;
  /** How many wallets go, when known (the vault may be locked). */
  walletCount?: number | null;
}) {
  const [confirm, setConfirm] = useState('');
  const [backedUp, setBackedUp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div class="danger-zone">
      <span class="section-title">Reset Celera</span>
      <p class="muted">
        Deletes {walletCount ? `all ${walletCount} wallets` : 'all wallets'} from this browser. Only
        your recovery phrase and exported keys can restore them. Forgot your password? This is the
        way back in: reset, then import your recovery phrase.
      </p>
      <Checkbox checked={backedUp} onChange={setBackedUp}>
        I have my recovery phrase (and keys of imported wallets), or these wallets hold nothing I
        need.
      </Checkbox>
      <TextField label='Type "DELETE" to confirm' value={confirm} onInput={setConfirm} />
      {error && <p class="error">{error}</p>}
      <Button
        variant="danger"
        size="sm"
        disabled={confirm !== 'DELETE' || !backedUp}
        onClick={async () => {
          const res = await send({ type: 'vault.reset', confirm: 'DELETE' });
          if (res.ok) onReset();
          else setError(errorText(res));
        }}
        style={{ justifySelf: 'start' }}
      >
        Delete all wallets
      </Button>
    </div>
  );
}
