// Shared compiled Tailwind + DaisyUI stylesheet for shadow DOM components.
// Built at compile time via `npm run build:css` at the tauri level.
// Fetched once at runtime, all components adopt the same constructed sheet.

import { html } from 'lit';
import 'iconify-icon';

const daisySheet = new CSSStyleSheet();

// Find the compiled CSS URL from the page's <link> tag (already resolved by HTML)
const styleLink = document.querySelector('link[href*="styles.css"]');
if (styleLink) {
  fetch(styleLink.href)
    .then(r => r.text())
    .then(css => daisySheet.replace(css));
}

/** Render an Iconify icon (defaults to Phosphor Duotone).
 *  size: number in px (default 16, i.e. same as Tailwind size-4). */
export function icon(name, { size = 16, class: cls = '', set = 'ph', style } = {}) {
  const suffix = style || (set === 'ph' ? 'duotone' : '');
  const iconName = suffix ? `${set}:${name}-${suffix}` : `${set}:${name}`;
  return html`<iconify-icon icon="${iconName}" width="${size}" height="${size}" class="${cls}"></iconify-icon>`;
}

export function adoptDaisyUI(element) {
  if (element.shadowRoot) {
    element.shadowRoot.adoptedStyleSheets = [
      ...element.shadowRoot.adoptedStyleSheets,
      daisySheet
    ];
  }
}
