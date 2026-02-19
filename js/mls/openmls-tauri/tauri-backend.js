/**
 * Tauri native Rust implementation of the MLS backend interface.
 * See ../mls-backend.js for the interface contract.
 *
 * Each method calls `invoke('plugin:openmls|command')` to delegate
 * to the tauri_openmls Rust plugin. Binary data crosses the bridge
 * as base64 strings.
 */

import { base64ToUint8, uint8ToBase64 } from '../../utils.js';

const invoke = window.__TAURI__.core.invoke;


// ── Lifecycle ──────────────────────────────────────────────────────

export async function init() {
  // No WASM to load — Rust plugin is ready at app startup
  return true;
}

export async function initUser(userId, savedState, _options = {}) {
  console.log(`[MLS Tauri Backend] initUser call for userId: ${userId}, savedState: ${savedState ? '[data]' : null}`);
  await invoke('plugin:openmls|init_user', {
    userId,
    savedState: null // SQLite self-persists
  });
}

// ── State persistence ──────────────────────────────────────────────

export async function exportState(_userId) {
  return null; // SQLite self-persists
}

// ── Groups ─────────────────────────────────────────────────────────

export async function createGroup(userId, groupId) {
  const result = await invoke('plugin:openmls|create_group', { userId, groupId });
  return { ratchetTree: base64ToUint8(result.ratchetTree) };
}

export async function loadGroup(userId, groupId) {
  return await invoke('plugin:openmls|load_group', { userId, groupId });
}

export async function deleteGroup(userId, groupId) {
  await invoke('plugin:openmls|delete_group', { userId, groupId });
}

export async function joinGroup(userId, groupId, welcomeBytes, ratchetTreeBytes) {
  const result = await invoke('plugin:openmls|join_group', {
    userId,
    groupId,
    welcomeB64: uint8ToBase64(welcomeBytes),
    ratchetTreeB64: uint8ToBase64(ratchetTreeBytes),
  });
  // Return the actual MLS group_id (sender's ULID) from the Welcome
  return result.groupId;
}

export async function encrypt(userId, groupId, plaintext) {
  const msg = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  const b64 = await invoke('plugin:openmls|encrypt', { userId, groupId, plaintext: msg });
  return base64ToUint8(b64);
}

export async function decrypt(userId, groupId, ciphertext) {
  const b64 = uint8ToBase64(ciphertext);
  const result = await invoke('plugin:openmls|decrypt', { userId, groupId, ciphertextB64: b64 });

  if (result === null) return null;

  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

export async function addMember(userId, groupId, keyPackageBytes) {
  const result = await invoke('plugin:openmls|add_member', {
    userId,
    groupId,
    keyPackageB64: uint8ToBase64(keyPackageBytes),
  });
  return {
    welcome: base64ToUint8(result.welcome),
    ratchetTree: base64ToUint8(result.ratchetTree),
  };
}

export async function exportRatchetTree(userId, groupId) {
  const b64 = await invoke('plugin:openmls|export_ratchet_tree', { userId, groupId });
  return base64ToUint8(b64);
}

// ── Key packages ───────────────────────────────────────────────────

export async function createKeyPackage(userId) {
  const result = await invoke('plugin:openmls|create_key_package', { userId });
  return { keyPackageBytes: base64ToUint8(result.keyPackageBytes) };
}

// ── Fingerprints ────────────────────────────────────────────────────

/**
 * Get emoji fingerprints for all members in a group.
 * Returns [{identity, fingerprint: [{emoji, description}], isOwn}]
 */
export async function getGroupFingerprints(userId, groupId) {
  return await invoke('plugin:openmls|get_group_fingerprints', { userId, groupId });
}

// ── Group ID extraction ─────────────────────────────────────────────

/**
 * Extract the MLS group_id from a ciphertext blob without decrypting.
 * Returns null for Welcome messages (group_id is encrypted inside).
 */
export async function extractGroupId(messageBytes) {
  return await invoke('plugin:openmls|extract_group_id', {
    messageB64: uint8ToBase64(messageBytes),
  });
}
