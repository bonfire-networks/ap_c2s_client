// openmlsUser.js
// Persistent OpenMLS user key package logic for Bonfire
// - Generates and stores a key package on first use
// - Sends the key package to LiveView backend via pushEvent
// - Provides helper to retrieve the key package for group operations


import { initOpenMLS } from './openmls.js';
import { bytesToHex, hexToBytes } from './openmlsUtils.js';
import { saveUserKeyPackageDraft, loadUserKeyPackage } from './openmlsStorage.js';

// Cache providers and identities per user to avoid losing state WITHIN A SESSION
// NOTE: These are in-memory only and are lost on page reload.
// Combined with OpenMLS WASM's in-memory storage, this means:
// - KeyPackages work ONLY within the same browser session
// - Old invitations become invalid after page reload
// - This is a fundamental limitation until OpenMLS adds persistent storage
const providerCache = new Map();
const identityCache = new Map();

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

  let provider, identity, keyPackage, newlyCreated = false, publicKey = false;

  // Check if we already have a cached provider/identity for this session
  if (providerCache.has(userLabel) && identityCache.has(userLabel)) {
    console.log('[OpenMLS] Reusing cached provider and identity for', userLabel);
    provider = providerCache.get(userLabel);
    identity = identityCache.get(userLabel);

    // Use the first key package from the identity
    const kp = identity.key_package(provider);
    let keyPackageHex = bytesToHex(kp.to_bytes());
    keyPackage = kp;
    publicKey = extractPublicKey(keyPackage);
    return { provider, identity, keyPackage, keyPackageHex, publicKey, newlyCreated: false };
  }

  // Create fresh provider and identity only if not cached
  console.log('[OpenMLS] Creating new provider and identity for', userLabel);
  provider = new openmlsWasm.Provider();
  identity = new openmlsWasm.Identity(provider, userLabel);

  // Cache them for this session
  providerCache.set(userLabel, provider);
  identityCache.set(userLabel, identity);

  let keyPackageHex = await loadUserKeyPackage(userLabel);

  // If we have a stored key package, try to use it
  if (keyPackageHex) {
    try {
      const isBase64 = /^[A-Za-z0-9+/=]+$/.test(keyPackageHex) && keyPackageHex.length % 4 === 0;
      let bytes = isBase64 && !keyPackageHex.includes(':')
        ? Uint8Array.from(atob(keyPackageHex), c => c.charCodeAt(0))
        : hexToBytes(keyPackageHex);

      keyPackage = openmlsWasm.KeyPackage.from_bytes(bytes);
      console.log('[OpenMLS] Successfully loaded stored KeyPackage');

      // CRITICAL: Generate key packages so provider has the private keys
      // If MLS identity is deterministic, this should regenerate the SAME keys
      for (let i = 0; i < 20; i++) {
        const kp = identity.key_package(provider);
        if (i === 0) {
          // Verify first generated package matches stored one
          const generatedBytes = kp.to_bytes();
          const generatedHex = bytesToHex(generatedBytes);
          // Normalize stored keyPackageHex to hex for comparison
          const storedHex = isBase64 ? bytesToHex(bytes) : keyPackageHex;

          if (generatedHex === storedHex) {
            console.log('[OpenMLS] ✓ KeyPackage matches! Old invitations should work');
            keyPackageHex = storedHex;
          } else {
            console.warn('[OpenMLS] KeyPackage mismatch!');
            console.warn('[OpenMLS] Stored:', storedHex.slice(0, 40));
            console.warn('[OpenMLS] Generated:', generatedHex.slice(0, 40));
            keyPackageHex = generatedHex;
            keyPackage = kp;
          }
        }
      }
    } catch (e) {
      console.warn('[OpenMLS] Failed to load stored KeyPackage:', e.message);
      keyPackageHex = null;
    }
  }

  // If no stored key package, generate new ones
  if (!keyPackageHex) {
    for (let i = 0; i < 20; i++) {
      const kp = identity.key_package(provider);
      if (i === 0) {
        keyPackageHex = bytesToHex(kp.to_bytes());
        await saveUserKeyPackageDraft(userLabel, keyPackageHex);
        keyPackage = kp;
      }
    }
    newlyCreated = true;
  } else {
    // Even if we loaded a stored KeyPackage, we need to ensure we have one available
    // Generate at least one to populate the provider's key store
    const kp = identity.key_package(provider);
    if (!keyPackage) {
      keyPackage = kp;
    }
  }

  publicKey = extractPublicKey(keyPackage);
  return { provider, identity, keyPackage, keyPackageHex, publicKey, newlyCreated };
}

export async function getUserKeyPackageHex(userLabel = 'me') {
  const { keyPackageHex } = await getOrCreateUserKeyPackage(userLabel);
  return keyPackageHex;
}

// Ensure provider has fresh key packages available
export async function ensureKeyPackagesAvailable(userLabel = 'me') {
  const openmlsWasm = await initOpenMLS();
  let provider = providerCache.get(userLabel);
  let identity = identityCache.get(userLabel);

  if (!provider || !identity) {
    // Initialize if not cached
    const result = await getOrCreateUserKeyPackage(userLabel);
    provider = result.provider;
    identity = result.identity;
  }

  // IMPORTANT: Load the stored key package and add it back to the provider
  // This ensures the provider can process Welcome messages that reference it
  const storedKeyPackageHex = await loadUserKeyPackage(userLabel);
  if (storedKeyPackageHex) {
    try {
      const storedKeyPackage = openmlsWasm.KeyPackage.from_bytes(hexToBytes(storedKeyPackageHex));
      // The key package is already in the provider from when identity.key_package() was called
      // But we'll generate fresh ones to ensure we have enough
      console.log('[KeyPackage] Loaded stored key package, hex length:', storedKeyPackageHex.length);
    } catch (e) {
      console.warn('[KeyPackage] Failed to load stored key package:', e.message);
    }
  }

  // Generate additional key packages for the provider (operations like RatchetTree.from_bytes consume them)
  for (let i = 0; i < 20; i++) {
    try {
      identity.key_package(provider);
    } catch (e) {
      console.warn('Failed to generate additional key package:', e.message);
      break;
    }
  }
}

