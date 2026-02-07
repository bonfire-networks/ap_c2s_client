// openmls.js
// Abstractions for OpenMLS group/session management using WASM
// Assumes openmls_wasm.js is loaded and available

// Example usage:
//   const group = await OpenMLS.createGroup('my-group-id', 'me');
//   const ciphertext = await group.encrypt('hello');
//   const plaintext = await group.decrypt(ciphertext);


import * as Storage from './openmlsStorage.js';
import { saveProviderStorage } from './openmlsStorage.js';
import { getUserKeyPackage, persistProviderStorage } from './openmlsUser.js';
import { bytesFromInput, arrayToUint8Array } from './openmlsUtils.js';

let openmlsWasm = null;
let Provider, Identity, Group, KeyPackage, RatchetTree, AddMessages;

// Cache group instances in memory for performance
// Updated automatically by save() to ensure cache stays in sync with storage
const groupCache = new Map();


export async function initOpenMLS() {
  if (!openmlsWasm) {
    openmlsWasm = await import('/assets/openmls/openmls_wasm.js');
    // Use named imports as in the demo
    if (openmlsWasm.default) {
      await openmlsWasm.default('/assets/openmls/openmls_wasm_bg.wasm');
    }
    Provider = openmlsWasm.Provider;
    Identity = openmlsWasm.Identity;
    Group = openmlsWasm.Group;
    KeyPackage = openmlsWasm.KeyPackage;
    RatchetTree = openmlsWasm.RatchetTree;
    AddMessages = openmlsWasm.AddMessages;
  }
  return openmlsWasm;
}

export class OpenMLS {
  constructor({ id, identity, group, provider, userLabel }) {
    this.id = id;
    this.identity = identity;
    this.group = group;
    this.userLabel = userLabel;
    this.provider = provider;
  }

  /**
   * Save group metadata to IndexedDB.
   *
   * Exports the group's ratchet tree and saves it along with any additional
   * metadata to the 'groups' table in IndexedDB. This is stored separately from
   * provider storage and is used for tracking per-group metadata like:
   * - ratchetTree: serialized ratchet tree bytes (for reference)
   * - members: list of actor IDs in the group
   * - name: user-defined group name
   * - apId: ActivityPub ID for the group/thread
   *
   * Note: The ratchet tree saved here is for reference only and cannot be used
   * to restore the group. Group restoration requires provider storage persistence.
   */
  static async persistGroupState(id, group, metadata = {}) {
    const state = { ...metadata };

    try {
      const ratchetTree = group.export_ratchet_tree();
      // export_ratchet_tree() returns a RatchetTree object, need to call to_bytes()
      const ratchetTreeBytes = ratchetTree.to_bytes();
      state.ratchetTree = Array.from(ratchetTreeBytes);
    } catch (e) {
      console.error('Failed to export ratchet tree:', e);
    }

    if (Object.keys(state).length > 0) {
      await Storage.saveGroupState(id, state);
      console.log(state, 'Saved group state to OpenMLS storage.');
      return state;
    }
    return null;
  }

  /**
   * Create a new group (for group creators only).
   * Returns a new OpenMLS instance (cached via save()).
   */
  static async createGroup(id, userLabel, metadata = {}) {
    await initOpenMLS();

    // Check if group is already loaded in memory
    if (groupCache.has(id)) {
      console.log('Using cached OpenMLS group:', id);
      return groupCache.get(id);
    }

    console.log('Creating new OpenMLS group with id:', id);
    const { provider, identity } = await getUserKeyPackage(userLabel);

    const group = Group.create_new(provider, identity, id);
    await OpenMLS.persistGroupState(id, group, metadata);
    console.log('Created new OpenMLS group:', group);

    // Create OpenMLS instance
    const instance = new OpenMLS({ id, identity, group, provider, userLabel });

    // Save to storage and cache (save() handles caching after successful persist)
    await instance.save();
    console.log('Persisted created group state to storage:', id);

    return instance;
  }

