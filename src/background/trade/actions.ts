import type { BlockedAction } from '../../shared/panel';

/**
 * One decoded action in the validator's report (shown in the panel when a transaction is
 * blocked). A reason marks it as the one that blocks.
 */
export function act(label: string, reason?: string): BlockedAction {
  return reason ? { label, ok: false, reason } : { label, ok: true };
}
