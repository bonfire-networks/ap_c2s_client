// openmls.js
// Abstractions for OpenMLS group/session management using WASM
// Assumes openmls_wasm.js is loaded and available

// Example usage:
//   const group = await OpenMLS.createOrLoad('my-group-id', 'me');
//   const ciphertext = group.encrypt('hello');
//   const plaintext = group.decrypt(ciphertext);


import * as Storage from './openmlsStorage.js';
import { getOrCreateUserKeyPackage, ensureKeyPackagesAvailable } from './openmlsUser.js';
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

    if (typeof group.export_ratchet_tree === 'function') {
      try {
        const ratchetTree = group.export_ratchet_tree();
        // export_ratchet_tree() returns a RatchetTree object, need to call to_bytes()
        const ratchetTreeBytes = ratchetTree.to_bytes();
        state.ratchetTree = Array.from(ratchetTreeBytes);
      } catch (e) {
        console.warn('Failed to export ratchet tree:', e);
      }
    }
    if (Object.keys(state).length > 0) {
      await Storage.saveGroupState(id, state);
      console.log(state, 'Saved group state to storage.');
      return state;
    }
    return null;
  }

  static async createOrLoad(id, userLabel = 'me', metadata = {}) {
    await initOpenMLS();

    // Check if group is already loaded in memory
    if (groupCache.has(id)) {
      console.log('Using cached OpenMLS group:', id);
      return groupCache.get(id);
    }

    console.log('Creating/loading OpenMLS group with id:', id);
    let state = await Storage.loadGroupState(id);
    console.log('Loaded group state from storage:', state);

    const { provider, identity } = await getOrCreateUserKeyPackage(userLabel);
    console.log('Using identity for userLabel:', userLabel, identity);

    // Ensure we have fresh key packages BEFORE any group operations
    await ensureKeyPackagesAvailable(userLabel);

    let group;

    // Try to join from welcome + ratchet tree (only for members, only works ONCE)
    if (state && state.welcome && state.ratchetTree) {
      const welcomeBytes = arrayToUint8Array(state.welcome);
      const ratchetTreeBytes = arrayToUint8Array(state.ratchetTree);
      try {
        const ratchetTree = RatchetTree.from_bytes(ratchetTreeBytes);
        group = Group.join(provider, welcomeBytes, ratchetTree);
        console.log('Joined OpenMLS group from welcome and ratchet tree:', group);
        // Replenish key packages after join consumes one
        await ensureKeyPackagesAvailable(userLabel);
      } catch (e) {
        console.error('Failed to join group from welcome/ratchet tree:', e);
        // Clear the corrupted state and create new group
        await Storage.saveGroupState(id, {});
      }
    }

    // If no group yet, create new one (for group creator)
    if (!group) {
      group = Group.create_new(provider, identity, id);
      await OpenMLS.saveGroupState(id, group, metadata);
      console.log('Created new OpenMLS group:', group);
    }

    // Create OpenMLS instance and cache it
    const instance = new OpenMLS({ id, identity, group, provider, ...metadata });
    groupCache.set(id, instance);

    return instance;
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
    // Accepts base64 string or Uint8Array/Array
    let ciphertextArr;
    if (undefined === base64Ciphertext || base64Ciphertext === null) {
      console.log('No ciphertext provided for decryption.');
      return;
    } else if (typeof base64Ciphertext === 'string') {
      ciphertextArr = Uint8Array.from(atob(base64Ciphertext), c => c.charCodeAt(0));
    } else if (Array.isArray(base64Ciphertext)) {
      ciphertextArr = new Uint8Array(base64Ciphertext);
    } else if (base64Ciphertext instanceof Uint8Array) {
      ciphertextArr = base64Ciphertext;
    } else {
      console.log('Invalid ciphertext input:', base64Ciphertext);
      throw new Error('Invalid ciphertext input');
    }
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
    const newMemberKp = KeyPackage.from_bytes(bytesFromInput(keyPackageBytesLike));
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
   * Persists state and returns a new OpenMLS instance bound to the same user.
   */
  static async joinFromWelcome(id, welcomeBytesLike, ratchetTreeBytesLike, userLabel = 'me') {
    await initOpenMLS();
    const { provider, identity } = await getOrCreateUserKeyPackage(userLabel);
    const welcome = bytesFromInput(welcomeBytesLike);
    const ratchetTree = RatchetTree.from_bytes(bytesFromInput(ratchetTreeBytesLike));
    const group = Group.join(provider, welcome, ratchetTree);
    await Storage.saveGroupState(id, {
      welcome: Array.from(welcome),
      ratchetTree: Array.from(ratchetTree.to_bytes())
    });
    return new OpenMLS({ id, identity, group, provider });
  }
}


