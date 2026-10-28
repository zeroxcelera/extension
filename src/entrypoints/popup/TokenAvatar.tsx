import { useEffect, useState } from 'preact/hooks';
import { send } from '../../ui/api';

/** Logos are cached by the background; this avoids re-asking within one popup session. */
const memo = new Map<string, string | null>();

function hue(seed: string): number {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

/**
 * Token logo (fetched and validated by the background), or a coloured letter when there
 * is none or logos are turned off. The image is always a data: URL from our cache.
 */
export function TokenAvatar({
  chainId,
  token,
  symbol,
  size = 30,
}: {
  chainId: number;
  token: string | 'native';
  symbol: string;
  size?: number;
}) {
  const key = `${chainId}:${token.toLowerCase()}`;
  const [src, setSrc] = useState<string | null>(memo.get(key) ?? null);

  useEffect(() => {
    if (memo.has(key)) {
      setSrc(memo.get(key) ?? null);
      return;
    }
    let alive = true;
    void send({ type: 'logo.get', chainId, token: token as `0x${string}` | 'native' }).then((r) => {
      const url = r.ok && r.data && r.data.startsWith('data:image/') ? r.data : null;
      memo.set(key, url);
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [key]);

  const style = { width: `${size}px`, height: `${size}px` };
  if (src) return <img class="av" src={src} alt="" style={style} />;
  return (
    <span
      class="av"
      aria-hidden="true"
      style={{ ...style, background: `hsl(${hue(key)} 45% 28%)` }}
    >
      {[...symbol][0]?.toUpperCase() ?? '?'}
    </span>
  );
}
