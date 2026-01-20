// openmlsUser.js
// Persistent OpenMLS user key package logic for Bonfire
// - Generates and stores a key package on first use
// - Sends the key package to LiveView backend via pushEvent
// - Provides helper to retrieve the key package for group operations


import { initOpenMLS } from './openmls.js';
import { bytesToHex, hexToBytes } from './openmlsUtils.js';
import { saveUserKeyPackageDraft, loadUserKeyPackage, saveProviderStorage, loadProviderStorage, loadState, saveState, loadUserState, saveIdentityPublicKey, loadIdentityPublicKey } from './openmlsStorage.js';
import { setKeyPackagePublishedDate } from './openmlsStorage.js';

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
  // if (typeof keyPackage.public_key === 'function') {
    return bytesToHex(keyPackage.public_key());
  // }
  // Fallback: if public key is part of the serialized key package, extract accordingly
  // (You may need to adjust this for your OpenMLS WASM build)
  return null;
}

// Helper to persist provider storage in IndexedDB
async function persistProviderStorage(provider, userLabel) {
  try {
    const exported = provider.export_storage();
    if (exported && exported.length) {
      await saveProviderStorage(userLabel, exported);
      console.log('[OpenMLS] Provider storage exported and saved to Dexie.');
    }
  } catch (e) {
    console.warn('[OpenMLS] Failed to export provider storage:', e);
  }
}

// Helper to restore provider storage using Dexie/IndexedDB
async function restoreProviderStorage(provider, userLabel) {
  if (typeof provider.import_storage === 'function') {
    const saved = await loadProviderStorage(userLabel);
    if (saved) {
      try {
        provider.import_storage(saved);
        console.log('[OpenMLS] Provider storage imported from Dexie.');
      } catch (e) {
        console.warn('[OpenMLS] Failed to import provider storage:', e);
      }
    }
  }
}

export function hasProviderAndIdentity(userLabel = 'me') {
  if (providerCache.has(userLabel) && identityCache.has(userLabel)) {
    return true;
  }
}

export async function prepareProviderIdentity(userLabel = 'me') {
  let provider, identity;
  if (hasProviderAndIdentity(userLabel)) {
    provider = providerCache.get(userLabel);
    identity = identityCache.get(userLabel);
  } else {
    const openmlsWasm = await initOpenMLS();
    let storageBytes = await loadProviderStorage(userLabel);
    let publicKeyBytes = await loadIdentityPublicKey(userLabel);

    if (storageBytes && storageBytes.length) {
      // Restore provider from storage
      provider = openmlsWasm.Provider.new_from_storage(storageBytes);

      if (publicKeyBytes && publicKeyBytes.length) {
        // Restore identity from provider using saved public key
        try {
          identity = openmlsWasm.Identity.from_provider(provider, userLabel, publicKeyBytes);
          console.log('[OpenMLS] Restored Identity from provider storage for userLabel:', userLabel);
        } catch (e) {
          console.warn('[OpenMLS] Failed to restore Identity from provider:', e);
          console.log('[OpenMLS] Creating new Identity (old KeyPackages will be invalidated)');
          identity = new openmlsWasm.Identity(provider, userLabel);
          // Save the new public key
          const newPublicKey = identity.public_key();
          await saveIdentityPublicKey(userLabel, newPublicKey);
        }
      } else {
        // No public key saved, must create new identity
        console.log('[OpenMLS] No public key found, creating new Identity for userLabel:', userLabel);
        identity = new openmlsWasm.Identity(provider, userLabel);
        // Save the public key for next time
        const publicKey = identity.public_key();
        await saveIdentityPublicKey(userLabel, publicKey);
      }

      // Save provider storage after any identity operations
      await persistProviderStorage(provider, userLabel);
    } else {
      // First time setup - create new provider and identity
      console.log('[OpenMLS] No stored provider found, creating new one for userLabel:', userLabel);
      provider = new openmlsWasm.Provider();
      identity = new openmlsWasm.Identity(provider, userLabel);

      // Save both provider storage and identity public key
      const publicKey = identity.public_key();
      await saveIdentityPublicKey(userLabel, publicKey);
      await persistProviderStorage(provider, userLabel);
    }

    providerCache.set(userLabel, provider);
    identityCache.set(userLabel, identity);
  }
  return { provider, identity };
}

