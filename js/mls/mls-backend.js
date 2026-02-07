/**
 * @file MLS Backend interface contract.
 *
 * Any MLS backend (OpenMLS WASM, Tauri native Rust, etc.) should implement
 * all methods described here with the same signatures.
 *
 * The backend manages ALL its own internal state (providers, identities,
 * credentials, signing keys, group instances). Callers only deal with
 * userId strings, groupId strings, and byte arrays.
 *
 * This file is JSDoc-only — no implementation. See openmls/openmls-backend.js
 * for the default (OpenMLS WASM) implementation.
 */

// ──────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────

/**
 * Initialize the backend runtime (e.g. load WASM module).
 * Must be called before any other method.
 */
// async init()

/**
 * Initialize a user's internal state (provider, identity, credentials).
 *
 * If `savedState` is provided (previously exported via `exportState()`),
 * restores the user from that opaque blob. Otherwise creates a fresh user.
 *
 * @param {string} userId - actor ID (full URL)
 * @param {Uint8Array|null} savedState - previously exported state, or null for new user
 */
// async initUser(userId, savedState)

// ──────────────────────────────────────────────
// State persistence
// ──────────────────────────────────────────────

/**
 * Export all internal state for a user as opaque bytes.
 *
 * The service layer saves these bytes to storage via `saveBackendState()`.
 * Returns null if the backend handles its own persistence (e.g. Tauri with
 * Rust-side storage).
 *
 * @param {string} userId - actor ID
 * @returns {Uint8Array|null} opaque state bytes, or null if self-persisting
 */
// async exportState(userId)

// ──────────────────────────────────────────────
// Groups
// ──────────────────────────────────────────────

/**
 * Create a new MLS group (for group creators only).
 *
 * @param {string} userId - actor ID of the creator
 * @param {string} groupId - unique group identifier
 * @returns {{ ratchetTree: Uint8Array }}
 */
// async createGroup(userId, groupId)

/**
 * Attempt to load a group from the backend's internal state.
 *
 * Returns true if the group was found and loaded, false otherwise.
 * After a successful load, the group is available for encrypt/decrypt/etc.
 *
 * @param {string} userId - actor ID
 * @param {string} groupId - group identifier
 * @returns {boolean} true if group was loaded successfully
 */
// async loadGroup(userId, groupId)

/**
 * Join an existing group using received Welcome and RatchetTree bytes.
 *
 * This consumes the user's current KeyPackage — a new one must be created
 * afterward if more joins are expected.
 *
 * @param {string} userId - actor ID
 * @param {string} groupId - group identifier (known from the AP activity)
 * @param {Uint8Array} welcomeBytes - Welcome message from the group creator/adder
 * @param {Uint8Array} ratchetTreeBytes - RatchetTree from the group
 */
// async joinGroup(userId, groupId, welcomeBytes, ratchetTreeBytes)

/**
 * Encrypt a plaintext message for the group.
 *
 * Advances the sender's ratchet state.
 *
 * @param {string} userId - actor ID of the sender
 * @param {string} groupId - group identifier
 * @param {string} plaintext - message to encrypt (string or JSON-stringified)
 * @returns {Uint8Array} ciphertext
 */
// async encrypt(userId, groupId, plaintext)

/**
 * Decrypt a ciphertext message from the group.
 *
 * Advances the receiver's ratchet state.
 *
 * @param {string} userId - actor ID of the receiver
 * @param {string} groupId - group identifier
 * @param {Uint8Array} ciphertext - encrypted message bytes
 * @returns {string|object|null} decrypted plaintext (parsed JSON if valid, else string), or null on failure
 */
// async decrypt(userId, groupId, ciphertext)

/**
 * Add a member to the group using their KeyPackage bytes.
 *
 * Internally proposes, commits, and merges the add operation.
 * Advances the group's epoch.
 *
 * @param {string} userId - actor ID of the adder
 * @param {string} groupId - group identifier
 * @param {Uint8Array} keyPackageBytes - new member's key package
 * @returns {{ welcome: Uint8Array, ratchetTree: Uint8Array }}
 */
// async addMember(userId, groupId, keyPackageBytes)

/**
 * Export the group's current ratchet tree as bytes.
 *
 * @param {string} userId - actor ID
 * @param {string} groupId - group identifier
 * @returns {Uint8Array}
 */
// async exportRatchetTree(userId, groupId)

// ──────────────────────────────────────────────
// Key packages
// ──────────────────────────────────────────────

/**
 * Create a new KeyPackage for publishing.
 *
 * Internally manages signing keys, credentials, etc.
 * The returned bytes can be published to the user's ActivityPub profile
 * for other users to fetch when adding this user to a group.
 *
 * @param {string} userId - actor ID
 * @returns {{ keyPackageBytes: Uint8Array }}
 */
// async createKeyPackage(userId)
