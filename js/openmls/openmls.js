// openmls.js
// Abstractions for OpenMLS group/session management using WASM
// Assumes openmls_wasm.js is loaded and available

// Example usage:
//   const group = await OpenMLS.createOrLoad('my-group-id', 'me');
//   const ciphertext = group.encrypt('hello');
//   const plaintext = group.decrypt(ciphertext);


import * as Storage from './openmlsStorage.js';
import { getOrCreateUserKeyPackage } from './openmlsUser.js';

let openmlsWasm = null;
let Provider, Identity, Group, KeyPackage, RatchetTree;

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
    // Save welcome and ratchet tree if available
    const state = { ...metadata };
    if (typeof group.export_welcome === 'function') {
      try {
        const welcome = group.export_welcome();
        state.welcome = Array.from(welcome);
      } catch (e) {
        console.warn('Failed to export welcome:', e);
      }
    }
    if (typeof group.export_ratchet_tree === 'function') {
      try {
        const ratchetTree = group.export_ratchet_tree();
        state.ratchetTree = Array.from(ratchetTree);
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
    console.log('Creating/loading OpenMLS group with id:', id);
    let state = await Storage.loadGroupState(id);
    console.log('Loaded group state from storage:', state);
    const { provider, identity } = await getOrCreateUserKeyPackage(userLabel);
    console.log('Using identity for userLabel:', userLabel, identity);
    let group;
    if (state && state.welcome && state.ratchetTree) {
      // Restore group from welcome and ratchet tree
      group = Group.join(provider, new Uint8Array(state.welcome), new Uint8Array(state.ratchetTree));
      console.log('Restored OpenMLS group from welcome and ratchet tree:', group);
    } else {
      // Create new group and persist welcome and/or ratchet tree
      group = Group.create_new(provider, identity, id);
      await OpenMLS.saveGroupState(id, group, metadata);
      console.log('Created new OpenMLS group:', group);
    }
    // Attach metadata to the instance for convenience
    return new OpenMLS({ id, identity, group, provider, ...metadata });
  }

  async save() {
    return await OpenMLS.saveGroupState(this.id, this.group);
  }

  encrypt(plaintext) {
    // Accepts string or object
    const msg = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
    const encoded = new TextEncoder().encode(msg);
    const ciphertext = this.group.create_message(this.provider, this.identity, encoded);
    // Save group state after encryption
    this.save();
    return Array.from(ciphertext); // Uint8Array to Array for storage/transmission
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
    try {
      const plaintext = this.group.process_message(this.provider, ciphertextArr);
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


}


