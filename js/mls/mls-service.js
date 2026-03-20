/**
 * Generic MLS service layer — backend-agnostic.
 *
 * Coordinates MLS backend operations with storage persistence.
 * Does NOT import any OpenMLS-specific code.
 *
 * Dependencies are injected via constructor:
 *   - backend: implements mls-backend.js interface
 *   - storage: implements storage/storage-interface.js
 */

import { bytesToHex } from '../utils.js';

export class MLSService {
  /**
   * @param {object} backend - MLS backend (e.g., openmls-backend)
   * @param {object} storage - storage implementation (e.g., indexeddb-storage)
   */
  constructor(backend, storage) {
    this.backend = backend;
    this.storage = storage;
  }

  // ── Initialization ─────────────────────────────────────

  /**
   * Initialize the backend and restore user state from storage.
   */
  async init(userId) {
    await this.backend.init();

    const savedState = await this.storage.loadBackendState(userId);
    await this.backend.initUser(userId, savedState);

    await this.persistBackendState(userId);
  }

  // ── State persistence ──────────────────────────────────

  /**
   * Export backend state and save to storage.
   * Called after any operation that modifies MLS state.
   */
  async persistBackendState(userId) {
    const exported = await this.backend.exportState(userId);
    if (exported) {
      await this.storage.saveBackendState(userId, exported);
    }
  }

  // ── Groups ─────────────────────────────────────────────

  /**
   * Delete an MLS group from the backend (cache + storage).
   * Does not touch IndexedDB metadata — caller manages that.
   *
   * @param {string} userId - actor ID
   * @param {string} groupId - group identifier
   */
  async deleteGroup(userId, groupId) {
    if (this.backend.deleteGroup) {
      await this.backend.deleteGroup(userId, groupId);
      await this.persistBackendState(userId);
    }
  }

  /**
   * Create a new MLS group.
   * Saves group metadata and persists backend state.
   *
   * @param {string} userId - actor ID of the creator
   * @param {string} groupId - unique group identifier
   * @param {object} [metadata] - initial group metadata (members, name, etc.)
   * @returns {{ ratchetTree: Uint8Array }}
   */
  async createGroup(userId, groupId, metadata = {}) {
    const { ratchetTree } = await this.backend.createGroup(userId, groupId);

    // Save group metadata with ratchet tree
    await this.storage.saveGroupMeta(groupId, {
      ...metadata,
      ratchetTree: Array.from(ratchetTree)
    });

    await this.persistBackendState(userId);
    return { ratchetTree };
  }

  /**
   * Get (load) an existing group. Tries backend internal state first.
   *
   * @param {string} userId - actor ID
   * @param {string} groupId - group identifier
   * @returns {{ found: boolean, members: string[] }}
   *   found=false means MLS state is lost; caller should offer resetGroup.
   */
  async getGroup(userId, groupId) {
    const loaded = await this.backend.loadGroup(userId, groupId);
    if (loaded) return { found: true, members: [] };

    const state = await this.storage.loadGroupMeta(groupId);
    const members = state?.members || [];
    return { found: false, members };
  }

  /**
   * Join a group from received Welcome and RatchetTree.
   *
   * @param {string} userId - actor ID
   * @param {string} groupId - group identifier
   * @param {Uint8Array} welcomeBytes - Welcome message
   * @param {Uint8Array} ratchetTreeBytes - RatchetTree bytes
   * @param {object} [metadata] - additional metadata to save (members, etc.)
   */
  async joinFromWelcome(userId, groupId, welcomeBytes, ratchetTreeBytes) {
    // Backend returns the actual MLS group_id (sender's ULID) from the Welcome
    const actualGroupId = await this.backend.joinGroup(userId, groupId, welcomeBytes, ratchetTreeBytes);
    await this.persistBackendState(userId);
    // Return the canonical group ID — caller manages metadata migration
    return actualGroupId || groupId;
  }

  /**
   * Encrypt a plaintext message for a group.
   * Persists backend state after encryption (ratchet advances).
   *
   * @param {string} userId - actor ID
   * @param {string} groupId - group identifier
   * @param {string} plaintext - message to encrypt
   * @returns {Uint8Array} ciphertext
   */
  async encrypt(userId, groupId, plaintext) {
    const ciphertext = await this.backend.encrypt(userId, groupId, plaintext);

    // Persist backend state + update group metadata (ratchet tree)
    await this._persistAfterGroupOp(userId, groupId);

    return ciphertext;
  }

  /**
   * Decrypt a ciphertext message from a group.
   * Persists backend state after decryption (ratchet advances).
   *
   * @param {string} userId - actor ID
   * @param {string} groupId - group identifier
   * @param {Uint8Array} ciphertext - encrypted message
   * @returns {string|object|null} decrypted content
   */
  async decrypt(userId, groupId, ciphertext) {
    const result = await this.backend.decrypt(userId, groupId, ciphertext);

    // Persist backend state + update group metadata (ratchet tree)
    await this._persistAfterGroupOp(userId, groupId);

    return result;
  }

  /**
   * Add a member to a group using their KeyPackage bytes.
   * Persists backend state and saves updated group metadata.
   *
   * @param {string} userId - actor ID of the adder
   * @param {string} groupId - group identifier
   * @param {Uint8Array} keyPackageBytes - new member's key package
   * @returns {{ welcome: Uint8Array, ratchetTree: Uint8Array, commit: string }}
   */
  async addMember(userId, groupId, keyPackageBytes) {
    const { welcome, ratchetTree, commit } = await this.backend.addMember(userId, groupId, keyPackageBytes);

    // Save updated group metadata with new ratchet tree and welcome
    const existingState = (await this.storage.loadGroupMeta(groupId)) || {};
    await this.storage.saveGroupMeta(groupId, {
      ...existingState,
      ratchetTree: Array.from(ratchetTree),
      welcome: Array.from(welcome)
    });

    await this.persistBackendState(userId);
    return { welcome, ratchetTree, commit };
  }

