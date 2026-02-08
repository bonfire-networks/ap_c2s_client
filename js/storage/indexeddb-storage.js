/**
 * IndexedDB storage implementation via Dexie.js
 * Implements the storage interface defined in storage-interface.js
 */

import { Dexie } from '../node_modules/dexie/dist/modern/dexie.mjs';

const DB_NAME = 'openmls-db';

const db = new Dexie(DB_NAME);
db.version(1).stores({
  groups: 'id',
  users: 'id',
  messages: 'id, groupId, timestamp, isLocal',
  processedActivityIds: '++id, actorId, activityId'
});
db.version(2).stores({
  groups: 'id, apId',
  users: 'id',
  messages: 'id, groupId, timestamp, isLocal',
  processedActivityIds: '++id, actorId, activityId'
});

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

async function _updateUserState(userId, updater) {
  if (!userId) throw new Error('userId is required');
  const rec = await db.table('users').get(userId);
  const current = rec && rec.state ? rec.state : {};
  const next = updater(current);
  // Preserve top-level fields
  await db.table('users').put({ ...rec, id: userId, state: next });
  return next;
}

// ──────────────────────────────────────────────
// Group metadata
// ──────────────────────────────────────────────

export async function saveGroupMeta(id, data) {
  // Preserve top-level fields (name, apId) that live outside `state`
  const existing = await db.table('groups').get(id);
  await db.table('groups').put({ ...existing, id, state: data });
}

export async function loadGroupMeta(id) {
  const rec = await db.table('groups').get(id);
  return rec ? rec.state : null;
}

export async function deleteGroupMeta(id) {
  await db.table('groups').delete(id);
}

export async function setGroupField(id, field, value) {
  const rec = await db.table('groups').get(id);
  if (rec) {
    await db.table('groups').put({ ...rec, [field]: value });
  } else {
    await db.table('groups').put({ id, [field]: value, state: {} });
  }
}

export async function getGroupByField(field, value) {
  const rec = await db.table('groups').where(field).equals(value).first();
  return rec ? rec.id : null;
}

export async function listGroupsWithLastMessage() {
  const groups = await db.table('groups').toArray();
  const result = await Promise.all(groups.map(async (g) => {
    const msgs = await db.table('messages').where('groupId').equals(g.id).sortBy('timestamp');
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    const lastMsg = last ? { id: last.id, groupId: last.groupId, isLocal: last.isLocal, content: last.content, timestamp: last.timestamp } : null;
    return {
      groupId: g.id,
      groupState: g.state,
      name: g.name,
      apId: g.apId,
      lastMessage: lastMsg
    };
  }));
  return result;
}

// ──────────────────────────────────────────────
// Messages
// ──────────────────────────────────────────────

export async function saveMessage(groupId, content, id = undefined, isLocal = false) {
  const messageId = id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const timestamp = (content && content.timestamp) || Date.now();
  const rec = { id: messageId, groupId, isLocal, content, timestamp };
  await db.table('messages').put(rec);
  return messageId;
}

export async function getMessage(id) {
  const rec = await db.table('messages').get(id);
  return rec || null;
}

export async function listMessages(groupId) {
  const msgs = await db.table('messages').where('groupId').equals(groupId).sortBy('timestamp');
  return msgs.map(m => ({ id: m.id, groupId: m.groupId, isLocal: m.isLocal, content: m.content, timestamp: m.timestamp }));
}

export async function findLastMessageExcludingTypes(groupId, excludedTypes) {
  const msgs = await db.table('messages')
    .where('groupId').equals(groupId)
    .reverse()
    .toArray();
  const displayableMsg = msgs.find(msg => {
    const type = msg.content?.type;
    return !excludedTypes.includes(type);
  });
  return displayableMsg ? {
    id: displayableMsg.id,
    groupId: displayableMsg.groupId,
    isLocal: displayableMsg.isLocal,
    content: displayableMsg.content,
    timestamp: displayableMsg.timestamp
  } : null;
}

export async function deleteMessage(id) {
  await db.table('messages').delete(id);
}

// ──────────────────────────────────────────────
// MLS backend state (opaque bytes)
// ──────────────────────────────────────────────

export async function saveBackendState(userId, bytes) {
  return _updateUserState(userId, (state = {}) => ({ ...state, providerStorage: Array.from(bytes) }));
}

