import { render } from 'preact';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { detect } from '../../content/adapters';
import { Panel } from '../../content/panel/Panel';
import { PANEL_CSS } from '../../content/panel/styles';
import { BUILTIN_MATCHES } from '../../shared/sites';

declare global {
  interface Window {
    __celeraMounted?: boolean;
  }
}

export default defineContentScript({
  matches: BUILTIN_MATCHES,
  runAt: 'document_idle',
  main(ctx) {
    if (window.top !== window) return;
    // Guard against double injection (manifest + runtime executeScript).
    if (window.__celeraMounted) return;
    window.__celeraMounted = true;

    const host = document.createElement('celera-root');
    // Closed shadow root: page scripts cannot reach into the panel through host.shadowRoot.
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    const mount = document.createElement('div');
    shadow.append(style, mount);
    document.documentElement.append(host);

    let current = location.href;
    const draw = (href: string) => {
      current = href;
      render(<Panel detection={detect(href)} />, mount);
    };
    draw(current);

    // SPA navigation. WXT's event comes from the Navigation API "navigate" event, which
    // fires before location.href changes, so use the destination URL it carries.
    ctx.addEventListener(window, 'wxt:locationchange', (e) => {
      if (e.newUrl.href !== current) draw(e.newUrl.href);
    });
    // Fallback for routers the Navigation API does not report (and for missed events).
    ctx.setInterval(() => {
      if (location.href !== current) draw(location.href);
    }, 700);
    ctx.onInvalidated(() => {
      render(null, mount);
      host.remove();
      window.__celeraMounted = false;
    });
  },
});