  // ── Key packages ───────────────────────────────────────

  /**
   * Get existing key package hex from storage, or null.
   */
  async getKeyPackageHex(userId) {
    const state = await this.storage.loadUserState(userId);
    return state?.keyPackage ?? null;
  }

  /**
   * Get existing key package info (hex + publishedDate).
   */
  async getKeyPackageInfo(userId) {
    const state = await this.storage.loadUserState(userId);
    if (state?.keyPackage) {
      return {
        keyPackageHex: state.keyPackage,
        publishedDate: state.publishedDate ?? null
      };
    }
    return { keyPackageHex: null, publishedDate: null };
  }

  /**
   * Create a new key package and save as draft in storage.
   *
   * @param {string} userId - actor ID
   * @returns {{ keyPackageHex: string }}
   */
  async createKeyPackage(userId) {
    const { keyPackageBytes } = await this.backend.createKeyPackage(userId);
    const keyPackageHex = bytesToHex(keyPackageBytes);

    await this.storage.saveUserField(userId, 'keyPackage', keyPackageHex);
    await this.persistBackendState(userId);

    return { keyPackageHex };
  }

  /**
   * Mark a key package as published (set published date).
   */
  async markKeyPackagePublished(userId, keyPackageHex) {
    await this.storage.saveUserField(userId, 'keyPackage', keyPackageHex);
    await this.storage.saveUserField(userId, 'publishedDate', Date.now());
  }

  /**
   * Clear key package and published date, keeping backend state intact.
   */
  async clearKeyPackage(userId) {
    await this.storage.clearUserKeyData(userId);
  }

  // ── Member management ──────────────────────────────────

  /**
   * Remove one or more clients (by leaf index) from a group.
   * Returns { commit: base64 string } for distribution to remaining members.
   *
   * @param {string} userId - actor ID
   * @param {string} groupId - group identifier
   * @param {number[]} leafIndexes - leaf node indexes to remove
   * @returns {{ commit: string }}
   */
  async removeGroupMemberClient(userId, groupId, leafIndexes) {
    const result = await this.backend.removeGroupMemberClient(userId, groupId, leafIndexes);
    await this._persistAfterGroupOp(userId, groupId);
    return result;
  }

  /**
   * Remove all clients of a given actor from a group.
   * The backend resolves leaf indexes by matching member identity against memberId.
   *
   * @param {string} userId - actor ID of the caller
   * @param {string} groupId - group identifier
   * @param {string} memberId - actor URI of the member to remove
   * @returns {{ commit: string, removedCount: number }}
   */
  async removeGroupMember(userId, groupId, memberId) {
    const result = await this.backend.removeGroupMember(userId, groupId, memberId);
    await this._persistAfterGroupOp(userId, groupId);
    return result;
  }

  /**
   * Get emoji fingerprints for all members in a group.
   * Returns [{identity, fingerprint, isOwn, index, signatureKey, isCurrentClient}]
   *
   * @param {string} userId - actor ID
   * @param {string} groupId - group identifier
   * @returns {Array<{identity: string, fingerprint: Array<{emoji: string, description: string}>, isOwn: boolean, index: number, signatureKey: string, isCurrentClient: boolean}>}
   */
  async decommissionClient(userId, signatureKey) {
    return await this.backend.decommissionClient(userId, signatureKey);
  }

  async clearAllData(userId) {
    return await this.backend.clearAllData(userId);
  }

  async getGroupMemberIdentities(groupId) {
    return await this.backend.getGroupMemberIdentities(groupId);
  }

  async getGroupFingerprints(userId, groupId) {
    return await this.backend.getGroupFingerprints(userId, groupId);
  }

  async getOwnFingerprint(userId) {
    if (!this.backend.getOwnFingerprint) return null;
    return await this.backend.getOwnFingerprint(userId);
  }

  /**
   * Extract the emoji fingerprint from a key package (no group/user needed).
   * Returns {fingerprint: [{emoji, description}], signatureKey} or null.
   *
   * @param {string} keyPackageB64 - base64-encoded MLS key package
   */
  async getKeyPackageFingerprint(keyPackageB64) {
    if (!this.backend.getKeyPackageFingerprint) return null;
    return await this.backend.getKeyPackageFingerprint(keyPackageB64);
  }

  // ── Group ID extraction ──────────────────────────────────

  /**
   * Extract the MLS group_id from a ciphertext blob without decrypting.
   * Returns null for Welcome messages (group_id is encrypted inside).
   *
   * @param {Uint8Array} messageBytes - MLS ciphertext
   * @returns {string|null} group_id string, or null
   */
  async extractGroupId(messageBytes) {
    if (this.backend.extractGroupId) {
      return this.backend.extractGroupId(messageBytes);
    }
    return null;
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * After a group operation (encrypt/decrypt), persist both backend state
   * and update the group's ratchet tree in metadata.
   */
  async _persistAfterGroupOp(userId, groupId) {
    try {
      const ratchetTree = await this.backend.exportRatchetTree(userId, groupId);
      const existingState = (await this.storage.loadGroupMeta(groupId)) || {};
      await this.storage.saveGroupMeta(groupId, {
        ...existingState,
        ratchetTree: Array.from(ratchetTree)
      });
    } catch (e) {
      console.error('[MLSService] Failed to update ratchet tree metadata:', e);
    }
    await this.persistBackendState(userId);
  }
}
