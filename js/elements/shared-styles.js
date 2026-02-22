// Shared compiled Tailwind + DaisyUI stylesheet for shadow DOM components.
// Built at compile time via `npm run build:css` at the tauri level.
// Fetched once at runtime, all components adopt the same constructed sheet.

const daisySheet = new CSSStyleSheet();

// Find the compiled CSS URL from the page's <link> tag (already resolved by HTML)
const styleLink = document.querySelector('link[href*="styles.css"]');
if (styleLink) {
  fetch(styleLink.href)
    .then(r => r.text())
    .then(css => daisySheet.replace(css));
}

export function adoptDaisyUI(element) {
  if (element.shadowRoot) {
    element.shadowRoot.adoptedStyleSheets = [
      ...element.shadowRoot.adoptedStyleSheets,
      daisySheet
    ];
  }
}