  /**
   * Get a group from cache or load from storage.
   * First checks in-memory cache, then attempts to load from provider storage.
   * This enables groups to persist across page reloads!
   */
  static async getGroup(id, userLabel) {
    await initOpenMLS();

  // Check in-memory cache first
    if (groupCache.has(id)) {
      console.log('Using cached OpenMLS group:', id);
      return groupCache.get(id);
    }

    // Try to load from provider storage (persists across page reloads!)
    console.log(`Group not in cache, attempting to load from storage: ${id} (userLabel: ${userLabel})`);
    const { provider, identity } = await getUserKeyPackage(userLabel);
    const groupIdBytes = new TextEncoder().encode(id);

    const loadedGroup = await Group.load(provider, groupIdBytes);
    if (loadedGroup) {
      console.log('Successfully loaded group from storage:', id);
      // Cache the loaded group (no need to save since we just loaded from storage)
      const instance = new OpenMLS({ id, identity, group: loadedGroup, provider, userLabel });
      groupCache.set(id, instance);
      return instance;
    }

    console.log(`Group.load() returned null for ${id}...`);

    // Group not in storage - check IndexedDB for additional context
    const state = await Storage.loadGroupState(id);

    if (state && state.welcome && state.ratchetTree) {
      // Group has welcome/ratchet tree but hasn't been joined yet
      console.warn('Group has Welcome/GroupInfo but not joined yet:', id);
      throw new Error(`Group ${id} not joined yet - waiting for Welcome and GroupInfo messages to be processed`);
    } else {
      // No group state at all
      console.error('Group not found in cache or storage:', id, state);
      throw new Error(`Group ${id} not found - you may need to be invited to this group first`);
    }
  }


  /**
   * Save both group metadata and provider storage to IndexedDB, then update cache.
   *
   * Persists two separate pieces of state:
   * 1. Group metadata (ratchetTree, members, name, etc.) via persistGroupState()
   *    - Saved to 'groups' table in IndexedDB
   *    - Used for UI display and member tracking
   *    - Preserves existing metadata fields (members, name, apId, etc.)
   *
   * 2. Provider storage (all MLS groups for this user) via persistProviderStorage()
   *    - Saved to 'users' table under state.providerStorage
   *    - Contains the WASM provider's internal state
   *    - Required for Group.load() to work after page reload
   *
   * 3. Updates in-memory cache after successful save to ensure consistency
   *
   * Order matters: save group metadata first (which may update provider state via
   * export_ratchet_tree()), then persist the updated provider storage, then cache.
   */
  async save() {
    // Load existing metadata to preserve fields like members, name, apId
    const existingState = (await Storage.loadGroupState(this.id)) || {};
    // Save group metadata (ratchet tree + existing metadata) to IndexedDB
    await OpenMLS.persistGroupState(this.id, this.group, existingState);
    // Persist provider storage (contains actual MLS group state) to IndexedDB
    // Must happen AFTER persistGroupState since exporting ratchet tree may update provider
    await persistProviderStorage(this.provider, this.userLabel);
    // Update cache after successful save to ensure cache stays in sync with storage
    groupCache.set(this.id, this);
  }

  /**
   * Encrypt a message for the group.
   *
   * Accepts string or object (will be JSON.stringify'd).
   * Advances the sender's ratchet state and persists both group metadata and
   * provider storage to IndexedDB via save().
   *
   * Returns ciphertext as Array (for storage/transmission).
   */
  async encrypt(plaintext) {
    const msg = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
    const encoded = new TextEncoder().encode(msg);
    try {
      const ciphertext = this.group.create_message(this.provider, this.identity, encoded);
      // Save group metadata and provider storage after encryption (ratchet advances)
      await this.save();
      return Array.from(ciphertext); // Uint8Array to Array for storage/transmission
    } catch (error) {
      console.error('Failed to create message:', error);
      throw error;
    }
  }

