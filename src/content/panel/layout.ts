// Panel and toast geometry, shared by the stylesheet, the drag hook and toast placement.

/** Panel width and its default gap to the window edge, in px (styles.ts uses these too). */
export const PANEL_WIDTH = 320;
export const PANEL_GAP = 16;
/** Toast stack width, in px. */
export const TOASTS_WIDTH = 300;

/**
 * Where the toast stack goes so it never covers the panel: bottom-right by default; just
 * left of the panel when the panel sits in that column; along the top when the window is
 * too narrow for both side by side (the default column is already the rightmost one).
 */
export function toastPlacement(panelX: number, viewportWidth: number): Record<string, string> {
  const right = viewportWidth - PANEL_GAP;
  const left = right - TOASTS_WIDTH;
  const overlaps = panelX < right && panelX + PANEL_WIDTH > left;
  if (!overlaps) return {};
  if (panelX - PANEL_GAP >= TOASTS_WIDTH + PANEL_GAP)
    return { right: `${viewportWidth - panelX + PANEL_GAP}px` };
  return { top: `${PANEL_GAP}px`, bottom: 'auto' };
}
