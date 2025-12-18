// openmlsUser.js
// Persistent OpenMLS user key package logic for Bonfire
// - Generates and stores a key package on first use
// - Sends the key package to LiveView backend via pushEvent
// - Provides helper to retrieve the key package for group operations


import { initOpenMLS } from './openmls.js';
import { bytesToHex, hexToBytes } from './openmlsUtils.js';
import { saveUserKeyPackage, loadUserKeyPackage } from './openmlsStorage.js';

// Helper to extract public key from KeyPackage (assuming OpenMLS WASM API)
export function extractPublicKey(keyPackage) {
  // This assumes keyPackage has a method to get the public key bytes
  // Adjust as needed for your OpenMLS WASM API
  if (typeof keyPackage.public_key === 'function') {
    return bytesToHex(keyPackage.public_key());
  }
  // Fallback: if public key is part of the serialized key package, extract accordingly
  // (You may need to adjust this for your OpenMLS WASM build)
  return null;
}

// userLabel is a stable identifier for the user (e.g., 'me' or userId)
export async function getOrCreateUserKeyPackage(userLabel = 'me') {
  const openmlsWasm = await initOpenMLS();
  let keyPackageHex = await loadUserKeyPackage(userLabel);
  let provider, identity, keyPackage, newlyCreated, publicKey = false;
  if (keyPackageHex) { // already have a stored key package
    provider = new openmlsWasm.Provider();
    identity = new openmlsWasm.Identity(provider, userLabel);
    keyPackage = openmlsWasm.KeyPackage.from_bytes(hexToBytes(keyPackageHex));
  } else { // need to create and store a new key package
    provider = new openmlsWasm.Provider();
    identity = new openmlsWasm.Identity(provider, userLabel);
    keyPackage = identity.key_package(provider);
    keyPackageHex = bytesToHex(keyPackage.to_bytes());
    await saveUserKeyPackage(userLabel, keyPackageHex);
    newlyCreated = true;
  }
  publicKey = extractPublicKey(keyPackage)
  // return { provider, identity, keyPackage, keyPackageHex, newlyCreated };
  return { provider, identity, publicKey, newlyCreated };
}

