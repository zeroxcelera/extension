/** Subset of chrome.runtime.MessageSender that the check relies on. */
export interface SenderInfo {
  id?: string | undefined;
  url?: string | undefined;
  origin?: string | undefined;
  frameId?: number | undefined;
  tab?: unknown;
}

/**
 * - extension-page: popup, onboarding tab, offscreen document (top-level extension pages)
 * - extension-frame: an extension page embedded as an iframe in a trading page
 * - content-script: top-frame content script on an allowed https origin
 */
export type SenderKind = 'extension-page' | 'extension-frame' | 'content-script';

/** Classifies a message sender, or returns null if it must be ignored. */
export function classifySender(
  sender: SenderInfo,
  extensionId: string,
  isAllowedOrigin: (origin: string) => boolean,
): SenderKind | null {
  if (!extensionId || sender.id !== extensionId) return null;

  const extPrefix = `chrome-extension://${extensionId}/`;
  if (sender.url?.startsWith(extPrefix)) {
    if (!sender.tab) return 'extension-page';
    // Opened as its own tab (onboarding) vs. embedded in some page.
    return sender.frameId === 0 ? 'extension-page' : 'extension-frame';
  }
  if (!sender.tab) return null;

  if (sender.frameId !== 0) return null;
  const origin = sender.origin ?? safeOrigin(sender.url);
  if (!origin || !origin.startsWith('https://')) return null;
  return isAllowedOrigin(origin) ? 'content-script' : null;
}

function safeOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
