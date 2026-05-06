// Shared compiled Tailwind + DaisyUI stylesheet for shadow DOM components.
// Built at compile time via `npm run build:css` at the tauri level.
// Fetched once at runtime, all components adopt the same constructed sheet.

import { html } from 'lit';
import 'iconify-icon';

// Tailwind v4 uses @layer rules which WebKit doesn't support in adoptedStyleSheets.
// Inject a <link> element into each shadow root — browser handles caching natively.
const _pageLink = document.querySelector('link[href*="styles.css"]');

/** Render an Iconify icon (defaults to Phosphor Duotone).
 *  size: number in px (default 16, i.e. same as Tailwind size-4). */
export function icon(name, { size = 16, class: cls = '', set = 'ph', style } = {}) {
  const suffix = style || (set === 'ph' ? 'duotone' : '');
  const iconName = suffix ? `${set}:${name}-${suffix}` : `${set}:${name}`;
  return html`<iconify-icon icon="${iconName}" width="${size}" height="${size}" class="${cls}"></iconify-icon>`;
}

export function adoptDaisyUI(element) {
  if (!element.shadowRoot) return;
  if (element.shadowRoot.querySelector('link[data-daisy]')) return;
  if (!_pageLink) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.setAttribute('data-daisy', '');
  link.href = _pageLink.href;
  element.shadowRoot.prepend(link);
}
