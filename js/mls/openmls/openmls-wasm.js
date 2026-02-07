/**
 * Lazy-loads the OpenMLS WASM module.
 *
 * Returns the full WASM API: { Provider, Identity, Group, KeyPackage, RatchetTree, AddMessages }
 */

let wasm = null;

export async function loadWasm() {
  if (!wasm) {
    wasm = await import('/assets/openmls/openmls_wasm.js');
    if (wasm.default) {
      await wasm.default('/assets/openmls/openmls_wasm_bg.wasm');
    }
  }
  return wasm;
}
