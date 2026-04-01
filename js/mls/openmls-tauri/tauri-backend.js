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

/** Encrypt plaintext. Returns a pendingId string — ciphertext stays in Rust. */
export async function encrypt(userId, groupId, plaintext, attachmentIds = []) {
  const msg = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  return invoke('plugin:openmls|encrypt', {
    userId, groupId, plaintext: msg,
    attachmentIds: attachmentIds.length ? attachmentIds : null,
  });  // returns "__prepared_encrypted_msg:UUID__" string
}

/**
 * Send a pending encrypted message. JS passes the full AP body JSON (with pendingId as
 * the `content` value); Rust substitutes the real ciphertext and POSTs to outboxUrl.
 */
export async function sendMessage(pendingId, outboxUrl, accessToken, body) {
  return invoke('plugin:openmls|send_message', {
    pendingId, outboxUrl, accessToken,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Discard a pending encrypted message (send failed, user cancelled). */
export async function discardMessage(pendingId) {
  return invoke('plugin:openmls|discard_message', { pendingId });
}

/**
 * Decompress a .gz attachment into the app-sandboxed tmp dir and return the path.
 * JS uses convertFileSrc(path) for inline display of images/video/audio/PDF.
 */
export async function serveAttachment(path) {
  return invoke('plugin:openmls|serve_attachment', { path });
}

/**
 * Show a native save dialog and move the decompressed file to the user-chosen destination.
 * For document attachments that should not be auto-opened.
 */
export async function saveAttachmentAs(tmpPath, suggestedName) {
  return invoke('plugin:openmls|save_attachment_as', { tmpPath, suggestedName });
}

// ── Attachments ─────────────────────────────────────────────────────

/** Send WebP bytes (images only) to Rust for gzip-compression and storage. */
export async function prepareAttachmentBytes(attachmentId, bytes) {
  await invoke('plugin:openmls|prepare_attachment_bytes', {
    attachmentId,
    bytes: Array.from(bytes),
  });
}

/** Tell Rust to read a non-image file from disk and gzip-compress it. */
export async function prepareAttachmentFile(attachmentId, path) {
  await invoke('plugin:openmls|prepare_attachment_file', { attachmentId, path });
}

/** Remove an attachment: clears pending state and/or deletes the .gz from disk.
 *  Pass `attachmentId` for pending attachments, `localPath` for already-sent ones, or both. */
export async function removeAttachment({ attachmentId = null, localPath = null } = {}) {
  await invoke('plugin:openmls|remove_attachment', { attachmentId, localPath });
}

/** Register callbacks for Rust-emitted attachment events. Returns unlisten functions. */
export async function onAttachmentReady(callback) {
  const { listen } = window.__TAURI__.event;
  return listen('attachment-ready', e => callback(e.payload));
}

export async function onAttachmentFailed(callback) {
  const { listen } = window.__TAURI__.event;
  return listen('attachment-failed', e => callback(e.payload));
}

export async function decrypt(userId, groupId, ciphertext) {
  const b64 = uint8ToBase64(ciphertext);
  const result = await invoke('plugin:openmls|decrypt', { userId, groupId, ciphertextB64: b64 });

  if (result === null) return null;

  // result is now { text, senderIdentity, senderSignatureKey }
  const { text, senderIdentity, senderSignatureKey } = result;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { content: parsed, senderIdentity, senderSignatureKey };
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
    commit: result.commit, // base64 string — passed through as-is to _distributeCommit
  };
}

export async function removeGroupMemberClient(userId, groupId, leafIndexes) {
  return await invoke('plugin:openmls|remove_group_member_client', {
    userId, groupId, leafIndexes,
  });
}

export async function removeGroupMember(userId, groupId, memberId) {
  return await invoke('plugin:openmls|remove_group_member', {
    userId, groupId, memberId,
  });
}

export async function getGroupMemberIdentities(groupId) {
  return await invoke('plugin:openmls|get_group_member_identities', { groupId });
}

export async function leaveGroup(userId, groupId) {
  return await invoke('plugin:openmls|remove_self_from_group', { userId, groupId });
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
 * Returns [{identity, fingerprint: [{emoji, description}], isOwn, index, signatureKey, isCurrentClient}]
 */
export async function getGroupFingerprints(userId, groupId) {
  return await invoke('plugin:openmls|get_group_fingerprints', { userId, groupId });
}

/**
 * Get the current client's emoji fingerprint (no group needed).
 * Returns {fingerprint: [{emoji, description}], signatureKey} or null.
 */
export async function getOwnFingerprint(userId) {
  return await invoke('plugin:openmls|get_own_fingerprint', { userId });
}

/**
 * Extract the emoji fingerprint from a key package (no group or user needed).
 * Returns {fingerprint: [{emoji, description}], signatureKey}.
 */
export async function getKeyPackageFingerprint(keyPackageB64) {
  return await invoke('plugin:openmls|get_key_package_fingerprint', { keyPackageB64 });
}

/**
 * Sign arbitrary data with the user's MLS SignaturePrivateKey.
 * @param {string} userId
 * @param {string} dataB64 - base64-encoded bytes to sign
 * @returns {{ signature: string, signerKey: string }} base64 values
 */
export async function signData(userId, dataB64) {
  return await invoke('plugin:openmls|sign_data', { userId, dataB64 });
}

/**
 * Verify an MLS signature produced by signData.
 * @param {string} signerKeyB64 - base64 SignaturePublicKey
 * @param {string} dataB64 - base64 signed payload
 * @param {string} signatureB64 - base64 signature
 * @returns {boolean}
 */
export async function verifySignature(signerKeyB64, dataB64, signatureB64) {
  return await invoke('plugin:openmls|verify_signature', { signerKeyB64, dataB64, signatureB64 });
}

/**
 * Decommission a client (by signature key) from all loaded groups.
 * Shows a native confirmation dialog, then removes from all groups.
 * Returns {results: [{groupId, commit}], cancelled: bool}
 */
export async function decommissionClient(userId, signatureKey) {
  return await invoke('plugin:openmls|decommission_client', { userId, signatureKey });
}

export async function clearAllData(userId) {
  return await invoke('plugin:openmls|clear_all_data', { userId });
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