  /**
   * Decrypt a message from the group.
   *
   * Accepts base64 string, hex string, Array, or Uint8Array.
   * Advances the receiver's ratchet state and persists both group metadata and
   * provider storage to IndexedDB via save().
   *
   * Returns decrypted plaintext. If valid JSON, returns parsed object; otherwise string.
   */
  async decrypt(base64Ciphertext) {
    let ciphertextArr;
    if (undefined === base64Ciphertext || base64Ciphertext === null) {
      console.log('No ciphertext provided for decryption.');
      return;
    }
    ciphertextArr = bytesFromInput(base64Ciphertext);
    let plaintext;
    try {
      plaintext = this.group.process_message(this.provider, ciphertextArr);
    } catch (error) {
      console.log(error, 'Could not decrypt message with current group state.');
      return;
    }
    // Save group metadata and provider storage after decryption (ratchet advances)
    await this.save();
    const decoded = new TextDecoder().decode(plaintext);
    try {
      return JSON.parse(decoded);
    } catch {
      console.log('Decrypted plaintext is not JSON, returning as string.');
      return decoded;
    }
  }

  /**
   * Add a single member to the group using their KeyPackage bytes or base64.
   * Returns { commit, welcome, ratchetTree } as Uint8Array instances and
   * persists the updated state.
   */
  async addMember(keyPackageBytesLike) {
    let bytes = bytesFromInput(keyPackageBytesLike)
    console.log('Adding member with KeyPackage bytes:', bytes);
    const newMemberKp = KeyPackage.from_bytes(bytes);

    const addMessages = this.group.propose_and_commit_add(this.provider, this.identity, newMemberKp);
    if (!(addMessages instanceof AddMessages)) {
      throw new Error('Failed to add member: no AddMessages returned');
    }
    // Apply the pending commit to advance local state
    this.group.merge_pending_commit(this.provider);

    const ratchetTreeBytes = this.group.export_ratchet_tree().to_bytes();
    const welcomeBytes = addMessages.welcome;
    const commitBytes = addMessages.commit;

    // Save group metadata and provider storage after adding member
    await this.save();

    // Also save welcome bytes to group metadata (for transmitting to new member)
    const existingState = (await Storage.loadGroupState(this.id)) || {};
    await Storage.saveGroupState(this.id, {
      ...existingState,
      ratchetTree: Array.from(ratchetTreeBytes),
      welcome: Array.from(welcomeBytes)
    });

    return { commit: commitBytes, welcome: welcomeBytes, ratchetTree: ratchetTreeBytes };
  }

  /**
   * Join a group using received welcome and ratchet tree (both base64 or Uint8Array).
   * Persists state and returns a new OpenMLS instance (cached via save()).
   * This can only be called ONCE per Welcome message (KeyPackage is consumed).
   */
  static async joinFromWelcome(id, welcomeBytesLike, ratchetTreeBytesLike, userLabel) {
    await initOpenMLS();

    // Check if group is already cached (already joined in this session)
    if (groupCache.has(id)) {
      console.log('Group already joined and cached:', id);
      return groupCache.get(id);
    }

    console.log('Joining group from Welcome message:', id);
    const { provider, identity } = await getUserKeyPackage(userLabel);
    const welcome = bytesFromInput(welcomeBytesLike);
    const ratchetTreeBytes = bytesFromInput(ratchetTreeBytesLike);
    const ratchetTree = RatchetTree.from_bytes(ratchetTreeBytes);
    const group = Group.join(provider, welcome, ratchetTree);
    console.log('Successfully joined group:', id);

    // Note: ratchetTree is consumed by Group.join(), so we save the original bytes
    // Load existing state to preserve members and other fields
    const existingState = (await Storage.loadGroupState(id)) || {};
    await Storage.saveGroupState(id, {
      ...existingState,
      welcome: Array.from(welcome),
      ratchetTree: Array.from(ratchetTreeBytes),
      joined: true  // Mark as joined to prevent duplicate attempts
    });

    // Create instance with correct userLabel
    const instance = new OpenMLS({ id, identity, group, provider, userLabel });

    // Save to storage and cache (save() handles caching after successful persist)
    await instance.save();
    console.log('Persisted joined group state to storage:', id);

    return instance;
  }
}

