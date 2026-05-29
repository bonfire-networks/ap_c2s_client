/**
 * IndexedDB storage implementation via Dexie.js
 * Implements the storage interface defined in storage-interface.js
 */

import { Dexie } from 'dexie';
import { messageUri } from '../utils.js';

function _openDb(dbName) {
  const instance = new Dexie(dbName);
  // Track all mutating operations so drainWrites() can wait for them before quit
  instance.use({
    stack: 'dbcore',
    name: 'write-tracker',
    create(downlevel) {
      return {
        ...downlevel,
        table(tableName) {
          const tbl = downlevel.table(tableName);
          return {
            ...tbl,
            mutate(req) {
              const p = tbl.mutate(req);
              trackWrite(p);
              return p;
            },
          };
        },
      };
    },
  });
  instance.version(1).stores({
    groups: 'id',
    users: 'id',
    messages: 'id, groupId, timestamp, isLocal',
    processedActivityIds: '++id, actorId, activityId'
  });
  instance.version(2).stores({
    groups: 'id, apId',
    users: 'id',
    messages: 'id, groupId, timestamp, isLocal',
    processedActivityIds: '++id, actorId, activityId'
  });
  instance.version(3).stores({
    groups: 'id, apId',
    users: 'id',
    messages: 'id, groupId, timestamp, isLocal',
    processedActivityIds: '++id, [actorId+activityId]'
  });
  instance.version(4).stores({
    groups: 'id, apId',
    users: 'id',
    messages: 'id, groupId, timestamp, isLocal, apId',
    processedActivityIds: '++id, [actorId+activityId]'
  });
  return instance;
}

// Per-actor DB instance — initialised by initForActor() before any storage calls
let db = _openDb('openmls-db'); // fallback so module-level code doesn't crash

// ── Write-drain support ────────────────────────────────────────────────────
// Track in-flight write promises so we can wait for them before app quit.
let _pendingWrites = new Set();

/** Wrap a write promise so it is tracked for drainWrites(). */
export function trackWrite(promise) {
  _pendingWrites.add(promise);
  promise.finally(() => _pendingWrites.delete(promise));
  return promise;
}

/** Wait for all in-flight writes to settle (used before app quit). */
export async function drainWrites() {
  if (_pendingWrites.size === 0) return;
  await Promise.allSettled([..._pendingWrites]);
}

/**
 * Switch to a per-actor database. Must be called before any storage operations.
 * Uses a sanitised actor ID as part of the DB name so each user gets isolated storage.
 */
export function initForActor(actorId) {
  const safe = actorId.replace(/[^a-zA-Z0-9._-]/g, '_');
  // If a device_id is set (e.g., by E2E init or multi-instance scenarios), include it
  // to prevent co-devices on the same origin from sharing IndexedDB state.
  const deviceId = localStorage.getItem('device_id');
  const suffix = deviceId ? `-${deviceId.replace(/[^a-zA-Z0-9._-]/g, '_')}` : '';
  db = _openDb(`openmls-db-${safe}${suffix}`);
}

/**
 * Replace storage functions with no-ops for diagnostic reloads.
 * scope: 'all' — noop everything (default)
 *        'messages' — groups load normally, messages return empty
 */
