/**
 * OpenMLS WASM implementation of the MLS backend interface.
 * See ../mls-backend.js for the interface contract.
 *
 * This file contains ALL direct OpenMLS WASM calls. Swap this file
 * to change the MLS implementation (e.g., Tauri native Rust).
 *
 * All internal concepts (Provider, Identity, Group, KeyPackage, RatchetTree,
 * AddMessages) are hidden behind this module. Callers only deal with
 * userId strings, groupId strings, and byte arrays.
 */

import { loadWasm } from './openmls-wasm.js';
import { bytesToBase64, base64ToBytes } from '../../utils.js';

// ── Internal caches (hidden from callers) ──────────────────

const providerCache = new Map();   // userId → WASM Provider
const identityCache = new Map();   // userId → WASM Identity
const pubKeyCache = new Map();     // userId → Uint8Array (identity public key, for re-export)
const groupCache = new Map();      // groupId → WASM Group

// ── Internal helpers ───────────────────────────────────────

/**
 * Pack provider storage + identity public key into a single opaque blob.
 * Format: JSON { v:1, ps: base64, ipk: base64|null } encoded as UTF-8.
 */
function packState(providerBytes, identityPublicKey) {
  return new TextEncoder().encode(JSON.stringify({
    v: 1,
    ps: bytesToBase64(new Uint8Array(providerBytes)),
    ipk: identityPublicKey ? bytesToBase64(new Uint8Array(identityPublicKey)) : null
  }));
}

/**
 * Unpack a state blob. Handles both new packed format and legacy raw
 * provider bytes (for backward compatibility with existing IndexedDB data).
 */
function unpackState(savedState) {
  try {
    const json = new TextDecoder().decode(savedState);
    const obj = JSON.parse(json);
    if (obj && obj.v === 1) {
      return {
        providerStorage: base64ToBytes(obj.ps),
        identityPublicKey: obj.ipk ? base64ToBytes(obj.ipk) : null
      };
    }
  } catch {
    // Not JSON — legacy format: raw provider storage bytes
  }
  return { providerStorage: savedState, identityPublicKey: null };
}

function requireUser(userId) {
  const provider = providerCache.get(userId);
  const identity = identityCache.get(userId);
  if (!provider || !identity) throw new Error(`User not initialized: ${userId}`);
  return { provider, identity };
}

function requireGroup(groupId) {
  const group = groupCache.get(groupId);
  if (!group) throw new Error(`Group not loaded: ${groupId}`);
  return group;
}

// ── Lifecycle ──────────────────────────────────────────────

export async function init() {
  await loadWasm();
}

/**
 * Initialize a user's internal state (provider, identity, credentials).
 *
 * @param {string} userId - actor ID
 * @param {Uint8Array|null} savedState - previously exported via exportState(), or null
 * @param {object} [options] - optional migration helpers
 * @param {Uint8Array|null} [options.identityPublicKey] - legacy identity public key
 *   (only needed for migrating from old storage format where it was stored separately)
 */
export async function initUser(userId, savedState, options = {}) {
  if (providerCache.has(userId) && identityCache.has(userId)) {
    return; // Already initialized in this session
  }

  const wasm = await loadWasm();
  let provider, identity;

  if (savedState && savedState.length) {
    const { providerStorage, identityPublicKey: packedPubKey } = unpackState(savedState);

    // Use packed public key, or fall back to migration option
    const identityPublicKey = packedPubKey || (options.identityPublicKey ?? null);

    provider = wasm.Provider.new_from_storage(providerStorage);

    if (identityPublicKey && identityPublicKey.length) {
      try {
        identity = wasm.Identity.from_provider(provider, userId, identityPublicKey);
        console.log('[OpenMLS Backend] Restored identity from provider storage');
      } catch (e) {
        console.warn('[OpenMLS Backend] Failed to restore identity, creating new:', e);
        identity = new wasm.Identity(provider, userId);
      }
    } else {
      console.log('[OpenMLS Backend] No identity public key, creating new identity');
      identity = new wasm.Identity(provider, userId);
    }
  } else {
    // First time — create fresh provider and identity
    console.log('[OpenMLS Backend] First-time setup for:', userId);
    provider = new wasm.Provider();
    identity = new wasm.Identity(provider, userId);
  }

  pubKeyCache.set(userId, identity.public_key());
  providerCache.set(userId, provider);
  identityCache.set(userId, identity);
}

