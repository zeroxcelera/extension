import { browser } from 'wxt/browser';

// Offscreen document whose only job is to blank the clipboard after a delay.
// It never receives the secret: it just overwrites whatever is there.
const delay = Number(new URLSearchParams(location.search).get('clearAfter') ?? '30000');

setTimeout(
  () => {
    const onCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      e.clipboardData?.setData('text/plain', '');
    };
    document.addEventListener('copy', onCopy);
    document.execCommand('copy');
    document.removeEventListener('copy', onCopy);
    void browser.runtime.sendMessage({ type: 'offscreen.done' });
  },
  Number.isFinite(delay) ? Math.min(Math.max(delay, 0), 120_000) : 30_000,
);