export function setNoop(scope = 'all') {
  if (scope === 'attachments') {
    // Strip localPath from all attachment objects so serve_attachment is never called.
    const _realListMessages = listMessages;
    listMessages = async (groupId) => {
      const msgs = await _realListMessages(groupId);
      return msgs.map(m => {
        if (!m.content) return m;
        const c = m.content;
        const stripLocalPath = a => ({ ...a, _localPath: undefined });
        return {
          ...m,
          content: {
            ...c,
            // Strip from top-level (e.g. Image message that IS the attachment)
            _localPath: undefined,
            // Strip from attachment array
            attachment: c.attachment?.map(stripLocalPath)
          }
        };
      });
    };
    console.warn('[storage] noop: attachment localPaths stripped, messages active');
    return;
  }
  if (scope === 'messages') {
    // Override only message-related functions; groups still load from real DB
    listMessages = async () => [];
    saveMessage = async () => {};
    updateDeliveryStatus = async () => {};
    updateMessage = async () => {};
    tombstoneMessage = async () => {};
    deleteMessage = async () => {};
    deleteGroupMessages = async () => {};
    console.warn('[storage] noop: messages disabled, groups still active');
    return;
  }
  // 'all': replace the DB entirely
  db = {
    open: async () => {},
    table: () => ({
      count: async () => 0,
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
      toArray: async () => [],
      where: () => ({ equals: () => ({ toArray: async () => [], first: async () => undefined }) }),
    }),
  };
  console.warn('[storage] noop: all storage disabled');
}

/**
 * Probe the DB to verify it opens and is readable.
 * Throws if the database is corrupted or inaccessible.
 * Call this after initForActor() to detect problems early.
 */
export async function verifyDb() {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database timed out — may be locked or corrupted')), 5000)
  );
  await Promise.race([db.open(), timeout]);
  await Promise.race([db.table('groups').count(), timeout]);
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

function _assertKey(value, label) {
  const valid = typeof value === 'string' || typeof value === 'number' || value instanceof Date ||
    (Array.isArray(value) && value.every(v => typeof v === 'string' || typeof v === 'number' || v instanceof Date));
  if (!valid) throw new Error(`[IndexedDB] Invalid key for ${label}: ${JSON.stringify(value)} (${typeof value})`);
}

async function _updateUserState(userId, updater) {
  _assertKey(userId, 'users.id');
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
  _assertKey(id, 'groups.id');
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
  _assertKey(id, 'groups.id');
  const rec = await db.table('groups').get(id);
  if (rec) {
    await db.table('groups').put({ ...rec, [field]: value });
  } else {
    await db.table('groups').put({ id, [field]: value, state: {} });
  }
}

