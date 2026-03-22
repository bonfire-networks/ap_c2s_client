/**
 * Lazy-loads the OpenMLS WASM module.
 *
 * Returns the full WASM API: { Provider, Identity, Group, KeyPackage, RatchetTree, AddMessages }
 */

let wasm = null;

export async function loadWasm() {
  if (!wasm) {
    const base = localStorage.getItem('wasmBasePath') || '/assets/openmls/';
    const mod = await import(base + 'openmls_wasm.js');
    if (mod.default) {
      try {
        await mod.default(base + 'openmls_wasm_bg.wasm');
      } catch (e) {
        // getrandom "unsupported platform" can fire if crypto isn't ready yet — retry once
        if (String(e).includes('unsupported platform')) {
          console.warn('[WASM] getrandom not ready, retrying in 300ms…');
          await new Promise(r => setTimeout(r, 300));
          await mod.default(base + 'openmls_wasm_bg.wasm');
        } else {
          throw e;
        }
      }
    }
    wasm = mod;
  }
  return wasm;
}
