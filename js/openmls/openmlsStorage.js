// openmlsStorage.js
// IndexedDB wrapper for OpenMLS group/session state


const DB_NAME = 'openmls-db';
const DB_VERSION = 2;
const STORES = ['groups', 'users', 'messages'];

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Generic helpers
async function saveState(store, id, state) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const objStore = tx.objectStore(store);
    objStore.put({ id, state });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadState(store, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const objStore = tx.objectStore(store);
    const req = objStore.get(id);
    req.onsuccess = () => resolve(req.result ? req.result.state : null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteState(store, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const objStore = tx.objectStore(store);
    objStore.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function listStates(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const objStore = tx.objectStore(store);
    const req = objStore.getAll();
    req.onsuccess = () => resolve(req.result.map(r => ({ id: r.id, state: r.state })));
    req.onerror = () => reject(req.error);
  });
}

// Group-specific
export function saveGroupState(id, state) {
  return saveState('groups', id, state);
}
export function loadGroupState(id) {
  return loadState('groups', id);
}
export function deleteGroupState(id) {
  return deleteState('groups', id);
}
export function listGroupStates() {
  return listStates('groups');
}

// User-specific (for key packages)
export function saveUserKeyPackage(userId, keyPackageHex) {
  return saveState('users', userId, { keyPackageHex });
}
export async function loadUserKeyPackage(userId) {
  const state = await loadState('users', userId);
  return state ? state.keyPackageHex : null;
}

// Message-specific 
export function saveMessage(groupId, content, id = undefined, isLocal = false) {
  // id: optional unique id for the message (e.g., AP id or MLS message id)
  return saveState('messages', id || crypto.randomUUID(), { groupId, isLocal, content });
}
export async function listMessagesInGroup(groupId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const objStore = tx.objectStore('messages');
    const req = objStore.getAll();
    req.onsuccess = () => {
      // Filter by groupId/context and return full object
      const filtered = req.result.filter(r => r.state.groupId === groupId);
      resolve(filtered.map(r => ({
        id: r.id,
        ...r.state
      })));
    };
    req.onerror = () => reject(req.error);
  });
}
export function deleteMessage(id) {
  return deleteState('messages', id);
}

// List all known groups and load the last message from each
export async function listGroupsWithLastMessage() {
  const groups = await listGroupStates();
  console.log('loaded groups:', groups);
  const db = await openDB();
  const tx = db.transaction('messages', 'readonly');
  const objStore = tx.objectStore('messages');
  const req = objStore.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const allMessages = req.result;
      const result = groups.map(g => {
        // Find all messages for this group
        const groupMsgs = allMessages.filter(m => m.state.groupId === g.id);
        // Sort by id or add a timestamp to message state for better sorting
        groupMsgs.sort((a, b) => (a.state.timestamp || 0) - (b.state.timestamp || 0)); // ascending
        const lastMsg = groupMsgs.length > 0 ? {
          id: groupMsgs[groupMsgs.length - 1].id,
          ...groupMsgs[groupMsgs.length - 1].state
        } : null;
        return {
          groupId: g.id,
          groupState: g.state,
          lastMessage: lastMsg
        };
      });
      resolve(result);
    };
    req.onerror = () => reject(req.error);
  });
}