export async function loadBackendState(userId) {
  const rec = await db.table('users').get(userId);
  const state = rec ? rec.state : null;
  return state && state.providerStorage ? new Uint8Array(state.providerStorage) : null;
}

// ──────────────────────────────────────────────
// User / key package state
// ──────────────────────────────────────────────

export async function saveUserField(userId, field, value) {
  return _updateUserState(userId, (state = {}) => ({ ...state, [field]: value }));
}

export async function loadUserState(userId) {
  const rec = await db.table('users').get(userId);
  return rec ? rec.state : null;
}

export async function clearUserKeyData(userId) {
  const state = await loadUserState(userId);
  if (state) {
    const { keyPackage, publishedDate, ...rest } = state;
    // Preserve top-level fields on the record
    const rec = await db.table('users').get(userId);
    await db.table('users').put({ ...rec, id: userId, state: rest });
  }
}

// ──────────────────────────────────────────────
// Activity deduplication
// ──────────────────────────────────────────────

export async function markProcessed(actorId, activityId) {
  const exists = await isProcessed(actorId, activityId);
  if (!exists) {
    await db.table('processedActivityIds').add({ actorId, activityId });
  }
}

export async function isProcessed(actorId, activityId) {
  const found = await db.table('processedActivityIds')
    .where({ actorId, activityId }).first();
  return !!found;
}

// ──────────────────────────────────────────────
// Bulk operations
// ──────────────────────────────────────────────

export async function clearAll() {
  await db.table('groups').clear();
  await db.table('messages').clear();
  await db.table('processedActivityIds').clear();
}

// ──────────────────────────────────────────────
// Backward-compatible aliases (remove after full migration)
// ──────────────────────────────────────────────

export const saveGroupState = saveGroupMeta;
export const loadGroupState = loadGroupMeta;
export const deleteGroupState = deleteGroupMeta;
export const listMessagesInGroup = listMessages;
export const clearAllData = clearAll;
export const saveProcessedActivityId = markProcessed;
export const isProcessedActivityId = isProcessed;

export async function setGroupApId(mlsGroupId, apId) {
  return setGroupField(mlsGroupId, 'apId', apId);
}
export async function getGroupIdByApId(apId) {
  return getGroupByField('apId', apId);
}
export async function getGroupApId(mlsGroupId) {
  const rec = await db.table('groups').get(mlsGroupId);
  return rec && rec.apId ? rec.apId : null;
}
export async function setGroupName(mlsGroupId, name) {
  return setGroupField(mlsGroupId, 'name', name);
}
export async function getGroupName(mlsGroupId) {
  const rec = await db.table('groups').get(mlsGroupId);
  return rec && rec.name ? rec.name : null;
}

export function saveUserKeyPackageDraft(actorId, keyPackage) {
  return saveUserField(actorId, 'keyPackage', keyPackage);
}
export async function saveUserKeyPackagePublished(actorId, keyPackage) {
  await _updateUserState(actorId, (state = {}) => ({ ...state, keyPackage, publishedDate: Date.now() }));
}
export async function loadUserKeyPackage(userId) {
  const state = await loadUserState(userId);
  return state ? state.keyPackage : null;
}
export function setKeyPackagePublishedDate(userId, timestamp = Date.now()) {
  return saveUserField(userId, 'publishedDate', timestamp);
}
export async function saveIdentityPublicKey(userId, publicKeyBytes) {
  return saveUserField(userId, 'identityPublicKey', Array.from(publicKeyBytes));
}
export async function loadIdentityPublicKey(userId) {
  const state = await loadUserState(userId);
  return state && state.identityPublicKey ? new Uint8Array(state.identityPublicKey) : null;
}
export async function saveProviderStorage(userId, storageArr) {
  return saveBackendState(userId, storageArr);
}
export async function loadProviderStorage(userId) {
  return loadBackendState(userId);
}

// Generic aliases used by openmlsUser.js
export async function saveState(store, id, state) {
  if (store === 'groups') return saveGroupMeta(id, state);
  if (store === 'users') {
    const rec = await db.table('users').get(id);
    await db.table('users').put({ ...rec, id, state });
    return;
  }
  throw new Error(`Unknown store: ${store}`);
}
export async function loadState(store, id) {
  if (store === 'groups') return loadGroupMeta(id);
  if (store === 'users') return loadUserState(id);
  throw new Error(`Unknown store: ${store}`);
}
