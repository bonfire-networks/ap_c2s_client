// Shared DaisyUI stylesheet for shadow DOM components.
// Fetches once, browser caches it, all components adopt the same sheet.

const daisySheet = new CSSStyleSheet();

// TODO: for production, consider building this CSS (with only classes we use) at compile time instead of fetching the whole thing at runtime.
fetch('https://cdn.jsdelivr.net/npm/daisyui@4/dist/full.min.css')
  .then(r => r.text())
  .then(css => daisySheet.replace(css));

export function adoptDaisyUI(element) {
  if (element.shadowRoot) {
    element.shadowRoot.adoptedStyleSheets = [
      ...element.shadowRoot.adoptedStyleSheets,
      daisySheet
    ];
  }
}
