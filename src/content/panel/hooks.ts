import { useEffect, useRef, useState } from 'preact/hooks';
import type { PanelPrefs } from '../../shared/messages';
import { send } from '../../ui/api';
import { PANEL_WIDTH } from './layout';

export type { PanelPrefs };

const DEFAULT: PanelPrefs = { x: -1, y: -1, minimized: false, hidden: false };

/**
 * Panel position and state, remembered per site by the background (content scripts have
 * no access to extension storage, which also holds the encrypted vault).
 */
export function usePanelPrefs(): [PanelPrefs, (p: Partial<PanelPrefs>) => void] {
  const [prefs, setPrefs] = useState<PanelPrefs>(DEFAULT);
  useEffect(() => {
    void send({ type: 'panel.getPrefs' }).then((r) => {
      if (r.ok) setPrefs(r.data);
    });
  }, []);
  const update = (p: Partial<PanelPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...p };
      void send({ type: 'panel.setPrefs', prefs: next });
      return next;
    });
  };
  return [prefs, update];
}

/** Drag by a handle; keeps the panel inside the viewport. */
export function useDrag(onDrop: (x: number, y: number) => void) {
  const pos = useRef<{ dx: number; dy: number } | null>(null);
  const [live, setLive] = useState<{ x: number; y: number } | null>(null);

  const onPointerDown = (e: PointerEvent) => {
    if (!e.isTrusted || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a')) return;
    const box = (e.currentTarget as HTMLElement).closest('.k')?.getBoundingClientRect();
    if (!box) return;
    pos.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!pos.current) return;
    const x = clamp(e.clientX - pos.current.dx, 0, window.innerWidth - PANEL_WIDTH);
    const y = clamp(e.clientY - pos.current.dy, 0, window.innerHeight - 40);
    setLive({ x, y });
  };
  const onPointerUp = () => {
    if (pos.current && live) onDrop(live.x, live.y);
    pos.current = null;
    setLive(null);
  };
  return { live, handlers: { onPointerDown, onPointerMove, onPointerUp } };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

export function isEditable(el: EventTarget | null | undefined): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** Focused element, descending into open shadow roots (closed ones stop at the host). */
function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/**
 * Global hotkeys: 1–4 buy, Q/W/E/R sell. Only real (trusted) key presses, never while
 * typing anywhere (including the site's own inputs), never with modifiers.
 *
 * `isTypingInPanel` covers the panel's own inputs: they live in a closed shadow root,
 * so from this window-level listener the event target is just the host element.
 */
export function useHotkeys(
  enabled: boolean,
  onKey: (k: string) => void,
  isTypingInPanel: () => boolean,
) {
  const cb = useRef(onKey);
  cb.current = onKey;
  const typing = useRef(isTypingInPanel);
  typing.current = isTypingInPanel;
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (!e.isTrusted || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (
        typing.current() ||
        isEditable(e.composedPath()[0]) ||
        isEditable(deepActiveElement() ?? undefined)
      ) {
        return;
      }
      const k = e.key.toLowerCase();
      if (['1', '2', '3', '4', 'q', 'w', 'e', 'r'].includes(k)) {
        e.preventDefault();
        e.stopPropagation();
        cb.current(k);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [enabled]);
}

/** Wraps a click handler so synthetic (page-generated) clicks are ignored. */
export function trusted<E extends Event>(fn: (e: E) => void) {
  return (e: E) => {
    if (!e.isTrusted) return;
    fn(e);
  };
}