// ── State persistence ──────────────────────────────────────

export async function exportState(userId) {
  const provider = providerCache.get(userId);
  if (!provider) return null;

  try {
    const exported = provider.export_storage();
    if (!exported || !exported.length) {
      console.error('[OpenMLS Backend] No provider storage to export');
      return null;
    }
    return packState(exported, pubKeyCache.get(userId));
  } catch (e) {
    console.error('[OpenMLS Backend] Failed to export state:', e);
    return null;
  }
}

// ── Groups ─────────────────────────────────────────────────

export async function createGroup(userId, groupId) {
  const wasm = await loadWasm();
  const { provider, identity } = requireUser(userId);

  if (groupCache.has(groupId)) {
    const existing = groupCache.get(groupId);
    return { ratchetTree: new Uint8Array(existing.export_ratchet_tree().to_bytes()) };
  }

  const group = wasm.Group.create_new(provider, identity, groupId);
  groupCache.set(groupId, group);

  return { ratchetTree: new Uint8Array(group.export_ratchet_tree().to_bytes()) };
}

export async function loadGroup(userId, groupId) {
  if (groupCache.has(groupId)) return true;

  const wasm = await loadWasm();
  const provider = providerCache.get(userId);
  if (!provider) return false;

  const groupIdBytes = new TextEncoder().encode(groupId);
  const group = await wasm.Group.load(provider, groupIdBytes);
  if (group) {
    groupCache.set(groupId, group);
    return true;
  }
  return false;
}

export async function joinGroup(userId, groupId, welcomeBytes, ratchetTreeBytes) {
  const wasm = await loadWasm();
  const { provider } = requireUser(userId);

  if (groupCache.has(groupId)) {
    console.log('[OpenMLS Backend] Group already joined:', groupId);
    return;
  }

  const ratchetTree = wasm.RatchetTree.from_bytes(ratchetTreeBytes);
  const group = wasm.Group.join(provider, welcomeBytes, ratchetTree);
  groupCache.set(groupId, group);
  console.log('[OpenMLS Backend] Joined group:', groupId);
}

export async function encrypt(userId, groupId, plaintext) {
  const { provider, identity } = requireUser(userId);
  const group = requireGroup(groupId);

  const msg = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  const encoded = new TextEncoder().encode(msg);

  const ciphertext = group.create_message(provider, identity, encoded);
  return new Uint8Array(ciphertext);
}

export async function decrypt(userId, groupId, ciphertext) {
  const { provider } = requireUser(userId);
  const group = requireGroup(groupId);

  let plaintext;
  try {
    plaintext = group.process_message(provider, ciphertext);
  } catch (error) {
    console.log('[OpenMLS Backend] Decryption failed:', error);
    return null;
  }

  const decoded = new TextDecoder().decode(plaintext);
  try {
    return JSON.parse(decoded);
  } catch {
    return decoded;
  }
}

export async function addMember(userId, groupId, keyPackageBytes) {
  const wasm = await loadWasm();
  const { provider, identity } = requireUser(userId);
  const group = requireGroup(groupId);

  const newMemberKp = wasm.KeyPackage.from_bytes(keyPackageBytes);
  const addMessages = group.propose_and_commit_add(provider, identity, newMemberKp);
  if (!(addMessages instanceof wasm.AddMessages)) {
    throw new Error('Failed to add member: no AddMessages returned');
  }

  // Apply the pending commit to advance local state
  group.merge_pending_commit(provider);

  return {
    welcome: new Uint8Array(addMessages.welcome),
    ratchetTree: new Uint8Array(group.export_ratchet_tree().to_bytes())
  };
}

export async function exportRatchetTree(userId, groupId) {
  requireUser(userId);
  const group = requireGroup(groupId);
  return new Uint8Array(group.export_ratchet_tree().to_bytes());
}

// ── Key packages ───────────────────────────────────────────

export async function createKeyPackage(userId) {
  const { provider, identity } = requireUser(userId);
  const keyPackage = identity.key_package(provider);
  return { keyPackageBytes: new Uint8Array(keyPackage.to_bytes()) };
}
