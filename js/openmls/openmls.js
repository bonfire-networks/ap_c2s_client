// openmls.js
// Abstractions for OpenMLS group/session management using WASM
// Assumes openmls_wasm.js is loaded and available

// Example usage:
//   const group = await OpenMLS.createGroup('my-group-id', 'me');
//   const ciphertext = group.encrypt('hello');
//   const plaintext = group.decrypt(ciphertext);


import * as Storage from './openmlsStorage.js';
import { getUserKeyPackage } from './openmlsUser.js';
import { bytesFromInput, arrayToUint8Array } from './openmlsUtils.js';

let openmlsWasm = null;
let Provider, Identity, Group, KeyPackage, RatchetTree, AddMessages;

// Cache group instances in memory to avoid re-joining
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
  constructor({ id, identity, group, provider }) {
    this.id = id;
    this.identity = identity;
    this.group = group;
    this.provider = provider;
  }

  static async saveGroupState(id, group, metadata = {}) {
    // Save ratchet tree for reference (but can't be used to restore group)
    const state = { ...metadata };

    // if (typeof group.export_ratchet_tree === 'function') {
      try {
        const ratchetTree = group.export_ratchet_tree();
        // export_ratchet_tree() returns a RatchetTree object, need to call to_bytes()
        const ratchetTreeBytes = ratchetTree.to_bytes();
        state.ratchetTree = Array.from(ratchetTreeBytes);
      } catch (e) {
        console.error('Failed to export ratchet tree:', e);
      }
    // }
    if (Object.keys(state).length > 0) {
      await Storage.saveGroupState(id, state);
      console.log(state, 'Saved group state to storage.');
      return state;
    }
    return null;
  }

  /**
   * Create a new group (for group creators only).
   * Returns a new OpenMLS instance and caches it.
   */
  static async createGroup(id, userLabel = 'me', metadata = {}) {
    await initOpenMLS();

    // Check if group is already loaded in memory
    if (groupCache.has(id)) {
      console.log('Using cached OpenMLS group:', id);
      return groupCache.get(id);
    }

    console.log('Creating new OpenMLS group with id:', id);
    const { provider, identity } = await getUserKeyPackage(userLabel);

    const group = Group.create_new(provider, identity, id);
    await OpenMLS.saveGroupState(id, group, metadata);
    console.log('Created new OpenMLS group:', group);

    // Create OpenMLS instance and cache it
    const instance = new OpenMLS({ id, identity, group, provider, ...metadata });
    groupCache.set(id, instance);

    return instance;
  }

  /**
   * Get a group from cache only. Does not attempt to join or create.
   * Throws if group is not in cache (meaning you must stay in same session).
   */
  static async getGroup(id, userLabel = 'me') {
    if (groupCache.has(id)) {
      console.log('Using cached OpenMLS group:', id);
      return groupCache.get(id);
    }

    // Group not in cache - check if we have state in storage to provide better error
    const state = await Storage.loadGroupState(id);
    if (state && state.joined) {
      // Group was joined but cache was lost (page reload)
      console.error('Group was joined but cache lost (page reload?):', id);
      throw new Error(`Group ${id} session lost - MLS groups cannot persist across page reloads. Please stay in the same browser session.`);
    } else if (state && state.welcome && state.ratchetTree) {
      // Group has welcome/ratchet tree but hasn't been joined yet
      console.warn('Group has Welcome/GroupInfo but not joined yet:', id);
      throw new Error(`Group ${id} not joined yet - waiting for Welcome and GroupInfo messages to be processed`);
    } else {
      // No group state at all
      console.error('Group not found in cache:', id);
      throw new Error(`Group ${id} not found - you may need to be invited to this group first`);
    }
  }


  async save() {
    return await OpenMLS.saveGroupState(this.id, this.group);
  }

  encrypt(plaintext) {
    // Accepts string or object
    const msg = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
    const encoded = new TextEncoder().encode(msg);
    try {
      const ciphertext = this.group.create_message(this.provider, this.identity, encoded);
      // Save group state after encryption
      this.save();
      return Array.from(ciphertext); // Uint8Array to Array for storage/transmission
    } catch (error) {
      console.error('Failed to create message:', error);
      throw error;
    }
  }

  decrypt(base64Ciphertext) {
    // Accepts base64 string, hex string, Array, or Uint8Array
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
    // Save group state after decryption? (in case ratchet advanced)
    // this.save();
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

    await Storage.saveGroupState(this.id, {
      ratchetTree: Array.from(ratchetTreeBytes),
      welcome: Array.from(welcomeBytes)
    });

    return { commit: commitBytes, welcome: welcomeBytes, ratchetTree: ratchetTreeBytes };
  }

  /**
   * Join a group using received welcome and ratchet tree (both base64 or Uint8Array).
   * Persists state, caches the group instance, and returns a new OpenMLS instance.
   * This can only be called ONCE per Welcome message (KeyPackage is consumed).
   */
  static async joinFromWelcome(id, welcomeBytesLike, ratchetTreeBytesLike, userLabel = 'me') {
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
    await Storage.saveGroupState(id, {
      welcome: Array.from(welcome),
      ratchetTree: Array.from(ratchetTreeBytes),
      joined: true  // Mark as joined to prevent duplicate attempts
    });

    // Create instance and cache it
    const instance = new OpenMLS({ id, identity, group, provider });
    groupCache.set(id, instance);
    console.log('Cached joined group:', id);

    return instance;
  }
}


