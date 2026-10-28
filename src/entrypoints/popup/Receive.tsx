import { useMemo, useState } from 'preact/hooks';
import { encode } from 'uqr';
import { CHAINS } from '../../shared/chains';
import { shortAddress, type WalletAccount } from '../../shared/wallet';
import { Button, useCopy } from '../../ui/components';
import { Picker } from './Picker';

const QUIET = 3;

/** QR code as one SVG path (no markup strings, no network). */
function Qr({ text }: { text: string }) {
  const { d, size } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 0 });
    let path = '';
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
      }),
    );
    return { d: path, size: qr.size + QUIET * 2 };
  }, [text]);
  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code of the address">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#0d1220" shape-rendering="crispEdges" />
    </svg>
  );
}

export function Receive({
  accounts,
  initialWalletId,
}: {
  accounts: WalletAccount[];
  initialWalletId: string | null;
}) {
  const visible = accounts.filter((a) => !a.hidden || a.id === initialWalletId);
  const fallback = accounts.find((a) => a.primary) ?? visible[0];
  const [walletId, setWalletId] = useState(initialWalletId ?? fallback?.id ?? '');
  const [copied, copy] = useCopy();
  const wallet = accounts.find((a) => a.id === walletId);
  const chainNames = [...CHAINS.values()].map((c) => c.name);

  if (!wallet) return <p class="muted">No wallet to receive with.</p>;
  return (
    <div class="stack">
      <h2>Receive</h2>
      <Picker
        title="Receive into"
        value={walletId}
        onChange={setWalletId}
        options={visible.map((a) => ({
          value: a.id,
          label: `${a.name}${a.primary ? ' ★' : ''}`,
          sub: shortAddress(a.address),
        }))}
      />
      <Qr text={wallet.address} />
      <div class="addr-full mono">{wallet.address}</div>
      <Button variant="primary" block onClick={() => void copy(wallet.address)}>
        {copied === wallet.address ? 'Copied' : 'Copy address'}
      </Button>
      <p class="hint">
        The same address works on {chainNames.slice(0, -1).join(', ')} and {chainNames.at(-1)}. Make
        sure the sender uses one of these networks.
      </p>
    </div>
  );
}
