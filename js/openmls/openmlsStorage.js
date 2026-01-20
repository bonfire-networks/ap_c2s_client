// IndexedDB via Dexie.js wrapper for OpenMLS group/session state

import { Dexie } from '../node_modules/dexie/dist/modern/dexie.mjs';

const DB_NAME = 'openmls-db';
const DB_VERSION = 1;

const db = new Dexie(DB_NAME);
// messages: store top-level fields for efficient indexing/querying
db.version(DB_VERSION).stores({
  groups: 'id',
  users: 'id',
  messages: 'id, groupId, timestamp, isLocal',
  processedActivityIds: '++id, actorId, activityId'
});
// Processed Activity ID helpers
// Each processed activity is stored as {actorId, activityId}
export async function saveProcessedActivityId(actorId, activityId) {
  // Only add if not already present
  const exists = await isProcessedActivityId(actorId, activityId);
  if (!exists) {
    await db.table('processedActivityIds').add({ actorId, activityId });
  }
}

export async function isProcessedActivityId(actorId, activityId) {
  // Efficient lookup by actorId and activityId
  const found = await db.table('processedActivityIds')
    .where({ actorId, activityId }).first();
  return !!found;
}

// Generic helpers (groups/users store states under `state` to preserve shape)
export async function saveState(store, id, state) {
  if (store === 'messages') {
    // messages are stored with top-level fields, not under `state`
    throw new Error('Use saveMessage for messages');
  }
  await db.table(store).put({ id, state });
}

async function updateState(store, id, updater) {
  if (store === 'messages') {
    throw new Error('Use saveMessage for messages');
  }
  const rec = await db.table(store).get(id);
  const current = rec && rec.state ? rec.state : {};
  const next = updater ? updater(current) : current;
  await db.table(store).put({ id, state: next });
  return next;
}

export async function loadState(store, id) {
  const rec = await db.table(store).get(id);
  return rec ? rec.state : null;
}

async function deleteState(store, id) {
  await db.table(store).delete(id);
}

async function listStates(store) {
  const all = await db.table(store).toArray();
  return all.map(r => ({ id: r.id, state: r.state }));
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

export function saveUserKeyPackageDraft(actorId, keyPackage) {
  return updateState('users', actorId, (state = {}) => ({ ...state, keyPackage: keyPackage }));
}

export function saveUserKeyPackagePublished(actorId, keyPackage) {
  return updateState('users', actorId, (state = {}) => ({ ...state, keyPackage: keyPackage, publishedDate: Date.now() }));
}

export async function loadUserState(userId) {
  const state = await loadState('users', userId);
  return state;
}

export async function loadUserKeyPackage(userId) {
  const state = await loadUserState(userId);
  return state ? state.keyPackage : null;
}


export function setKeyPackagePublishedDate(userId, timestamp = Date.now()) {
  return updateState('users', userId, (state = {}) => ({ ...state, publishedDate: timestamp }));
}

// Identity public key storage (needed to restore Identity from Provider)
export async function saveIdentityPublicKey(userId, publicKeyBytes) {
  // publicKeyBytes should be a Uint8Array or Array
  return updateState('users', userId, (state = {}) => ({ ...state, identityPublicKey: Array.from(publicKeyBytes) }));
}

export async function loadIdentityPublicKey(userId) {
  const state = await loadState('users', userId);
  return state && state.identityPublicKey ? new Uint8Array(state.identityPublicKey) : null;
}

// Provider storage (for OpenMLS WASM provider key store)
export async function saveProviderStorage(userId, storageArr) {
  // storageArr should be a Uint8Array or Array
  return updateState('users', userId, (state = {}) => ({ ...state, providerStorage: Array.from(storageArr) }));
}

export async function loadProviderStorage(userId) {
  const state = await loadState('users', userId);
  return state && state.providerStorage ? new Uint8Array(state.providerStorage) : null;
}

// Message-specific
export async function saveMessage(groupId, content, id = undefined, isLocal = false) {
  const messageId = id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const timestamp = (content && content.timestamp) || Date.now();
  const rec = { id: messageId, groupId, isLocal, content, timestamp };
  await db.table('messages').put(rec);
  return messageId;
}

export async function listMessagesInGroup(groupId) {
  const msgs = await db.table('messages').where('groupId').equals(groupId).sortBy('timestamp');
  return msgs.map(m => ({ id: m.id, groupId: m.groupId, isLocal: m.isLocal, content: m.content, timestamp: m.timestamp }));
}

export function deleteMessage(id) {
  return deleteState('messages', id);
}

// List all known groups and load the last message from each
export async function listGroupsWithLastMessage() {
  const groups = await listGroupStates();
  // For each group, fetch last message by timestamp
  const result = await Promise.all(groups.map(async (g) => {
    const msgs = await db.table('messages').where('groupId').equals(g.id).sortBy('timestamp');
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    const lastMsg = last ? { id: last.id, groupId: last.groupId, isLocal: last.isLocal, content: last.content, timestamp: last.timestamp } : null;
    return {
      groupId: g.id,
      groupState: g.state,
      lastMessage: lastMsg
    };
  }));
  return result;
}
