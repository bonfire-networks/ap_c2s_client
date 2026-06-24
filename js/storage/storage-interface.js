/**
 * @file Storage interface contract for the E2EE chat application.
 *
 * Any storage backend (IndexedDB, SQLite, etc.) should implement
 * all exported functions with the same signatures.
 *
 * This file is JSDoc-only — no implementation. See indexeddb-storage.js
 * for the default implementation.
 */

// ──────────────────────────────────────────────
// Group metadata (app-level, not MLS internal state)
// ──────────────────────────────────────────────

/**
 * Save group metadata (members, ratchetTree, welcome, joined, etc.)
 * Preserves top-level fields (name, apId) that live outside `state`.
 * @param {string} id - MLS group ID
 * @param {object} data - metadata to store under `state`
 */
// saveGroupMeta(id, data)

/**
 * Load group metadata.
 * @param {string} id - MLS group ID
 * @returns {object|null} stored metadata, or null if not found
 */
// loadGroupMeta(id)

/**
 * Delete group metadata.
 * @param {string} id - MLS group ID
 */
// deleteGroupMeta(id)

/**
 * Set a top-level field on a group record (e.g. name, apId).
 * @param {string} id - MLS group ID
 * @param {string} field - field name
 * @param {*} value - field value
 */
// setGroupField(id, field, value)

/**
 * Look up a group by a top-level field value (e.g. find group by apId).
 * @param {string} field - field name to search
 * @param {*} value - value to match
 * @returns {string|null} group ID, or null if not found
 */
// getGroupByField(field, value)

/**
 * List all groups with their last message (for sidebar display).
 * @returns {Array<{groupId, groupState, name, apId, lastMessage}>}
 */
// listGroupsWithLastMessage()

// ──────────────────────────────────────────────
// Messages (stored decrypted)
// ──────────────────────────────────────────────

/**
 * Save a decrypted message.
 * @param {string} groupId
 * @param {object} content - decrypted message content
 * @param {string} [id] - message ID (auto-generated if omitted)
 * @param {boolean} [isLocal=false] - true if sent by current user
 * @returns {string} message ID
 */
// saveMessage(groupId, content, id, isLocal)

/**
 * List all messages in a group, sorted by timestamp.
 * @param {string} groupId
 * @returns {Array<{id, groupId, isLocal, content, timestamp}>}
 */
// listMessages(groupId)

/**
 * Find the most recent message that is NOT one of the excluded types.
 * @param {string} groupId
 * @param {string[]} excludedTypes - e.g. ['GroupInfo', 'Welcome']
 * @returns {object|null}
 */
// findLastMessageExcludingTypes(groupId, excludedTypes)

/**
 * Delete a message by ID.
 * @param {string} id
 */
// deleteMessage(id)

/**
 * Update a message's content fields (for edits). Sets editedAt timestamp.
 * @param {string} id
 * @param {Object} updatedFields - fields to merge into existing content
 */
// updateMessage(id, updatedFields)

/**
 * Tombstone a message: wipe content but preserve record for reply threading.
 * Keeps type:'Tombstone', id, inReplyTo, attributedTo. Sets deletedAt timestamp.
 * @param {string} id
 */
// tombstoneMessage(id)

// ──────────────────────────────────────────────
// MLS backend state (opaque bytes)
// ──────────────────────────────────────────────

/**
 * Save opaque MLS backend state for a user.
 * Only the backend implementation understands these bytes.
 * @param {string} userId - actor ID
 * @param {Uint8Array|Array} bytes - exported backend state
 */
// saveBackendState(userId, bytes)

/**
 * Load opaque MLS backend state for a user.
 * @param {string} userId - actor ID
 * @returns {Uint8Array|null}
 */
// loadBackendState(userId)

// ──────────────────────────────────────────────
// User / key package state
// ──────────────────────────────────────────────

/**
 * Save a single field in the user state (e.g. keyPackage, identityPublicKey).
 * Merges with existing state — does not overwrite other fields.
 * @param {string} userId - actor ID
 * @param {string} field - field name
 * @param {*} value
 */
// saveUserField(userId, field, value)

/**
 * Load full user state.
 * @param {string} userId
 * @returns {object|null}
 */
// loadUserState(userId)

/**
 * Clear key package and published date, but keep backend state.
 * @param {string} userId
 */
// clearUserKeyData(userId)

// ──────────────────────────────────────────────
// MLS known signature keys cache
// ──────────────────────────────────────────────

/**
 * Cache an MLS signature key for an actor. Returns the derived mlsSignerKeyId.
 * Idempotent — safe to call multiple times with the same key.
 * @param {string} actorId
 * @param {string} sigKeyB64 - base64-encoded MLS SignaturePublicKey
 * @returns {Promise<string>} keyId (mlsSignerKeyId)
 */
// saveMlsKnownKey(actorId, sigKeyB64)

/**
 * Look up a cached MLS signature key by its derived ID (mlsSignerKeyId).
 * @param {string} keyId
 * @returns {Promise<string|null>} base64-encoded SignaturePublicKey, or null
 */
// getMlsKnownKey(keyId)

// ──────────────────────────────────────────────
// Activity deduplication
// ──────────────────────────────────────────────

/**
 * Mark an activity as processed (to avoid reprocessing inbox items).
 * @param {string} actorId
 * @param {string} activityId
 */
// markProcessed(actorId, activityId)

/**
 * Check if an activity was already processed.
 * @param {string} actorId
 * @param {string} activityId
 * @returns {boolean}
 */
// isProcessed(actorId, activityId)

// ──────────────────────────────────────────────
// Bulk operations
// ──────────────────────────────────────────────

/**
 * Clear all data (groups, messages, processedActivityIds).
 * Does NOT clear user/backend state.
 */
// clearAll()