export async function getUserKeyPackage(userLabel = 'me') {
  let keyPackage, publicKey = false;

  const { provider, identity } = await prepareProviderIdentity(userLabel);

  let state = await loadUserState(userLabel);

  if (state.keyPackage) {
    let publishedDate = state.publishedDate;
    let keyPackageHex = state.keyPackage;
    return { provider, identity, keyPackageHex, publishedDate }
    // console.log('[OpenMLS] Loading stored KeyPackage:', keyPackageHex)
    // let bytes = bytesFromInput(keyPackageHex)
    // console.log('[OpenMLS] Loading stored KeyPackage:', bytes)
    // try {
    //   const openmlsWasm = await initOpenMLS();
    //   keyPackage = openmlsWasm.KeyPackage.from_bytes(bytes);
    //   console.log('[OpenMLS] Loading stored KeyPackage:', keyPackage)
    //   publicKey = extractPublicKey(keyPackage);
    //   return { provider, identity, keyPackage, keyPackageHex, publicKey };
    // } catch (e) {
    //   console.warn('[OpenMLS] Failed to restore KeyPackage from storage:', e);
    // }
  } else {
    console.log('[OpenMLS] No stored KeyPackage found for userLabel:', userLabel);
  }
  return {
    provider, identity, publishedDate: null
  };
}


export async function getOrCreateUserKeyPackage(userLabel = 'me') {
  // Try to load existing
  const loaded = await getUserKeyPackage(userLabel);
  if (loaded && loaded.keyPackage) {
    return { ...loaded, newlyCreated: false };
  }
  // If not found, create new
  createUserKeyPackage(userLabel, loaded.provider, loaded.identity)
}


export async function createUserKeyPackage(userLabel = 'me', provider = null, identity = null) {
  let keyPackage, publicKey;
  if (!provider || !identity) {
    const prepared = await prepareProviderIdentity(userLabel);
    provider = prepared.provider;
    identity = prepared.identity;
  }

  keyPackage = identity.key_package(provider);
  const keyPackageHex = bytesToHex(keyPackage.to_bytes());
  await saveUserKeyPackageDraft(userLabel, keyPackageHex);
  // publicKey = extractPublicKey(keyPackage);
  await persistProviderStorage(provider, userLabel);
  return { provider, identity, keyPackage, keyPackageHex, publicKey, newlyCreated: true };
}

// Manually clear an invalid KeyPackage for a user (call from console or app for recovery)
export async function clearUserKeyPackage(userId) {
  // Remove only the keyPackage and publishedDate fields, keep providerStorage
  const state = await loadState('users', userId);
  if (state) {
    const { providerStorage } = state;
    await saveState('users', userId, { providerStorage });
    console.log(`[KeyPackage] Cleared KeyPackage and publishedDate for user: ${userId}`);
  } else {
    console.log(`[KeyPackage] No user state found for: ${userId}`);
  }
}

// // Ensure provider has fresh key packages available
// export async function ensureKeyPackagesAvailable(userLabel = 'me') {
//   const openmlsWasm = await initOpenMLS();
//   let provider = providerCache.get(userLabel);
//   let identity = identityCache.get(userLabel);

//   if (!provider || !identity) {
//     // Initialize if not cached
//     const result = await getUserKeyPackage(userLabel);
//     provider = result.provider;
//     identity = result.identity;
//   }

//   // IMPORTANT: Load the stored key package and add it back to the provider
//   // This ensures the provider can process Welcome messages that reference it
//   const storedKeyPackageHex = await loadUserKeyPackage(userLabel);
//   if (storedKeyPackageHex) {
//     try {
//       const storedKeyPackage = openmlsWasm.KeyPackage.from_bytes(hexToBytes(storedKeyPackageHex));
//       // The key package is already in the provider from when identity.key_package() was called
//       // But we'll generate fresh ones to ensure we have enough
//       console.log('[KeyPackage] Loaded stored key package, hex length:', storedKeyPackageHex.length);
//     } catch (e) {
//       console.warn('[KeyPackage] Failed to load stored key package:', e.message);
//     }
//   }

//   // Generate additional key packages for the provider (operations like RatchetTree.from_bytes consume them)
//   for (let i = 0; i < 20; i++) {
//     try {
//       identity.key_package(provider);
//     } catch (e) {
//       console.warn('Failed to generate additional key package:', e.message);
//       break;
//     }
//   }
// }

