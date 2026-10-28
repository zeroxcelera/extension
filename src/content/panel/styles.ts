import { PANEL_GAP, PANEL_WIDTH, TOASTS_WIDTH } from './layout';

// Injected as a <style> text node inside the closed shadow root, so page CSS cannot leak in.
//
// Look: "storm ink". A deep blue-slate base (it sits on dark terminals, so it stays dark)
// with lightning yellow kept for the brand, focus and the moment a trade fires. Numbers
// and keys use Bahnschrift (Windows' DIN), falling back to DIN Alternate / system UI.
export const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.k, .toasts {
  --bg: #0d1220; --surface: #141b2d; --surface-2: #1b2438; --border: #232d45; --border-strong: #31405f;
  --text: #e8ecf6; --muted: #8e9ab5; --faint: #5f6b87;
  --flash: #ffe066; --flash-hot: #fff6c2; --buy: #2ee59d; --sell: #ff5c7a; --warn: #ffb547; --focus: #8fb4ff;
  --num: "Bahnschrift", "DIN Alternate", "DIN 2014", ui-sans-serif, system-ui, sans-serif;
  --ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.k {
  position: fixed; z-index: 2147483647; width: ${PANEL_WIDTH}px;
  /* Never taller than the window: on short windows the rest scrolls, the header stays. */
  max-height: calc(100vh - 16px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin;
  color: var(--text);
  background:
    radial-gradient(120% 60% at 100% 0%, rgb(143 180 255 / .07), transparent 60%),
    var(--bg);
  border: 1px solid var(--border-strong); border-radius: 14px;
  box-shadow: 0 1px 0 rgb(255 255 255 / .04) inset, 0 18px 50px rgb(2 6 18 / .7);
  font: 12px/1.4 var(--ui);
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.k button, .k input { font: inherit; color: inherit; }
.k :focus-visible { outline: 2px solid var(--flash); outline-offset: 1px; }

/* header */
.head { display: flex; align-items: center; gap: 7px; padding: 9px 10px 8px 12px; border-bottom: 1px solid var(--border); cursor: grab; position: sticky; top: 0; z-index: 2; background: var(--bg); border-radius: 14px 14px 0 0; }
.head:active { cursor: grabbing; }
.brand { display: inline-flex; align-items: center; gap: 5px; color: var(--flash); font: 700 13px/1 var(--num); letter-spacing: .01em; }
.bird-mark { flex: none; }
.chain { font: 600 10.5px/1 var(--num); padding: 3px 6px; border-radius: 5px; background: var(--surface-2); color: var(--muted); }
.sym { font: 700 13px/1 var(--num); max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp { flex: 1; }
.addr { font: 500 10.5px/1 var(--num); color: var(--faint); text-decoration: none; }
.addr:hover { color: var(--focus); text-decoration: underline; }
.ib { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; border: 1px solid transparent; background: none; color: var(--muted); cursor: pointer; }
.ib:hover { color: var(--text); background: var(--surface-2); }

.body { padding: 10px 12px 12px; display: grid; gap: 11px; }
.row { display: flex; align-items: center; gap: 6px; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }
.lbl { font-size: 11px; font-weight: 600; color: var(--muted); }

/* wallet picker */
.pick-wrap { display: grid; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--surface); cursor: pointer; font-weight: 600; }
.chip:hover, .chip[aria-expanded="true"] { border-color: var(--focus); }
.picker { display: grid; gap: 2px; max-height: 220px; overflow: auto; padding: 4px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: 0 10px 30px rgb(2 6 18 / .6); }
.wrow { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
.wrow:hover { background: var(--surface-2); }
.wrow input { accent-color: var(--flash); margin: 0; }
.wrow .muted { font-family: var(--num); }
.wrow .faint, .wrow .muted { white-space: nowrap; }

.pos { display: flex; justify-content: space-between; gap: 8px; padding: 7px 9px; border-radius: 9px; background: var(--surface); font-family: var(--num); font-size: 12.5px; }
.pos .muted, .pos .faint { font-family: var(--ui); font-size: 12px; }
.pos > span:last-child { text-align: right; }
.pnl { display: block; font-size: 11.5px; }
.pnl.up { color: var(--buy); }
.pnl.down { color: var(--sell); }

/* trade keys: the panel's one loud element */
.lbl-row { display: flex; align-items: center; gap: 4px; margin-bottom: 5px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.sells { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.tb {
  position: relative; overflow: hidden; display: grid; gap: 2px; text-align: left;
  padding: 8px 9px 7px; border-radius: 9px; cursor: pointer;
  border: 1px solid; border-bottom-width: 2px;
  transition: transform .06s ease, border-color .12s ease;
}
.tb:active:not(:disabled) { transform: translateY(1px); }
.tb:disabled { opacity: .4; cursor: not-allowed; }
.tb .main { font: 600 15px/1.1 var(--num); letter-spacing: .005em; }
.tb .sub { font: 500 11px/1.2 var(--num); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tb.buy {
  background: linear-gradient(180deg, color-mix(in srgb, var(--buy) 13%, var(--surface)), color-mix(in srgb, var(--buy) 5%, var(--surface)));
  border-color: color-mix(in srgb, var(--buy) 30%, transparent);
  border-bottom-color: color-mix(in srgb, var(--buy) 70%, transparent);
}
.tb.buy .main { color: color-mix(in srgb, var(--buy) 35%, var(--text)); }
.tb.buy:hover:not(:disabled) { border-color: var(--buy); }
.tb.sell {
  text-align: center; padding-inline: 4px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--sell) 13%, var(--surface)), color-mix(in srgb, var(--sell) 5%, var(--surface)));
  border-color: color-mix(in srgb, var(--sell) 30%, transparent);
  border-bottom-color: color-mix(in srgb, var(--sell) 70%, transparent);
}
.sells .tb { padding-top: 17px; }
.sells .tb kbd { top: 4px; right: 50%; transform: translateX(50%); }
.tb.sell .main { color: color-mix(in srgb, var(--sell) 35%, var(--text)); }
.tb.sell:hover:not(:disabled) { border-color: var(--sell); }
.tb kbd {
  position: absolute; top: 5px; right: 6px; min-width: 14px; text-align: center;
  font: 600 9.5px/1 var(--num); color: var(--muted);
  padding: 2px 3px 1px; border-radius: 4px;
  background: var(--bg); border: 1px solid var(--border-strong); border-bottom-width: 2px;
}
/* Sending: a flash runs across the key until the background answers. */
.tb[aria-busy="true"] { cursor: progress; border-color: var(--flash); }
.tb[aria-busy="true"] .sub { color: var(--flash-hot); }
.tb[aria-busy="true"]::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(100deg, transparent 30%, rgb(255 230 120 / .28) 50%, transparent 70%);
  animation: strike .7s linear infinite;
}
@keyframes strike { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.imp-ok { color: var(--buy); } .imp-warn { color: var(--warn); } .imp-bad { color: var(--sell); }

/* inputs and buttons */
.custom { display: flex; gap: 6px; }
.custom input { flex: 1; min-width: 0; height: 32px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--border-strong); background: var(--surface); font-family: var(--num); font-size: 13px; user-select: text; }
.custom input:focus { outline: none; border-color: var(--focus); }
.custom input::placeholder { color: var(--faint); font-family: var(--ui); font-size: 12px; }
.btn { height: 32px; padding: 0 13px; border-radius: 9px; border: 1px solid var(--border-strong); background: var(--surface-2); cursor: pointer; font-weight: 700; }
.btn:hover:not(:disabled) { border-color: var(--muted); }
.btn.sm { height: 22px; padding: 0 8px; border-radius: 6px; font-size: 11px; }
.btn.buy { background: var(--buy); border-color: var(--buy); color: #03170e; }
.btn.sell { background: var(--sell); border-color: var(--sell); color: #1d0309; }
.btn.accent { background: var(--flash); border-color: var(--flash); color: #1a1405; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 7px; overflow: hidden; }
.seg button { border: 0; background: var(--surface); padding: 3px 8px; cursor: pointer; color: var(--muted); }
.seg button[aria-pressed="true"] { background: var(--flash); color: #1a1405; font-weight: 700; }

.summary { padding: 7px 9px; border-radius: 9px; background: var(--surface); border: 1px dashed var(--border-strong); font-family: var(--num); }
.card { border: 1px solid var(--border-strong); border-radius: 10px; padding: 9px 10px; background: var(--surface); display: grid; gap: 6px; }
.card.danger { border-color: color-mix(in srgb, var(--sell) 55%, transparent); background: color-mix(in srgb, var(--sell) 6%, var(--surface)); }
.card.warn { border-color: color-mix(in srgb, var(--warn) 55%, transparent); background: color-mix(in srgb, var(--warn) 6%, var(--surface)); }
.act { display: flex; gap: 6px; align-items: baseline; }
.act .ok { color: var(--buy); } .act .no { color: var(--sell); }

/* footer status */
.status { display: flex; gap: 2px 6px; align-items: center; font-size: 10.5px; color: var(--faint); border-top: 1px solid var(--border); padding: 7px 12px; }
.status > span { white-space: nowrap; flex: none; }
/* One line: the venue name gives way first (full name in its tooltip). */
.status > .venue { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.status > .sp { flex: 1; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); flex: none; }
.dot.on { background: var(--buy); box-shadow: 0 0 0 3px rgb(46 229 157 / .15); }
.dot.err { background: var(--sell); }

.mini { display: flex; align-items: center; gap: 6px; padding: 7px 9px; }
.mini .tb { padding: 5px 9px 4px; }
.mini .tb .main { font-size: 13px; }

/* toasts */
.toasts { position: fixed; z-index: 2147483647; right: ${PANEL_GAP}px; bottom: ${PANEL_GAP}px; display: grid; gap: 8px; width: ${TOASTS_WIDTH}px; }
.toast {
  position: relative; overflow: hidden; display: grid; gap: 6px;
  padding: 9px 10px 10px 13px; border-radius: 11px;
  background: var(--bg); border: 1px solid var(--border-strong);
  color: var(--text); font: 12px/1.4 var(--ui); font-variant-numeric: tabular-nums;
  box-shadow: 0 14px 36px rgb(2 6 18 / .65); user-select: none;
  animation: toast-in .18s ease-out;
}
/* Status rail on the left edge. */
.toast::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--faint); }
.toast.ok::before { background: var(--buy); }
.toast.bad::before { background: var(--sell); }
.toast.warn::before { background: var(--warn); }
.toast.live::before { background: var(--flash); }
@keyframes toast-in { from { opacity: 0; transform: translateY(6px); } }
.t-head { display: flex; align-items: center; gap: 8px; }
.t-head strong { flex: 1; font-weight: 700; }
.t-count { font: 600 11px/1 var(--num); color: var(--muted); padding: 3px 6px; border-radius: 5px; background: var(--surface-2); }
.t-msg { color: #ffb3c1; }
.t-legs { display: grid; gap: 3px; font-size: 11.5px; }
.t-leg { display: grid; grid-template-columns: 8px auto 1fr auto; align-items: center; column-gap: 6px; }
.t-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
.s-confirmed .t-dot { background: var(--buy); }
.s-failed .t-dot, .s-blocked .t-dot, .s-skipped .t-dot { background: var(--sell); }
.s-submitted .t-dot, .s-sending .t-dot { background: var(--flash); }
.t-who { font-weight: 600; }
.t-amt { color: var(--muted); font-family: var(--num); }
.t-st { color: var(--muted); text-align: right; }
.t-st a { color: var(--focus); text-decoration: none; }
.t-st a:hover { text-decoration: underline; }
.t-ms { color: var(--flash); font-family: var(--num); }
.t-net { color: var(--muted); font-family: var(--num); }
.t-err { grid-column: 2 / -1; min-width: 0; color: #ffb3c1; overflow-wrap: anywhere; }
.t-acts { grid-column: 2 / -1; display: flex; gap: 6px; margin-top: 2px; }
/* Time left before the toast closes itself. Hover pauses it. */
.ttl { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--border-strong); transform-origin: left; animation: ttl linear forwards; }
@keyframes ttl { from { transform: scaleX(1); } to { transform: scaleX(0); } }

.unlock-frame { width: 100%; height: 150px; border: 0; border-radius: 10px; background: var(--surface); color-scheme: dark; }
.hint { font-size: 10.5px; color: var(--faint); }
.ib.pen { width: 20px; height: 20px; font-size: 12px; }
.ib.pen[aria-pressed="true"] { color: var(--flash); background: var(--surface-2); }
.ib.pen svg { display: block; }

/* trade options */
.opts { display: grid; gap: 6px; padding: 8px 9px; border-radius: 10px; background: var(--surface); }
.opt-row { display: grid; grid-template-columns: 58px 1fr; align-items: center; gap: 6px; }
.opt-label { color: var(--muted); font-size: 11px; }
.opt-chips { display: flex; flex-wrap: nowrap; align-items: center; gap: 2px; min-width: 0; }
.opt { height: 24px; padding: 0 6px; white-space: nowrap; border-radius: 6px; border: 1px solid transparent; background: none; color: var(--muted); cursor: pointer; font: 600 11.5px/1 var(--num); }
.opt:hover:not(:disabled) { color: var(--text); background: var(--surface-2); }
.opt[aria-pressed="true"] { color: var(--text); border-color: var(--border-strong); background: var(--surface-2); }
.opt:disabled { opacity: .45; cursor: not-allowed; }
.opt.mev[aria-pressed="true"] { background: #0f5f63; border-color: #2bc2c9; color: #e8fdff; }
.inl { display: inline-flex; align-items: center; gap: 2px; height: 24px; padding: 0 5px; margin-left: auto; flex: none; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--faint); font-family: var(--num); }
.inl.on { border-color: var(--border-strong); color: var(--text); background: var(--surface-2); }
.inl input { width: 30px; border: 0; background: none; padding: 0; text-align: right; user-select: text; font-family: var(--num); }
.inl input:focus { outline: none; }
.inl:focus-within { border-color: var(--focus); }
.qa-edit { display: grid; gap: 6px; }
.qa-err { font-size: 10.5px; color: var(--sell); }
.grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.qa-field { display: grid; gap: 2px; font-size: 10.5px; min-width: 0; }
.qa-input { display: flex; min-width: 0; align-items: center; gap: 4px; height: 32px; padding: 0 8px; border-radius: 9px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--muted); }
.qa-input:focus-within { border-color: var(--focus); }
.qa-input input { flex: 1; width: 100%; min-width: 0; border: 0; background: none; padding: 0; font: 600 13px/1 var(--num); user-select: text; }
.qa-input input:focus { outline: none; }
.qa-input input[aria-invalid="true"] { color: var(--sell); }

@media (prefers-reduced-motion: reduce) {
  .toast, .tb[aria-busy="true"]::after { animation: none; }
  .ttl { display: none; }
}
`;
