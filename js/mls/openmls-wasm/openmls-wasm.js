/**
 * Lazy-loads the OpenMLS WASM module.
 *
 * Returns the full WASM API: { Provider, Identity, Group, KeyPackage, RatchetTree, AddMessages }
 */

let wasm = null;

export async function loadWasm() {
  if (!wasm) {
    const base = localStorage.getItem('wasmBasePath') || '/assets/openmls/';
    wasm = await import(base + 'openmls_wasm.js');
    if (wasm.default) {
      await wasm.default(base + 'openmls_wasm_bg.wasm');
    }
  }
  return wasm;
}