export async function getGroupField(id, field, defaultValue = null) {
  const rec = await db.table('groups').get(id);
  return rec?.[field] ?? defaultValue;
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

export async function saveMessage(groupId, content, id = undefined, isLocal = false, apId = undefined, deliveryStatus = undefined, explicitTimestamp = undefined) {
  const messageId = id || messageUri();
  _assertKey(messageId, 'messages.id');
  _assertKey(groupId, 'messages.groupId');
  const timestamp = explicitTimestamp || (content && content.timestamp) || Date.now();
  const rec = { id: messageId, groupId, isLocal, content, timestamp, isRead: isLocal };
  if (apId) rec.apId = apId;
  if (deliveryStatus) rec.deliveryStatus = deliveryStatus;
  await db.table('messages').put(rec);
  return messageId;
}

export async function markMessageRead(id) {
  const rec = await db.table('messages').get(id);
  if (rec && !rec.isRead) await db.table('messages').put({ ...rec, isRead: true });
}

export async function getMessage(id) {
  const rec = await db.table('messages').get(id);
  return rec || null;
}

export async function getMessageByApId(apId) {
  const rec = await db.table('messages').where('apId').equals(apId).first();
  return rec || null;
}

export async function listMessages(groupId) {
  const msgs = await db.table('messages').where('groupId').equals(groupId).sortBy('timestamp');
  return msgs.map(m => ({ id: m.id, groupId: m.groupId, isLocal: m.isLocal, isRead: m.isRead ?? m.isLocal ?? false, content: m.content, timestamp: m.timestamp, deliveryStatus: m.deliveryStatus || null, editedAt: m.editedAt || null, reactions: m.reactions || {} }));
}

export async function updateDeliveryStatus(messageId, actorId, statusEntry) {
  const rec = await db.table('messages').get(messageId);
  if (!rec) return;
  const current = rec.deliveryStatus || {};
  await db.table('messages').put({ ...rec, deliveryStatus: { ...current, [actorId]: statusEntry } });
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

export async function updateMessage(id, updatedFields) {
  const existing = await db.table('messages').get(id);
  if (!existing) return;
  await db.table('messages').put({
    ...existing,
    content: { ...existing.content, ...updatedFields },
    editedAt: Date.now(),
  });
}

export async function tombstoneMessage(id) {
  const existing = await db.table('messages').get(id);
  if (!existing) return;
  await db.table('messages').put({
    ...existing,
    content: {
      type: 'Tombstone',
      id: existing.content?.id,
      inReplyTo: existing.content?.inReplyTo,
      attributedTo: existing.content?.attributedTo,
    },
    deletedAt: Date.now(),
  });
}

export async function deleteMessage(id) {
  await db.table('messages').delete(id);
}

export async function deleteGroupMessages(groupId) {
  await db.table('messages').where('groupId').equals(groupId).delete();
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
// Actor profiles (stored in users table)
// ──────────────────────────────────────────────

export async function saveActorProfile(actorId, profile) {
  await _updateUserState(actorId, (state = {}) => ({
    ...state,
    profile: {
      name: profile.name || null,
      preferredUsername: profile.preferredUsername || null,
      icon: profile.icon || null,
      updatedAt: Date.now()
    }
  }));
}

export async function getActorProfile(actorId) {
  const state = await loadUserState(actorId);
  return state?.profile || null;
}

// ──────────────────────────────────────────────
// Activity deduplication
// ──────────────────────────────────────────────

export async function markProcessed(actorId, activityId) {
  _assertKey(actorId, 'processedActivityIds.actorId');
  _assertKey(activityId, 'processedActivityIds.activityId');
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
// Reactions (emoji → [actorId, ...] map on message record)
// ──────────────────────────────────────────────

export async function addReaction(messageId, actorId, emoji, activityId = null) {
  const rec = await db.table('messages').get(messageId);
  if (!rec) return;
  const reactions = rec.reactions || {};
  const actors = reactions[emoji] || [];
  if (actors.includes(actorId)) return; // idempotent
  const updated = { ...rec, reactions: { ...reactions, [emoji]: [...actors, actorId] } };
  if (activityId) {
    const ra = rec.reactionActivities || {};
    updated.reactionActivities = { ...ra, [emoji]: { ...(ra[emoji] || {}), [actorId]: activityId } };
  }
  await db.table('messages').put(updated);
}

export async function getReactionActivityId(messageId, actorId, emoji) {
  const rec = await db.table('messages').get(messageId);
  return rec?.reactionActivities?.[emoji]?.[actorId] || null;
}

export async function removeReaction(messageId, actorId, emoji) {
  const rec = await db.table('messages').get(messageId);
  if (!rec) return;
  const reactions = rec.reactions || {};
  const actors = (reactions[emoji] || []).filter(id => id !== actorId);
  const updated = { ...reactions };
  if (actors.length === 0) delete updated[emoji];
  else updated[emoji] = actors;
  await db.table('messages').put({ ...rec, reactions: updated });
}

// ──────────────────────────────────────────────
// Read-receipt opt-in setting (per actor, stored in user state)
// ──────────────────────────────────────────────

// Generic per-user setting helpers
export async function saveUserSetting(actorId, key, value) {
  return saveUserField(actorId, key, value);
}
export async function loadUserSetting(actorId, key, defaultValue = null) {
  const state = await loadUserState(actorId);
  return state?.[key] ?? defaultValue;
}

// ──────────────────────────────────────────────
// Bulk operations
// ──────────────────────────────────────────────

export async function clearAll() {
  await db.table('users').clear();
  await db.table('groups').clear();
  await db.table('messages').clear();
  // NOTE: processedActivityIds intentionally preserved so already-processed
  // inbox items are not re-fetched after a data clear.
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


// Generic aliases used by openmlsUser.js
export async function saveState(store, id, state) {
  if (store === 'groups') return saveGroupMeta(id, state);
  if (store === 'users') {
    _assertKey(id, 'users.id');
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
