// IndexedDB via Dexie.js wrapper for OpenMLS group/session state

import { Dexie } from '../node_modules/dexie/dist/modern/dexie.mjs';

const DB_NAME = 'openmls-db';
const DB_VERSION = 1;

const db = new Dexie(DB_NAME);
// messages: store top-level fields for efficient indexing/querying
db.version(DB_VERSION).stores({
  groups: 'id',
  users: 'id',
  messages: 'id, groupId, timestamp, isLocal'
});

// Generic helpers (groups/users store states under `state` to preserve shape)
async function saveState(store, id, state) {
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

async function loadState(store, id) {
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

export async function loadUserKeyPackage(userId) {
  const state = await loadState('users', userId);
  return state ? state.keyPackage : null;
}

export async function getKeyPackageLastPublishedDate(userId) {
  const state = await loadState('users', userId);
  return state ? state.publishedDate || null : null;
}

export function setKeyPackagePublishedDate(userId, timestamp = Date.now()) {
  return updateState('users', userId, (state = {}) => ({ ...state, publishedDate: timestamp }));
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
