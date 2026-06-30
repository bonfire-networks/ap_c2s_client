/**
 * Chat controller — thin orchestration layer.
 *
 * Coordinates multi-step flows between:
 * - MLSService (encryption/decryption/key packages)
 * - AP transport (sending/receiving MLS messages via ActivityPub)
 * - AP client (fetching actors, posting to outbox)
 * - Storage (messages, group metadata, deduplication)
 *
 * Dependencies are injected via constructor.
 */

import { bytesToBase64, bytesFromInput, groupUri, messageUri, hasType, mlsKeyId, mlsEndorsementPayload } from './utils.js';
import { getCurrentActor, getActor, getActorId, apFetch, ensureFreshToken } from './activitypub/auth.js';
import { postToOutbox, fetchActorKeyPackage, fetchAllActorKeyPackages, resolveActorId, extractApIdFromResponse, forEachPublishedKeyPackage } from './activitypub/client.js';
import { sendMLSControl, publishKeyPackage, deleteKeyPackage, deleteKeyPackageForDevice, sendKeyPackageProposal, parseMLSActivity } from './activitypub/mls-transport.js';

// Types that receive a Read receipt when scrolled into view (excludes media — those get Listen/View)
const TEXT_RECEIPT_TYPES = new Set(['Note', 'Article', 'Page', 'Question']);

const MLS_CONTEXTS = [
  'https://www.w3.org/ns/activitystreams',
  'https://purl.archive.org/socialweb/mls'
];

/** Build the AP PrivateMessage body. `content` is a pendingId — Rust substitutes before sending. */
function buildPrivateMessageBody(actor, content, recipients, contextId, options = {}) {
  const { isNewThread, inReplyTo, usePrefix = false, overrides = {} } = options;
  const to = recipients;
  return {
    '@context': MLS_CONTEXTS,
    type: usePrefix ? 'mls:PrivateMessage' : 'PrivateMessage',
    attributedTo: actor.id,
    to,
    summary: 'This is an encrypted message. Please read it using a compatible MLS-capable app.',
    mediaType: 'message/mls',
    ...(usePrefix ? { 'mls:encoding': 'base64', 'mls:content': content } : { encoding: 'base64', content }),
    context: contextId || undefined,
    inReplyTo: inReplyTo || contextId || undefined,
    ...overrides,
  };
}

/** Collect all _localPath values from an AP object tree (top-level + attachment array). */
function _collectLocalPaths(obj) {
  const paths = [];
  if (!obj) return paths;
  if (obj._localPath) paths.push(obj._localPath);
  if (Array.isArray(obj.attachment)) {
    for (const att of obj.attachment) {
      if (att._localPath) paths.push(att._localPath);
    }
  }
  return paths;
}

/** Collect all _attachmentId values from an AP object tree (top-level + attachment array). */
function _collectAttachmentIds(obj) {
  const ids = [];
  if (!obj) return ids;
  if (obj._attachmentId) ids.push(obj._attachmentId);
  if (Array.isArray(obj.attachment)) {
    for (const att of obj.attachment) {
      if (att._attachmentId) ids.push(att._attachmentId);
    }
  }
  return ids;
}

/** Check if a value looks like an AP URI (not a local ULID or null). */
function isApUri(value) {
  return typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'));
}

/**
 * Group a deliveryStatus map into per-actor aggregates and per-actor client lists.
 * Returns { perActorBest: Map<actorId, entry>, byActor: Map<actorId, [{sigKey, entry}]> }
 * Per-client entries have { actorId, status } and are keyed by signatureKey.
 * Legacy entries have { status } and are keyed by actorId.
 */
export function groupDeliveryByActor(ds) {
  const STATUS_RANK = ['keys_broken', 'failed', 'sent', 'acknowledged', 'Read', 'Listen', 'View'];
  const perActorBest = new Map();
  const byActor = new Map();
  for (const [key, entry] of Object.entries(ds)) {
    const isPerClient = !!entry.actorId;
    const actorId = isPerClient ? entry.actorId : key;
    const prev = perActorBest.get(actorId);
    if (!prev || STATUS_RANK.indexOf(entry.status) > STATUS_RANK.indexOf(prev.status)) {
      perActorBest.set(actorId, entry);
    }
    if (!byActor.has(actorId)) byActor.set(actorId, []);
    byActor.get(actorId).push({ sigKey: isPerClient ? key : null, entry });
  }
  return { perActorBest, byActor };
}

export class EncryptionLostError extends Error {
  constructor(groupId) {
    super('E2EE keys lost for this thread. Reset encryption to continue.');
    this.name = 'EncryptionLostError';
    this.groupId = groupId;
  }
}

export class ChatController {
  /**
   * @param {import('./mls/mls-service.js').MLSService} mlsService
   * @param {object} storage - storage implementation
   */
  constructor(mlsService, storage) {
    this.mlsService = mlsService;
    this.storage = storage;
    // Expose storage globally so tests can call it directly (same instance as ctrl.storage)
    window.__chatStorage = storage;
    // messageId → setTimeout handle; cancelled if Read is sent first
    this._pendingAcks = new Map();
    // groupId → setTimeout handle for proposal commit (staggered timer, co-device or non-co-device)
    this._pendingProposalTimers = new Map();
    // Set true while this device is awaiting co-device approval — blocks decryption attempts
    this._awaitingApproval = false;
  }

  // ── Initialization ─────────────────────────────────────

  /**
   * Initialize the controller: init MLS, ensure key package, load groups.
   * Returns the current actor.
   */
  async init() {
    const actor = await getCurrentActor();
    console.log('[ChatController] Initializing for actor:', actor);
    this.currentActorId = actor.id;

    // Store own profile from the (possibly cached) actor object
    await this._saveActorProfileFromAP(actor);

    // Re-fetch own actor in background so avatar/name stay fresh
    this._refreshMyActorProfile(actor.id);

    await this.mlsService.init(actor.id);
    console.log('[ChatController] MLSService initialized for actor:', actor.id);
    let kpResult;
    try {
      kpResult = await this.ensurePublishedKeyPackage(actor);
    } catch (e) {
      console.warn('[init] ensurePublishedKeyPackage failed, continuing:', e);
    }

    // Resume any co-device leave confirmations that survived a restart
    const pendingLeaves = [];
    try {
      const groups = await this.storage.listGroupsWithLastMessage();
      for (const { groupId } of groups) {
        const proposalActivityId = await this.storage.getGroupField(groupId, 'pendingCoDeviceLeave', null);
        if (proposalActivityId) {
          pendingLeaves.push({ type: 'coDeviceLeaving', groupId, proposalActivityId });
        }
      }
    } catch (e) {
      console.warn('[init] Failed to scan for pending co-device leaves:', e);
    }

    return { actor, kpResult, pendingLeaves };
  }

  // ── Group management ───────────────────────────────────

  /**
   * Create a new MLS group with a fresh ID.
   * Returns the groupId.
   */
  async createGroup(ciphersuite = null) {
    const newGroupId = groupUri();
    const actor = await getCurrentActor();
    await this.mlsService.createGroup(actor.id, newGroupId, ciphersuite);
    return newGroupId;
  }

  /**
   * Load all groups with their last displayable message.
   * Sorted by most recent activity.
   */
  async loadGroupList() {
    const groupsWithLast = await this.storage.listGroupsWithLastMessage();
    const hiddenTypes = ['GroupInfo', 'Welcome'];

    const groups = await Promise.all(groupsWithLast.map(async g => {
      let decryptedContent = null;
      let lastMessage = g.lastMessage;

      // If last message is a control message, find the last displayable one
      if (lastMessage?.content && hiddenTypes.includes(lastMessage.content.type)) {
        const displayableMsg = await this.storage.findLastMessageExcludingTypes(g.groupId, hiddenTypes);
        if (displayableMsg) {
          lastMessage = displayableMsg;
          decryptedContent = displayableMsg.content;
        }
      } else if (lastMessage?.content) {
        decryptedContent = lastMessage.content;
      } else if (lastMessage) {
        decryptedContent = lastMessage;
      }

      const members = await this.getGroupMembers(g.groupId);

      return {
        id: g.groupId,
        name: g.name,
        apId: g.apId,
        lastMessage,
        groupState: g.groupState,
        decryptedContent,
        members,
        hasUnread: !!g.groupState?.hasUnread,
      };
    }));

    // Sort by most recent message timestamp (newest first)
    groups.sort((a, b) => {
      const aTime = a.lastMessage?.timestamp || 0;
      const bTime = b.lastMessage?.timestamp || 0;
      return bTime - aTime;
    });

    return groups;
  }

  /**
   * Load messages for a group, filtering out control messages.
   * Returns { messages, members, threadName, threadNameIsAutoGenerated }.
   */
  async loadMessages(groupId) {
    const t0 = performance.now();
    const arr = await this.storage.listMessages(groupId);
    console.log(`[loadMessages] listMessages: ${(performance.now()-t0).toFixed(0)}ms, ${arr.length} msgs`);

    const hiddenTypes = ['GroupInfo', 'Welcome'];
    const messages = arr
      .filter(m => !hiddenTypes.includes(m.content?.type))
      .map(m => ({
        ...(typeof m.content === 'object' && m.content !== null ? m.content : { content: m.content }),
        id: m.id,
        timestamp: m.timestamp,
        isLocal: m.isLocal,
        deliveryStatus: m.deliveryStatus || null,
        editedAt: m.editedAt || null,
        isRead: m.isRead ?? m.isLocal ?? false,
        attributedTo: m.content?.attributedTo,
        reactions: m.reactions || {},
      }));
    // Log any messages with suspiciously large inline content (may cause render freeze)
    messages.forEach(m => {
      const atts = m.attachment || (m.type === 'Image' || m.type === 'Video' || m.type === 'Audio' || m.type === 'Document' ? [m] : []);
      atts.forEach(a => {
        if (a.content && a.content.length > 10000) {
          console.warn(`[loadMessages] large inline attachment content: msg=${m.id} type=${a.type} size=${(a.content.length/1024).toFixed(0)}KB`);
        }
        if (a._thumbDataUrl && a._thumbDataUrl.length > 50000) {
          console.warn(`[loadMessages] large _thumbDataUrl: msg=${m.id} size=${(a._thumbDataUrl.length/1024).toFixed(0)}KB`);
        }
      });
    });
    console.log(`[loadMessages] map+filter: ${(performance.now()-t0).toFixed(0)}ms`);

    const t1 = performance.now();
    let members = await this.getGroupMembers(groupId);
    console.log(`[loadMessages] getGroupMembers: ${(performance.now()-t1).toFixed(0)}ms`);

    // Determine thread name
    let threadName = '';
    let threadNameIsAutoGenerated = false;

    const firstMessageWithName = messages.find(m => m.name);
    if (firstMessageWithName?.name) {
      threadName = firstMessageWithName.name;
      await this.storage.setGroupField(groupId, 'name', threadName);
    } else {
      const rec = await this.storage.loadGroupMeta(groupId);
      const existingName = rec?.name;
      const topLevelName = await this._getGroupName(groupId);
      const name = topLevelName || existingName;

      if (name) {
        threadName = name;
      } else if (members.length > 0) {
        const otherMembers = members.filter(id => id !== this.currentActorId);
        if (otherMembers.length > 0) {
          threadName = otherMembers.map(id => this.getActorNickname(id)).join(', ');
          threadNameIsAutoGenerated = true;
        }
      }
    }
    console.log(`[loadMessages] threadName: ${(performance.now()-t0).toFixed(0)}ms`);

    // Check if MLS encryption state is available
    const t2 = performance.now();
    const actor = await getCurrentActor().catch(() => null);
    const meta = (await this.storage.loadGroupMeta(groupId)) || {};
    const noLongerMember = !!(meta.noLongerMember || meta.left); // meta.left: legacy field name
    let encryptionAvailable = false;
    if (actor && !noLongerMember) {
      const { found } = await this.mlsService.getGroup(actor.id, groupId).catch(() => ({ found: false }));
      encryptionAvailable = found;
    }
    console.log(`[loadMessages] getGroup (MLS): ${(performance.now()-t2).toFixed(0)}ms, total: ${(performance.now()-t0).toFixed(0)}ms`);

    return { messages, members, threadName, threadNameIsAutoGenerated, encryptionAvailable, noLongerMember };
  }

  /**
   * Resolve a deep link (ap-mls://, mls://) to a { groupId, scrollToMsgId } pair.
   */
  async resolveDeepLink(rawUrl) {
    const toApId = (u) => u?.startsWith('ap-mls://') ? 'https://' + u.slice('ap-mls://'.length) : null;
    const apId = toApId(rawUrl);
    if (apId) {
      const groupId = await this.storage.getGroupByField('apId', apId);
      if (groupId) return { groupId };
      const msg = await this.storage.getMessageByApId(apId);
      if (msg) return { groupId: msg.groupId, scrollToMsgId: msg.id };
    } else if (rawUrl?.startsWith('mls://m/')) {
      const msg = await this.storage.getMessage(rawUrl);
      if (msg) return { groupId: msg.groupId, scrollToMsgId: msg.id };
    }
    return { groupId: rawUrl };
  }

  /**
   * Get MLS group fingerprints (member devices) for the members panel.
   */
  async markMessageRead(messageId, groupId) {
    await this.storage.markMessageRead(messageId);
    // Clear group unread flag if no unread messages remain
    const remaining = await this.storage.listMessages(groupId);
    const hasUnread = remaining.some(m => !m.isRead);
    if (!hasUnread) {
      const meta = (await this.storage.loadGroupMeta(groupId)) || {};
      if (meta.hasUnread) await this.storage.saveGroupMeta(groupId, { ...meta, hasUnread: false });
    }

    // Send Read receipt only if opted in (global or per-group override).
    // Cancel any pending debounced Acknowledge — Read implies Acknowledge.
    const actor = await getCurrentActor();
    const msg = await this.storage.getMessage(messageId);
    const msgType = msg?.content?.type;
    const isSendableText = msg && !msg.isLocal
      && !msg.content?.error
      && TEXT_RECEIPT_TYPES.has(msgType);
    if (isSendableText) {
      if (this._pendingAcks.has(messageId)) {
        clearTimeout(this._pendingAcks.get(messageId));
        this._pendingAcks.delete(messageId);
      }
      const groupOverride = await this.storage.getGroupField(groupId, 'readReceiptsOverride', null);
      const globalEnabled = await this.storage.loadUserSetting(actor.id, 'sendReadReceipts', false);
      const enabled = groupOverride !== null ? groupOverride : globalEnabled;
      if (enabled) await this._sendReceipt(groupId, 'Read', messageId);
    }
  }

  async _sendReceipt(groupId, type, messageId) {
    const actor = await getCurrentActor();
    const { recipients, apId } = await this._groupSendContext(groupId, actor);
    await this._sendEncryptedActivity(groupId, { type, id: messageUri(), object: messageId }, recipients, apId);
  }

  async markMessageListened(messageId, groupId) {
    await this._sendReceipt(groupId, 'Listen', messageId);
  }

  async markMessageViewed(messageId, groupId) {
    await this._sendReceipt(groupId, 'View', messageId);
  }

  async getGroupFingerprints(groupId) {
    const actor = await getCurrentActor();
    return this.mlsService.getGroupFingerprints(actor.id, groupId);
  }

  /**
   * Build a nested thread tree from flat messages.
   * Each root node gets a `lastMessage` (the newest message in its subtree).
   * Replies are sorted chronologically; roots are sorted by newest activity.
   */
  buildThreadTree(messages) {
    const messageMap = new Map();
    const rootMessages = [];

    messages.forEach(msg => {
      if (msg?.id) messageMap.set(msg.id, { ...msg, replies: [] });
    });

    messages.forEach(msg => {
      if (!msg?.id) return;
      const node = messageMap.get(msg.id);
      const parent = msg.inReplyTo ? messageMap.get(msg.inReplyTo) : null;
      if (parent) {
        parent.replies.push(node);
      } else {
        rootMessages.push(node);
      }
    });

    const sortByTime = (a, b) => (a.timestamp || 0) - (b.timestamp || 0);
    const sortReplies = (node) => {
      if (node.replies.length > 0) {
        node.replies.sort(sortByTime);
        node.replies.forEach(sortReplies);
      }
    };
    rootMessages.forEach(sortReplies);

    // Attach lastMessage to each root (newest message in subtree)
    for (const root of rootMessages) {
      root.lastMessage = this._newestMessage(root);
    }

    // Sort roots by most recent activity (newest last)
    rootMessages.sort((a, b) =>
      (a.lastMessage?.timestamp || 0) - (b.lastMessage?.timestamp || 0)
    );

    return rootMessages;
  }

  _newestMessage(node) {
    let newest = node;
    if (node.replies) {
      for (const reply of node.replies) {
        const candidate = this._newestMessage(reply);
        if ((candidate.timestamp || 0) > (newest.timestamp || 0)) {
          newest = candidate;
        }
      }
    }
    return newest;
  }

  async _getGroupName(groupId) {
    return this.storage.getGroupField(groupId, 'name', null);
  }

  async getGroupMembers(groupId) {
    // Ensure the group is loaded into Rust memory (loads from SQLite if needed)
    const actor = await getCurrentActor();
    await this.mlsService.getGroup(actor.id, groupId).catch(() => {});
    // Use lightweight identity-only command (no fingerprint hashing)
    try {
      const identities = await this.mlsService.getGroupMemberIdentities(groupId);
      if (identities && identities.length > 0) {
        return identities;
      }
    } catch (_) {}
    const state = (await this.storage.loadGroupMeta(groupId)) || {};
    return state.members || [];
  }

  async persistMembers(groupId, members, { replace = false } = {}) {
    const state = (await this.storage.loadGroupMeta(groupId)) || {};
    const existing = replace ? [] : (state.members || []);
    const nextMembers = uniqueActors([...existing, ...(members || [])]);
    await this.storage.saveGroupMeta(groupId, { ...state, members: nextMembers });
    return nextMembers;
  }

  async setGroupName(groupId, name) {
    await this.storage.setGroupField(groupId, 'name', name);
  }

  /**
   * Re-read group membership from MLS state and persist.
   * Called after processing an incoming Commit so stored members stay in sync.
   */
  async _syncMembersFromMLS(groupId, actor, removerActorId = null) {
    try {
      const fingerprints = await this.mlsService.getGroupFingerprints(actor.id, groupId);
      const identities = [...new Set(fingerprints.map(fp => fp.identity).filter(Boolean))];
      if (identities.length === 0) return;
      // Persist signature keys to cache so endorsement verification works after members leave
      for (const fp of fingerprints) {
        if (fp.identity && fp.signatureKey) {
          await this.storage.saveMlsKnownKey(fp.identity, fp.signatureKey);
        }
      }
      const state = (await this.storage.loadGroupMeta(groupId)) || {};
      const previous = new Set(state.members || []);
      // sigKeys: array of { signatureKey, identity } for device-level diffing
      const previousDevices = new Map((state.sigKeys || []).map(d => [d.signatureKey, d.identity]));
      const currentDevices = new Map(
        fingerprints.filter(fp => fp.signatureKey && fp.identity).map(fp => [fp.signatureKey, fp.identity])
      );
      await this.storage.saveGroupMeta(groupId, {
        ...state, members: identities,
        sigKeys: [...currentDevices.entries()].map(([signatureKey, identity]) => ({ signatureKey, identity }))
      });
      // Only insert system messages if we had a known member list to diff against
      if (previous.size === 0) return;
      const current = new Set(identities);
      const removerNickname = removerActorId ? await this._getNickname(removerActorId) : null;

      // Member-level diff
      for (const id of identities) {
        if (!previous.has(id) && id !== actor.id) {
          await this._insertSystemMessage(groupId, `${await this._getNickname(id)} was added to the group`);
        }
      }
      for (const id of previous) {
        if (!current.has(id) && id !== actor.id) {
          const nickname = await this._getNickname(id);
          const isSelfLeave = id === removerActorId;
          const msg = isSelfLeave
            ? `${nickname} left the group`
            : removerNickname
              ? `${nickname} was removed by ${removerNickname}`
              : `${nickname} was removed from the group`;
          await this._insertSystemMessage(groupId, msg);
        }
      }

      // Device-level diff — only for members already in the group (not new joiners)
      if (previousDevices.size > 0) {
        for (const fp of fingerprints) {
          if (!fp.signatureKey || !fp.identity) continue;
          if (!previousDevices.has(fp.signatureKey) && current.has(fp.identity) && previous.has(fp.identity)) {
            const emoji = fp.fingerprint?.map(e => e.emoji).join(' ') || '';
            const isSelf = fp.identity === actor.id;
            const subject = isSelf ? 'You are' : `${await this._getNickname(fp.identity)} is`;
            await this._insertSystemMessage(groupId, `${subject} now receiving messages with a new device: ${emoji}`);
          }
        }
        for (const [sigKey, identity] of previousDevices) {
          if (!currentDevices.has(sigKey) && current.has(identity) && previous.has(identity)) {
            const isSelf = identity === actor.id;
            const subject = isSelf ? 'One of your devices' : `A device of ${await this._getNickname(identity)}`;
            await this._insertSystemMessage(groupId, `${subject} was removed from the group`);
          }
        }
      }

      // Check if we ourselves were removed (actor-level: all our devices gone)
      if (previous.has(actor.id) && !current.has(actor.id)) {
        await this._insertSystemMessage(groupId, `${removerNickname || 'Someone'} removed you from this group.`);
        await this.mlsService.deleteGroup(actor.id, groupId);
        await this.storage.setGroupField(groupId, 'noLongerMember', true);
      } else if (previous.has(actor.id) && current.has(actor.id) && previousDevices.size > 0) {
        // Co-device case: actor still has other devices in the group, but THIS device was removed
        const ownSigKey = await this.mlsService.getOwnSignatureKey(actor.id).catch(() => null);
        if (ownSigKey && previousDevices.has(ownSigKey) && !currentDevices.has(ownSigKey)) {
          const isSelfRemove = !removerActorId || removerActorId === actor.id;
          const msg = isSelfRemove ? 'This device was decommissioned.' : `${removerNickname} removed this device from the group.`;
          await this._insertSystemMessage(groupId, msg);
          await this.mlsService.deleteGroup(actor.id, groupId);
          await this.storage.setGroupField(groupId, 'noLongerMember', true);
        }
      }
    } catch (e) {
      console.warn('[_syncMembersFromMLS] Failed:', e);
    }
  }

  // ── System messages ───────────────────────────────────

  async _insertSystemMessage(groupId, text, { relatedMessageId } = {}) {
    const id = `system-${Date.now()}`;
    await this.storage.saveMessage(groupId, {
      type: 'system',
      content: text,
      ...(relatedMessageId ? { relatedMessageId } : {}),
    }, id, true);
  }

  /**
   * Reset a group whose MLS state was lost.
   * Re-creates the group and re-invites all previous members.
   */
  async resetGroup(groupId) {
    const actor = await getCurrentActor();
    const members = await this.getGroupMembers(groupId);
    const otherMembers = members.filter(m => m !== actor.id);

    // Delete old group state before re-creating
    await this.mlsService.deleteGroup(actor.id, groupId);
    await this.mlsService.createGroup(actor.id, groupId);

    // Re-invite previous members — use AP ID if available
    let apId = await this.storage.getGroupField(groupId, 'apId', null);
    const reinvited = [];

    for (const recipient of otherMembers) {
      try {
        const kpBytes = await this.fetchLatestKeyPackage(recipient);
        if (!kpBytes) continue;
        const { welcome, ratchetTree } = await this.mlsService.addMember(actor.id, groupId, kpBytes);
        apId = await this._sendInvite(actor, groupId, recipient, welcome, ratchetTree, apId);
        reinvited.push(recipient);
      } catch (err) {
        console.error('[resetGroup] Failed to re-invite', recipient, err);
      }
    }

    // Restore member list (createGroup overwrites group meta, clearing members)
    if (reinvited.length > 0) {
      await this.persistMembers(groupId, [actor.id, ...reinvited], { replace: true });
    }

    const msg = reinvited.length === otherMembers.length
      ? 'Encryption keys were reset. All members have been re-invited.'
      : `Encryption keys were reset. Re-invited ${reinvited.length}/${otherMembers.length} members.`;
    await this._insertSystemMessage(groupId, msg);
  }

  /**
   * Send Welcome to a recipient.
   * Returns the (possibly updated) apId.
   */
  async _sendInvite(actor, groupId, recipient, welcomeBytes, ratchetTreeBytes, apId, { usePrefix = false } = {}) {
    const welcomeRes = await sendMLSControl(actor, 'Welcome', bytesToBase64(welcomeBytes), [recipient], apId || null, this.storage, { usePrefix });
    if (!apId) {
      apId = await this._resolveApId(welcomeRes);
      if (apId) {
        await this.storage.setGroupField(groupId, 'apId', apId);
        console.log('[_sendInvite] Stored group AP ID from Welcome:', apId);
      }
    }
    // Per RFC 9420, GroupInfo seems only needed for External Joins (§12.4.3.2), not
    // Welcome-based invites. The ratchet tree is already embedded in our Welcome bytes
    // via use_ratchet_tree_extension(true). Kept commented for backward compat with
    // older Bonfire clients that haven't yet been updated to join from Welcome alone.
    // await sendMLSControl(actor, 'GroupInfo', bytesToBase64(ratchetTreeBytes), [recipient], apId || null, this.storage);
    return apId;
  }

  // ── Sending ────────────────────────────────────────────

  /**
   * Send a message in an existing group.
   *
   * @param {string} groupId
   * @param {object} msgObj - message content (type, content, summary, etc.)
   * @param {object} [options]
   * @param {string} [options.inReplyTo] - reply-to ID
   * @returns {string|null} AP message ID
   */
  /**
   * Encrypt, transmit, and persist an encrypted message.
   * Handles pending/failed state for retry support.
   *
   * @param {string} groupId - MLS group ID
   * @param {object} msgObj - message content
   * @param {object} [options]
   * @param {boolean} [options.isNewThread] - true for first message in thread
   * @param {string} [options.inReplyTo] - reply-to ID
   * @returns {string|null} AP message ID
   */
  async _transmitEncrypted(groupId, msgObj, { isNewThread = false, inReplyTo, usePrefix = false, overrides = {} } = {}) {
    const actor = await getCurrentActor();

    // Generate client-side message ID and embed in content before encryption
    const msgId = messageUri();
    const contentWithId = { ...msgObj, id: msgId };

    // Collect attachment IDs from the content tree, then strip internal-only fields
    const attachmentIds = _collectAttachmentIds(contentWithId);
    const INTERNAL_FIELDS = new Set(['_attachmentId', '_localPath', '_thumbDataUrl', '_senderClientKey']);
    const cleanContent = attachmentIds.length
      ? JSON.parse(JSON.stringify(contentWithId, (k, v) => INTERNAL_FIELDS.has(k) ? undefined : v))
      : contentWithId;

    // Encrypt — Rust sanitizes HTML, substitutes attachment placeholders, returns { pendingId, plaintext }
    const { pendingId, plaintext: encryptedObj } = await this.mlsService.encrypt(actor.id, groupId, cleanContent, attachmentIds);
    // Re-add display-only fields stripped before encryption (needed for local render: thumbnails, paths)
    const storedObj = { ...encryptedObj, _localPath: msgObj._localPath, _thumbDataUrl: msgObj._thumbDataUrl };

    // Get recipients and AP context ID
    const members = await this.getGroupMembers(groupId);
    const recipients = members.length > 0 ? members : [actor.id];
    const apId = await this.storage.getGroupField(groupId, 'apId', null);
    console.log('[_transmitEncrypted] apId:', apId, 'groupId:', groupId, 'msgId:', msgId);

    // Build AP body with pendingId as content placeholder — Rust substitutes before sending
    const apBody = buildPrivateMessageBody(actor, pendingId, recipients, apId || null, {
      isNewThread,
      inReplyTo: inReplyTo || apId || null,
      usePrefix,
      overrides,
    });

    // Save optimistically with the actual object that was encrypted (sanitized content + display fields)
    await this.storage.saveMessage(groupId, { ...storedObj, status: 'sending' }, msgId, true);

    try {
      await ensureFreshToken();
      const accessToken = localStorage.getItem('access_token');
      const res = await this.mlsService.sendMessage(pendingId, actor.outbox, accessToken, apBody);

      if (!res?.ok) {
        throw new Error('Failed to send encrypted message: ' + (res?.error || res?.status || 'unknown'));
      }

      // Extract server-assigned AP IDs from response
      const messageApId = extractApIdFromResponse(res);
      const serverContext = res?.object?.context || res?.context;

      // Initialize per-recipient delivery status (all 'sent') and confirm the message
      const otherRecipients = recipients.filter(r => r !== actor.id);
      const deliveryStatus = otherRecipients.length > 0
        ? Object.fromEntries(otherRecipients.map(r => [r, { status: 'sent' }]))
        : null;
      await this.storage.saveMessage(groupId, storedObj, msgId, true, messageApId || undefined, deliveryStatus);
      console.log('[_transmitEncrypted] Confirmed message:', msgId, 'apId:', messageApId, 'in group:', groupId);

      // Mark the activity ID or object ID as processed so pollInbox won't reprocess the echo
      const activityApId = res?.id;
      if (activityApId) {
        await this.storage.markProcessed(actor.id, activityApId);
      } else {
        if (messageApId) await this.storage.markProcessed(actor.id, messageApId);
      }

      // Store group apId mapping if not yet set
      if (!apId && serverContext) {
        await this.storage.setGroupField(groupId, 'apId', serverContext);
        console.log('[_transmitEncrypted] Stored group apId mapping:', groupId, '→', serverContext);
      }

      return msgId;
    } catch (e) {
      await this.mlsService.discardMessage(pendingId);
      const errStr = typeof e === 'string' ? e : (e.message || String(e));
      console.error('[_transmitEncrypted] Failed to send, saving as failed:', errStr);
      await this.storage.saveMessage(groupId, { ...storedObj, status: 'failed', error: errStr }, msgId, true);
      throw e;
    }
  }

  /** Build a Note AP object from raw user input fields. */
  async _buildNoteObject({ name, summary, content, inReplyTo, attachments } = {}) {
    const actor = await getCurrentActor();
    const obj = { type: 'Note', content: content.trim(), attributedTo: actor.id };
    if (name?.trim()) obj.name = name.trim();
    if (summary?.trim()) obj.summary = summary.trim();
    if (inReplyTo) obj.inReplyTo = inReplyTo;
    if (attachments?.length) obj.attachment = attachments;
    return obj;
  }

  /**
   * Send a message. If `recipients` are provided, creates a new group first.
   * Returns `{ groupId, messageApId?, errors? }`.
   *
   * @param {string|null} groupId - existing group, or null to create a new one
   * @param {{ name?, summary?, content, inReplyTo?, attachments?, type? }} fields - message content
   * @param {string[]} [recipients] - webfinger mentions or URIs (new group only)
   */
  async sendMessage(groupId, { name, summary, content, inReplyTo, attachments, type, usePrefix = false, overrides = {} } = {}, recipients = []) {
    const actor = await getCurrentActor();

    // Single media file with no text → top-level typed object (Image/Audio/Video)
    // Multiple files or files+text → Note with attachment array
    // Explicit type (e.g. 'Article') → override type on the built object
    let msgObj;
    if (!content?.trim() && attachments?.length === 1) {
      const att = attachments[0];
      msgObj = { ...att, attributedTo: actor.id };
      if (summary?.trim()) msgObj.summary = summary.trim();
      if (inReplyTo) msgObj.inReplyTo = inReplyTo;
    } else {
      msgObj = await this._buildNoteObject({ name, summary, content, inReplyTo, attachments });
      if (type && type !== 'Note') msgObj.type = type;
    }

    if (recipients.length > 0) {
      // New group flow — ciphersuite negotiation and MLS group creation happen inside _sendFirstMessage
      if (!groupId) groupId = groupUri();
      const { messageApId, errors } = await this._sendFirstMessage(groupId, msgObj, recipients);
      return { groupId, messageApId, errors };
    }

    // Existing group flow
    console.log('[sendMessage] groupId:', groupId);
    const { found } = await this.mlsService.getGroup(actor.id, groupId);
    if (!found) throw new EncryptionLostError(groupId);

    const messageApId = await this._transmitEncrypted(groupId, msgObj, { inReplyTo, usePrefix, overrides });
    return { groupId, messageApId };
  }

  /**
   * Retry sending a previously failed message.
   */
  async retrySendMessage(messageId) {
    const rec = await this.storage.getMessage(messageId);
    if (!rec) throw new Error('Message not found');

    const { groupId, content } = rec;
    const { status, error, ...msgObj } = content;
    await this.storage.deleteMessage(messageId);
    // Re-send using the already-built msgObj (type/attributedTo already set)
    const actor = await getCurrentActor();
    const { found } = await this.mlsService.getGroup(actor.id, groupId);
    if (!found) throw new EncryptionLostError(groupId);
    return this._transmitEncrypted(groupId, msgObj, { inReplyTo: msgObj.inReplyTo });
  }

  /**
   * Send the first message in a new thread.
   * Handles: resolving recipients, fetching key packages, inviting, Welcome/GroupInfo, encrypt+transmit.
   * @private
   */
  async _sendFirstMessage(groupId, msgObj, recipientMentions) {
    const actor = await getCurrentActor();
    const currentDomain = new URL(actor.id).hostname;

    const toUris = (await Promise.all(
      recipientMentions.map(s => resolveActorId(s, currentDomain))
    )).filter(Boolean);

    if (msgObj.name) {
      await this.storage.setGroupField(groupId, 'name', msgObj.name);
    }

    const initialMembers = uniqueActors([actor.id, ...toUris]);

    // Fetch all key packages per recipient to determine a common ciphersuite
    const recipientKpSets = await Promise.all(
      toUris.map(async uri => {
        const kps = await fetchAllActorKeyPackages(uri);
        return { uri, kps };
      })
    );

    // Only include members whose KPs declare a ciphersuite in the negotiation.
    // Members with undeclared KPs are attempted anyway — Rust will reject incompatible ones per-recipient.
    const suiteSetsForNegotiation = recipientKpSets
      .map(({ kps }) => kps.map(kp => kp.ciphersuite?.identifier).filter(Boolean))
      .filter(suites => suites.length > 0);

    const chosenSuite = suiteSetsForNegotiation.length > 0
      ? await this.mlsService.bestCommonCiphersuite(suiteSetsForNegotiation)
      : null;

    // Create the group with the negotiated suite (null = Rust default, i.e. MTI 0x0001)
    await this.mlsService.createGroup(actor.id, groupId, chosenSuite);

    // Save initial members list after createGroup (which wipes group meta state)
    await this.persistMembers(groupId, initialMembers);

    // Invite each recipient using a KP matching the chosen suite where possible
    const successfulInvites = [];
    const errors = [];
    let apId = await this.storage.getGroupField(groupId, 'apId', null);

    for (const { uri: recipient, kps } of recipientKpSets) {
      try {
        // Prefer a KP matching the chosen suite; for undeclared KPs just attempt and let Rust validate
        const matchingKp = chosenSuite != null
          ? kps.find(kp => kp.ciphersuite?.identifier === chosenSuite) ?? kps.find(kp => !kp.ciphersuite)
          : kps[0];
        const kpBytes = matchingKp
          ? bytesFromInput(matchingKp.content)
          : await this.fetchLatestKeyPackage(recipient);
        if (!kpBytes) {
          errors.push(`No KeyPackage for ${recipient}`);
          continue;
        }

        const { welcome, ratchetTree } = await this.mlsService.addMember(actor.id, groupId, kpBytes);
        apId = await this._sendInvite(actor, groupId, recipient, welcome, ratchetTree, apId);
        successfulInvites.push(recipient);
      } catch (err) {
        console.error('Failed to invite', recipient, err);
        errors.push(`Failed to invite ${recipient}: ${err.message}`);
      }
    }

    // Update members if some invites failed
    if (successfulInvites.length !== toUris.length) {
      const finalMembers = uniqueActors([actor.id, ...successfulInvites]);
      await this.persistMembers(groupId, finalMembers);
    }

    // Encrypt and send (with pending/failed handling)
    const messageApId = await this._transmitEncrypted(groupId, msgObj, { isNewThread: true });

    return { messageApId, errors };
  }

  // ── Receiving ──────────────────────────────────────────

  async fetchActorKeyPackages(actorId) {
    const kps = await fetchAllActorKeyPackages(actorId);
    return (kps ?? []).map(kp => ({
      kpB64: kp.content,
      mlsSignature: kp.mlsSignature ?? null,
      mlsSignerKeyId: kp.mlsSignerKeyId ?? null,
    }));
  }

  /**
   * Poll inbox and process new activities.
   */
  async pollInbox() {
    try {
      const actor = await getCurrentActor();
      const { fetchInboxItems } = await import('./activitypub/client.js');
      const items = await fetchInboxItems(actor);
      console.log('[pollInbox] Fetched', items.length, 'inbox items');

      // Process oldest-first so group joins happen before messages
      const itemsToProcess = [...items].reverse();
      const results = [];
      // Proposals deferred until all other activities in this batch are processed,
      // so any Commit for the same epoch is applied first
      const deferredProposals = [];

      for (const item of itemsToProcess) {
        const itemId = item.id || item.object?.id;
        if (!itemId) continue;

        if (await this.storage.isProcessed(actor.id, itemId)) {
          console.log('[pollInbox] Already processed:', itemId);
          continue;
        }

        console.log('[pollInbox] Processing item:', itemId, 'type:', item.type || item.object?.type);
        try {
          const result = await this.handleActivity(item);
          await this.storage.markProcessed(actor.id, itemId);
          if (result?.proposalBuffered) {
            // Defer — process after all commits in this batch have been applied
            deferredProposals.push({ item, result });
          } else if (result) {
            results.push(result);
          }
        } catch (itemErr) {
          console.error('[pollInbox] Failed to process item:', itemId, itemErr);
          await this.storage.markProcessed(actor.id, itemId);
        }
      }

      // Second pass: handle buffered proposals now that any Commits in this batch are applied
      for (const { result } of deferredProposals) {
        const { groupId, parsed } = result._deferred;
        try {
          const r = await this._handleProposal(groupId, parsed, actor, /* alreadyDecrypted */ true);
          if (r) results.push(r);
        } catch (e) {
          console.warn('[pollInbox] Deferred proposal handling failed:', e);
        }
      }

      console.log('[pollInbox] Processed', results.length, 'new items');
      return results;
    } catch (e) {
      console.error('[Inbox] Error polling inbox:', e);
      return [];
    }
  }

  /**
   * Handle a single incoming activity.
   * Routes to Welcome, GroupInfo, or PrivateMessage handler.
   *
   * @returns {{ type: string, groupId: string }|null}
   */
  async handleActivity(activity) {
    // Failure receipt (type may be "Failure" or ["PrivateMessage", "Failure"], possibly wrapped in Create)
    const obj = activity?.object || activity;
    const objTypes = Array.isArray(obj?.type) ? obj.type : [obj?.type];
    if (objTypes.includes('Failure')) {
      return this._handleFailureReceipt(obj);
    }

    // Co-device KeyPackage proposal: NewDeviceB sends Create { object: KeyPackage } to own actor inbox
    if (activity.type === 'Create' && hasType(activity.object, 'KeyPackage')) {
      const actor = await getCurrentActor();
      if (activity.object?.attributedTo === actor.id) {
        return this._handleKeyPackageProposal(activity.object, actor);
      }
    }

    // Add { object: KeyPackage } from actor's keyPackages collection — verify mlsSignature before caching.
    // Per spec, object may be a URL string; detect via target URL or inline type.
    if (activity.type === 'Add') {
      const target = typeof activity.target === 'string' ? activity.target : activity.target?.id;
      const actor = await getCurrentActor().catch(() => null);
      const kpCollUrl = typeof actor?.keyPackages === 'string' ? actor.keyPackages : actor?.keyPackages?.id;
      const isKpAdd = (kpCollUrl && target === kpCollUrl) || hasType(activity.object, 'KeyPackage');
      if (isKpAdd) return this._handleKeyPackageAdd(activity);
    }

    const parsed = parseMLSActivity(activity);
    if (!parsed) return null;

    const actor = await getCurrentActor();
    console.log('[handleActivity] type:', parsed.type, 'id:', parsed.id, 'from:', parsed.attributedTo, 'context:', parsed.context);

    const contextId = parsed.context;

    // Resolve MLS group ID (ULID) from AP context URI
    let groupId = await this.storage.getGroupByField('apId', contextId);

    // Fallback: look up via inReplyTo — the reply may reference a message we already stored
    if (!groupId && parsed.inReplyTo) {
      const parentMsg = await this.storage.getMessage(parsed.inReplyTo);
      if (parentMsg) {
        groupId = parentMsg.groupId;
        // Store the mapping so future messages with this context resolve directly
        if (isApUri(contextId)) {
          await this.storage.setGroupField(groupId, 'apId', contextId);
        }
        console.log('[handleActivity] Resolved groupId via inReplyTo:', parsed.inReplyTo, '→', groupId);
      }
    }

    // Fallback: for PrivateMessages, extract the MLS group_id from the ciphertext header
    if (!groupId && parsed.type === 'PrivateMessage') {
      try {
        const ciphertextBytes = bytesFromInput(parsed.content);
        const mlsGroupId = await this.mlsService.extractGroupId(ciphertextBytes);
        if (mlsGroupId) {
          groupId = mlsGroupId;
          // Store the mapping so future messages resolve directly
          if (isApUri(contextId)) {
            await this.storage.setGroupField(groupId, 'apId', contextId);
          }
          console.log('[handleActivity] Resolved groupId from ciphertext MLS header:', mlsGroupId);
        }
      } catch (e) {
        console.warn('[handleActivity] Could not extract group_id from ciphertext:', e);
      }
    }

    // For Welcome/GroupInfo we may not know the ULID yet — use contextId as temporary key.
    // _tryJoinGroup will migrate to the actual ULID after processing the Welcome.
    if (!groupId) groupId = contextId;
    console.log('[handleActivity] contextId:', contextId, '→ resolved groupId:', groupId);

    if (!groupId) {
      console.warn('[handleActivity] Could not resolve groupId for', parsed.type, parsed.id, '— skipping');
      return null;
    }

    if (parsed.type === 'Welcome') {
      return this._handleWelcome(groupId, parsed, actor);
    } else if (parsed.type === 'GroupInfo') {
      return this._handleGroupInfo(groupId, parsed, actor);
    } else if (parsed.type === 'PrivateMessage') {
      // Do not skip here when _awaitingApproval — Commits and Proposals must still be processed.
      // ApplicationMessage content is skipped inside _handlePrivateMessage after decryption.
      return this._handlePrivateMessage(groupId, parsed, actor);
    } else if (parsed.type === 'PublicMessage') {
      if (this._awaitingApproval) {
        console.log('[handleActivity] Skipping PublicMessage — awaiting co-device approval');
        return null;
      }
      return this._handlePublicMessage(groupId, parsed, actor);
    }

    return null;
  }

  async _handleWelcome(groupId, parsed, actor) {
    const welcomeBytes = bytesFromInput(parsed.content);
    const state = (await this.storage.loadGroupMeta(groupId)) || {};

    // If already joined, this Welcome is from a new sequence (reset/re-invite)
    // — the old ratchetTree is stale and must not be paired with this Welcome
    const nextState = { ...state, welcome: Array.from(welcomeBytes) };
    if (state.joined) {
      delete nextState.ratchetTree;
      nextState.joined = false;
    }
    await this.storage.saveGroupMeta(groupId, nextState);

    // Try joining immediately. Some senders (e.g. Emissary) embed the ratchet
    // tree inside the Welcome bytes (RFC 9420 §12.4.3.3), so ratchetTree can be null.
    // If a separate GroupInfo was already received, use its tree bytes.
    // If joining fails because the tree is not embedded and no GroupInfo has arrived yet,
    // we keep the saved welcome bytes and wait — _handleGroupInfo will complete the join.
    const ratchetTree = nextState.ratchetTree ? Uint8Array.from(nextState.ratchetTree) : null;
    let finalGroupId = groupId;
    try {
      // If we were removed or left intentionally, the Rust MLS state was already deleted by
      // _syncMembersFromMLS / leaveGroup. The first joinFromWelcome is genuine — don't delete+retry.
      // noLongerMember/left are stored at the IndexedDB record's top level (via setGroupField),
      // not inside rec.state — so we must read them via getGroupField, not via loadGroupMeta.
      const _nlm = state.noLongerMember || await this.storage.getGroupField(groupId, 'noLongerMember', false);
      const _left = state.left || await this.storage.getGroupField(groupId, 'left', false);
      const wasJoined = !!state.joined && !_nlm && !_left;
      finalGroupId = await this._tryJoinGroup(actor, groupId, welcomeBytes, ratchetTree, parsed, { wasJoined });
    } catch (e) {
      // Tree not embedded and no GroupInfo yet — wait for separate GroupInfo (old clients)
      console.warn('[_handleWelcome] Could not join yet (no ratchet tree), waiting for GroupInfo:', e?.message ?? e);
    }

    return { type: 'welcome', groupId: finalGroupId };
  }

  async _handleGroupInfo(groupId, parsed, actor) {
    const ratchetTreeBytes = bytesFromInput(parsed.content);
    const state = (await this.storage.loadGroupMeta(groupId)) || {};

    // If already joined, this GroupInfo is from a new sequence (reset/re-invite)
    // — the old welcome is stale and must not be paired with this GroupInfo
    const nextState = { ...state, ratchetTree: Array.from(ratchetTreeBytes) };
    if (state.joined) {
      delete nextState.welcome;
      nextState.joined = false;
    }
    await this.storage.saveGroupMeta(groupId, nextState);

    let finalGroupId = groupId;
    if (nextState.welcome) {
      const _nlm = state.noLongerMember || await this.storage.getGroupField(groupId, 'noLongerMember', false);
      const _left = state.left || await this.storage.getGroupField(groupId, 'left', false);
      const wasJoined = !!state.joined && !_nlm && !_left;
      finalGroupId = await this._tryJoinGroup(actor, groupId, Uint8Array.from(nextState.welcome), ratchetTreeBytes, parsed, { wasJoined });
    }

    return { type: 'groupinfo', groupId: finalGroupId };
  }

  /**
   * Join a group from Welcome + RatchetTree.
   *
   * Returns the canonical group ID (the sender's ULID from the Welcome).
   * If the passed groupId was a temporary URI, migrates metadata to the ULID
   * and stores the URI→ULID mapping.
   *
   * @param {object} opts
   * @param {boolean} opts.wasJoined - true if we were already a member (re-invite); deletes
   *   stale state before joining. False for a first join — do NOT delete until we know
   *   the Welcome is for this device, to avoid destroying state on echoed Welcome activities.
   */
  async _tryJoinGroup(actor, groupId, welcomeBytes, ratchetTreeBytes, parsed, { wasJoined = false } = {}) {
    // Strategy: always try joining WITHOUT deleting first.
    // - NoMatchingKeyPackage → Welcome is not for this device (co-device Welcome CC'd back,
    //   or echo); bail without touching group state.
    // - Success when wasJoined → Rust silently no-op'd on the stale group; delete and retry
    //   so the epoch actually advances.
    // - Success when !wasJoined → genuine first join.
    let actualGroupId;
    try {
      actualGroupId = await this.mlsService.joinFromWelcome(actor.id, groupId, welcomeBytes, ratchetTreeBytes);
      if (wasJoined) {
        // No-op'd on old group — delete stale state and rejoin to advance epoch
        await this.mlsService.deleteGroup(actor.id, groupId);
        actualGroupId = await this.mlsService.joinFromWelcome(actor.id, groupId, welcomeBytes, ratchetTreeBytes);
      }
      // Successfully joined — no longer awaiting approval
      this._awaitingApproval = false;
    } catch (e) {
      if (String(e).includes('NoMatchingKeyPackage')) {
        // Welcome is not for this device (CC'd copy meant for another device/co-device)
        console.log('[_tryJoinGroup] Welcome not for this device (key package consumed):', groupId);
        return groupId;
      }
      throw e;
    }

    // If the MLS group_id differs from the passed ID, migrate metadata
    if (actualGroupId !== groupId) {
      console.log('[_tryJoinGroup] Migrating group:', groupId, '→', actualGroupId);
      const oldMeta = (await this.storage.loadGroupMeta(groupId)) || {};
      const { welcome, ratchetTree, noLongerMember, left, ...rest } = oldMeta;
      await this.storage.saveGroupMeta(actualGroupId, { ...rest, joined: true });
      // Store URI→ULID mapping so future activities resolve correctly (only if it's actually a URI)
      if (isApUri(groupId)) {
        await this.storage.setGroupField(actualGroupId, 'apId', groupId);
      }
      // Clean up temporary group record
      await this.storage.deleteGroupMeta(groupId);
    } else {
      // Same ID — just mark as joined and clear consumed join tokens.
      // Also clear noLongerMember/left: a re-invite means we are a member again.
      const meta = (await this.storage.loadGroupMeta(groupId)) || {};
      const { welcome, ratchetTree, noLongerMember, left, ...rest } = meta;
      await this.storage.saveGroupMeta(groupId, { ...rest, joined: true });
    }
    // Clear top-level re-invite flags on the canonical group (stored via setGroupField, not in rec.state).
    await this.storage.setGroupField(actualGroupId, 'noLongerMember', false);
    await this.storage.setGroupField(actualGroupId, 'left', false);

    const membersToAdd = [actor.id];
    if (parsed.attributedTo) membersToAdd.push(parsed.attributedTo);
    await this.persistMembers(actualGroupId, membersToAdd);
    // Seed sigKeys + cache leaf signature keys (for endorsement verification) from ratchet tree
    await this._syncMembersFromMLS(actualGroupId, actor);
    await this._replenishKeyPackage(actor);

    const inviterUri = parsed.attributedTo;
    const inviter = await this._getNickname(inviterUri);
    if (wasJoined) {
      await this._insertSystemMessage(actualGroupId, `Encryption was reset by ${inviter}. You have been re-invited to the group.`);
    } else {
      await this._insertSystemMessage(actualGroupId, `${inviter} added you to this group.`);
    }

    return actualGroupId;
  }

  async _handlePrivateMessage(groupId, parsed, actor) {
    const outerMessageId = parsed.id;
    console.log('[_handlePrivateMessage] outerMessageId:', outerMessageId, 'groupId:', groupId, 'from:', parsed.attributedTo);
    if (!outerMessageId) return null;

    // Quick dedup check against outer AP id (catches messages stored under old scheme)
    const existing = await this.storage.getMessage(outerMessageId);
    if (existing) {
      console.log('[_handlePrivateMessage] Skipping already-stored message:', outerMessageId);
      return null;
    }

    try {
      // Ensure group is loaded
      const { found } = await this.mlsService.getGroup(actor.id, groupId);
      if (!found) {
        throw new EncryptionLostError(groupId);
      }

      // Decrypt
      const ciphertext = bytesFromInput(parsed.content);
      const decrypted = await this.mlsService.decrypt(actor.id, groupId, ciphertext);
      console.log('[_handlePrivateMessage] Decrypted:', typeof decrypted, decrypted);
      // null = Commit (epoch advanced), proposalBuffered = self-remove Proposal
      if (decrypted === null) {
        await this._syncMembersFromMLS(groupId, actor, parsed.attributedTo);
        return { type: 'membershipChange', groupId };
      }
      if (decrypted?.proposalBuffered) {
        // Defer to pollInbox second pass so any Commit in the same batch is applied first
        return { proposalBuffered: true, _deferred: { groupId, parsed } };
      }
      // Skip application message content while waiting for new-device approval;
      // Commits (null) and Proposals (proposalBuffered) above are always handled.
      if (this._awaitingApproval) {
        console.log('[_handlePrivateMessage] Skipping application message — awaiting co-device approval');
        return null;
      }
      const { content: rawContent, senderSignatureKey } = decrypted;
      let decryptedContent = typeof rawContent === 'object' ? rawContent : { content: rawContent };

      // Unwrap Create — Emissary and other AP-MLS clients send Create{object: Note}.
      // Merge: Create fields as base, inner object fields overwrite (so Note's id/type/content win
      // but Create-only fields like `instrument` are preserved).
      // Normalize attribution: keep attributedTo (UI expectation), drop actor.
      const rawTypes0 = Array.isArray(decryptedContent.type) ? decryptedContent.type : [decryptedContent.type];
      if (rawTypes0.includes('Create') && decryptedContent.object && typeof decryptedContent.object === 'object') {
        const { object: innerObj, actor, ...createWrapper } = decryptedContent;
        const merged = { ...createWrapper, ...innerObj };
        if (!merged.attributedTo && actor) merged.attributedTo = actor;
        delete merged.actor;
        decryptedContent = merged;
      }

      if (!decryptedContent.attributedTo && parsed.attributedTo) {
        decryptedContent.attributedTo = parsed.attributedTo;
      }

      // Route encrypted receipts before saving as messages
      if (decryptedContent?.type === 'Acknowledge') {
        return this._handleAcknowledgeReceipt(decryptedContent, parsed, senderSignatureKey);
      }
      if (decryptedContent?.type === 'Failure') {
        // Encrypted Failure — their outgoing encryption works, only incoming decryption failed
        const referencedId = decryptedContent.object;
        if (referencedId) {
          const msg = await this.storage.getMessage(referencedId) || await this.storage.getMessageByApId(referencedId);
          if (msg) {
            const key = senderSignatureKey || parsed.attributedTo;
            const entry = senderSignatureKey ? { actorId: parsed.attributedTo, status: 'failed' } : { status: 'failed' };
            await this.storage.updateDeliveryStatus(msg.id, key, entry);
            return { type: 'receipt', groupId: msg.groupId };
          }
        }
        return null;
      }

      // Handle Update/Delete activities (only original sender can modify their own message)
      const innerTypes = Array.isArray(decryptedContent.type) ? decryptedContent.type : [decryptedContent.type];
      if (innerTypes.includes('Update') && decryptedContent.object) {
        const obj = decryptedContent.object;
        const targetId = typeof obj === 'string' ? obj : obj?.id;
        if (!targetId) return { type: 'update', groupId };
        const existing = await this.storage.getMessage(targetId) || await this.storage.getMessageByApId(targetId);
        if (existing && existing.content?.attributedTo === parsed.attributedTo) {
          // Merge updated object over existing content, preserving local-only fields (_localPath, _thumbDataUrl)
          const updatedContent = typeof obj === 'string'
            ? existing.content
            : { ...existing.content, ...obj };
          await this.storage.saveMessage(groupId, updatedContent, targetId, existing.isLocal, existing.apId, existing.deliveryStatus, existing.timestamp);
          await this.storage.saveGroupMeta(groupId, { ...(await this.storage.loadGroupMeta(groupId) || {}), hasUnread: true });
        } else if (existing) {
          const nick = await this._getNickname(parsed.attributedTo);
          await this._insertSystemMessage(groupId, `${nick || "Someone"} tried to edit a message they did not send.`, { relatedMessageId: targetId });
        }
        return { type: 'update', groupId };
      }

      if (innerTypes.includes('Delete') && decryptedContent.object) {
        const targetId = typeof decryptedContent.object === 'string'
          ? decryptedContent.object
          : decryptedContent.object?.id;
        const existing = await this.storage.getMessage(targetId) || await this.storage.getMessageByApId(targetId);
        if (existing && existing.content?.attributedTo === parsed.attributedTo) {
          await this.storage.tombstoneMessage(targetId);
          await this.storage.saveGroupMeta(groupId, { ...(await this.storage.loadGroupMeta(groupId) || {}), hasUnread: true });
        } else if (existing) {
          const nick = await this._getNickname(parsed.attributedTo);
          await this._insertSystemMessage(groupId, `${nick || "Someone"} tried to delete a message they did not send.`, { relatedMessageId: targetId });
        }
        return { type: 'delete', groupId };
      }

      // EmojiReact or Like-with-content
      const isEmojiReact = innerTypes.includes('EmojiReact') ||
        (innerTypes.includes('Like') && decryptedContent.content);
      if (isEmojiReact && decryptedContent.object) {
        const targetId = this._objectId(decryptedContent.object);
        const emoji = decryptedContent.content || '👍';
        const existing = await this._resolveMessage(targetId);
        if (existing) await this.storage.addReaction(existing.id, parsed.attributedTo, emoji, decryptedContent.id || null);
        return { type: 'reaction', groupId };
      }

      // Plain Like (no content) = 👍
      if (innerTypes.includes('Like') && decryptedContent.object) {
        const existing = await this._resolveMessage(this._objectId(decryptedContent.object));
        if (existing) await this.storage.addReaction(existing.id, parsed.attributedTo, '👍', decryptedContent.id || null);
        return { type: 'reaction', groupId };
      }

      // Undo — target message found via object.object
      if (innerTypes.includes('Undo') && decryptedContent.object) {
        const inner = decryptedContent.object;
        if (inner?.type === 'Like' || inner?.type === 'EmojiReact') {
          const targetId = this._objectId(inner.object);
          const emoji = inner.content || '👍';
          const existing = await this._resolveMessage(targetId);
          if (existing) await this.storage.removeReaction(existing.id, parsed.attributedTo, emoji);
        }
        return { type: 'undo', groupId };
      }

      // Announce — store Announce; if content present, split into reply Note (interop)
      if (innerTypes.includes('Announce') && decryptedContent.object) {
        const targetId = this._objectId(decryptedContent.object);
        const announceId = decryptedContent.id || outerMessageId;
        await this.storage.saveMessage(groupId, {
          type: 'Announce', attributedTo: parsed.attributedTo,
          object: targetId, content: null,
          timestamp: decryptedContent.published || Date.now(),
        }, announceId, false, (announceId !== outerMessageId) ? outerMessageId : undefined);
        if (decryptedContent.content) {
          await this._saveAnnounceComment(groupId, announceId, parsed.attributedTo, decryptedContent.content, false);
        }
        await this.storage.saveGroupMeta(groupId, { ...(await this.storage.loadGroupMeta(groupId) || {}), hasUnread: true });
        return { type: 'announce', groupId };
      }

      // Activity receipts: Read, Listen, View — AP MLS draft §activities; stored using AP verb names
      const receiptStatus = innerTypes.includes('Read') ? 'Read'
        : innerTypes.includes('Listen') ? 'Listen'
        : innerTypes.includes('View') ? 'View'
        : null;
      if (receiptStatus && decryptedContent.object) {
        const targetId = this._objectId(decryptedContent.object);
        const existing = await this._resolveMessage(targetId);
        if (existing) {
          const key = senderSignatureKey || parsed.attributedTo;
          const entry = senderSignatureKey ? { actorId: parsed.attributedTo, status: receiptStatus, timestamp: Date.now() } : { status: receiptStatus, timestamp: Date.now() };
          await this.storage.updateDeliveryStatus(existing.id, key, entry);
        }
        return { type: receiptStatus, groupId };
      }

      // Use inner ap-mls:// id if present, fall back to outer AP id
      const messageId = decryptedContent.id || outerMessageId;

      // Dedup check against inner id too
      if (decryptedContent.id) {
        const existingInner = await this.storage.getMessage(messageId);
        if (existingInner) {
          console.log('[_handlePrivateMessage] Skipping already-stored message (inner id):', messageId);
          return null;
        }
      }

      // Silently discard IntransitiveActivity — AP MLS spec §traffic-analysis dummy messages
      if (innerTypes.includes('IntransitiveActivity')) return { type: 'ignored', groupId };

      // Store with outer AP ID for deep link resolution; tag with sender's client key
      const messageApId = (messageId !== outerMessageId) ? outerMessageId : undefined;
      if (senderSignatureKey) decryptedContent._senderClientKey = senderSignatureKey;
      await this.storage.saveMessage(groupId, decryptedContent, messageId, false, messageApId);
      console.log('[_handlePrivateMessage] Saved message:', messageId, 'apId:', messageApId, 'in group:', groupId);

      // Mark group as having unread messages (cleared when loadMessages is called)
      await this.storage.saveGroupMeta(groupId, { ...(await this.storage.loadGroupMeta(groupId) || {}), hasUnread: true });

      // Send encrypted Acknowledge receipt only for regular content messages, debounced so
      // a Read receipt sent first will cancel it (Read implies Acknowledge).
      // Anything that reaches here is displayable content (activity types returned early above).
      const isContent = decryptedContent != null && !decryptedContent.error;
      if (isContent) {
        this._scheduleAck(groupId, messageId, parsed, actor);
      }

      // Store apId mapping if not yet set (context URI → ULID)
      const existingApId = await this.storage.getGroupField(groupId, 'apId', null);
      if (!existingApId && isApUri(parsed.context)) {
        await this.storage.setGroupField(groupId, 'apId', parsed.context);
        console.log('[_handlePrivateMessage] Set apId mapping:', groupId, '→', parsed.context);
      }

      // Save group name from message if present
      if (decryptedContent.name) {
        await this.storage.setGroupField(groupId, 'name', decryptedContent.name);
      }

      // Track members from activity metadata
      const membersToAdd = [];
      if (parsed.attributedTo) membersToAdd.push(parsed.attributedTo);
      if (parsed.to) {
        const toArray = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
        membersToAdd.push(...toArray);
      }
      if (parsed.cc) {
        const ccArray = Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc];
        membersToAdd.push(...ccArray);
      }
      if (membersToAdd.length > 0) {
        await this.persistMembers(groupId, membersToAdd);
      }
    } catch (e) {
      console.error('[Handler] Failed to decrypt message:', e);
      // No MLS state for this group. If we intentionally left, silently drop so we don't
      // store an error entry that races loadMessages into showing "Encryption keys lost".
      // If encryption was unexpectedly lost, re-throw so pollInbox marks it processed
      // without pushing a result — the UI will show "Encryption keys lost" correctly when
      // the user opens the group and loadMessages detects encryptionAvailable=false.
      if (e instanceof EncryptionLostError) {
        const meta = await this.storage.loadGroupMeta(groupId).catch(() => null) || {};
        if (meta.noLongerMember || meta.left) return null;
        // TODO: should we flag raise ^ in test env in order to flag when sending messages to a member who has left the group? 
      }
      const errStr = typeof e === 'string' ? e : (e.message || String(e));
      // MLS can't decrypt messages we sent ourselves — skip silently
      if (errStr.includes('CannotDecryptOwnMessage')) {
        console.log('[Handler] Skipping own message (CannotDecryptOwnMessage):', outerMessageId);
        return { type: 'message', groupId, messageId: outerMessageId, from: parsed.attributedTo };
      }
      // Use the full original outer type array (preserved in parsed.originalTypes) since
      // parseMLSActivity normalises type to just 'PrivateMessage'.
      const isFailureReceipt = parsed.originalTypes.includes('Failure');
      const isReceipt = isFailureReceipt || parsed.originalTypes.includes('Acknowledge');

      if (isFailureReceipt) {
        // Decryption failed for an incoming Failure receipt — update delivery status from plaintext object field
        // without saving an error message or sending another receipt (which would cause a loop).
        const obj = activity?.object || activity;
        const referencedId = obj.object;
        if (referencedId) {
          const msg = await this.storage.getMessage(referencedId) || await this.storage.getMessageByApId(referencedId);
          if (msg) {
            await this.storage.updateDeliveryStatus(msg.id, parsed.attributedTo, { status: 'keys_broken' });
            return { type: 'receipt', groupId: msg.groupId };
          }
        }
        return null;
      }

      const isAeadError = errStr.includes('AeadError') || errStr.includes('UnableToDecrypt');
      const errorText = isAeadError
        ? 'Message encrypted with old/invalid keys'
        : 'Failed to decrypt: ' + errStr;
      await this.storage.saveMessage(groupId, {
        error: errorText,
        encryptedContent: parsed.content,
        attributedTo: parsed.attributedTo
      }, outerMessageId, false);
      // Don't send a Failure receipt in response to any incoming receipt — would cause a loop
      if (parsed.attributedTo && !isReceipt) this._sendFailureReceipt(outerMessageId, parsed, actor);
    }

    return { type: 'message', groupId, messageId: outerMessageId, from: parsed.attributedTo };
  }

  // ── Key packages ───────────────────────────────────────

  /**
   * Create and publish a fresh key package after the previous one was consumed
   * (e.g., by joining a group from a Welcome message).
   */
  async _replenishKeyPackage(actor) {
    try {
      console.log('[KeyPackage] Replenishing after group join...');
      // If actor was reconstructed from stale localStorage (outbox absent), fetch a fresh one
      if (!actor.outbox) actor = await getCurrentActor();
      // Capture old KP hex BEFORE clearing so we can remove it from server after the new one is published
      const oldKpHex = await this.mlsService.getKeyPackageHex(actor.id);
      await this.mlsService.clearKeyPackage(actor.id);
      const { keyPackageHex, ciphersuite } = await this.mlsService.createKeyPackage(actor.id);
      const kpBytes = bytesFromInput(keyPackageHex);
      const kpB64 = bytesToBase64(kpBytes);
      const mlsSig = await this._signKeyPackage(actor.id, kpB64);
      const published = await publishKeyPackage(actor, kpBytes, mlsSig, this.storage, ciphersuite);
      if (published) {
        await this.mlsService.markKeyPackagePublished(actor.id, keyPackageHex);
        localStorage.removeItem('actor');
        console.log('[KeyPackage] Fresh key package published');
        // Remove old KP from server collection (spec §KP lifecycle: Remove after consumed)
        if (oldKpHex) {
          const oldKpBytes = bytesFromInput(oldKpHex);
          await deleteKeyPackage(actor, oldKpBytes, this.storage).catch(e =>
            console.warn('[KeyPackage] Failed to remove old KP from collection:', e)
          );
        }
      }
    } catch (e) {
      console.error('[KeyPackage] Failed to replenish:', e);
    }
  }

  /**
   * Ensure the current user has a published key package.
   */
  async ensurePublishedKeyPackage(actor) {
    const { keyPackageHex, publishedDate, ciphersuite: storedCs } = await this.mlsService.getKeyPackageInfo(actor.id);

    if (!keyPackageHex) {
      // new key package
      const { keyPackageHex: newHex, ciphersuite: newCs } = await this.mlsService.createKeyPackage(actor.id);
      const kpBytes = bytesFromInput(newHex);

      // If co-devices exist (live in MLS groups, or server has a KP from a different device),
      // send as proposal for approval rather than publishing publicly
      const ownSigKey = await this.mlsService.getOwnSignatureKey(actor.id);
      const liveCoDeviceKeys = await this._getLiveCoDeviceKeys(actor);
      const serverHasOtherDevice = await this._actorHasOtherDevices(actor, ownSigKey);
      if (liveCoDeviceKeys.length > 0 || serverHasOtherDevice) {
        try {
          await sendKeyPackageProposal(actor, kpBytes, this.storage);
          console.log('[KeyPackage] Sent proposal to own inbox for co-device approval');
        } catch (e) {
          console.error('[KeyPackage] Failed to send proposal — will retry on next init:', e);
          // Don't abort init; co-device approval will be triggered again next time
          return;
        }
        this._awaitingApproval = true;
        const ownFp = await this.mlsService.getOwnFingerprint(actor.id);
        return { type: 'newDevicePending', fingerprint: ownFp?.fingerprint };
      }

      const mlsSig = await this._signKeyPackage(actor.id, bytesToBase64(kpBytes)).catch(() => null);
      const published = await publishKeyPackage(actor, kpBytes, mlsSig, this.storage, newCs);
      if (published) {
        await this.mlsService.markKeyPackagePublished(actor.id, newHex);
        localStorage.removeItem('actor');
      }
      return;
    }

    // Already have a key package — check if published
    if (publishedDate) {
      console.log('[KeyPackage] Already published. Last published:', publishedDate);
      return;
    }

    // Has key package but not published — self-sign and publish (replenishment)
    const kpBytes = bytesFromInput(keyPackageHex);
    const mlsSig = await this._signKeyPackage(actor.id, bytesToBase64(kpBytes));
    const published = await publishKeyPackage(actor, kpBytes, mlsSig, this.storage, storedCs);
    if (published) {
      await this.mlsService.markKeyPackagePublished(actor.id, keyPackageHex);
      localStorage.removeItem('actor');
    }
  }

  /**
   * Fetch the latest key package for a remote actor.
   * Falls back to cached version if fetch fails.
   *
   * @param {string} actorUri
   * @returns {Uint8Array|null}
   */
  async fetchLatestKeyPackage(actorUri) {
    try {
      const result = await fetchActorKeyPackage(actorUri);
      console.log('attempted fetchActorKeyPackage', result)
      console.log('fetchActorKeyPackage result', result)
      if (result) {
        const { content, actor } = result;
        // Store the actor's profile from the fetched AP object
        await this._saveActorProfileFromAP(actor);
        // Cache the fetched key package
        await this.storage.saveUserField(actorUri, 'keyPackage', content);
        await this.storage.saveUserField(actorUri, 'publishedDate', Date.now());
        return bytesFromInput(content);
      }
    } catch (err) {
      console.error('Failed to fetch key package for', actorUri, err);
    }

    // Fallback to cached
    const state = await this.storage.loadUserState(actorUri);
    if (state?.keyPackage) {
      console.warn('[KeyPackage] Using cached KeyPackage as fallback');
      return bytesFromInput(state.keyPackage);
    }

    return null;
  }

  /**
   * Fetch a KeyPackage for actorUri that is not already represented in groupId.
   * Needed for co-device adds: when an actor already has one device in the group,
   * pick the KP whose signature key is absent from the current member tree.
   * Falls back to the single latest KP when actor has only one device.
   */
  async _fetchKeyPackageForAdd(actorUri, groupId, ownActorId) {
    const allKps = await fetchAllActorKeyPackages(actorUri);
    if (allKps.length === 0) return null;

    // Prefer KPs matching the group's ciphersuite; include undeclared KPs as fallback (Rust will validate)
    const groupCiphersuite = await this.storage.getGroupField(groupId, 'ciphersuite', null);
    const candidates = groupCiphersuite != null
      ? [
          ...allKps.filter(kp => kp.ciphersuite?.identifier === groupCiphersuite),
          ...allKps.filter(kp => !kp.ciphersuite),
        ]
      : allKps;

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return { kpBytes: bytesFromInput(candidates[0].content), mlsSignature: candidates[0].mlsSignature, mlsSignerKeyId: candidates[0].mlsSignerKeyId };

    // Among matching candidates, pick one whose signature key isn't already in the group
    const fingerprints = await this.mlsService.getGroupFingerprints(ownActorId, groupId).catch(() => []);
    const existingSigKeys = new Set(fingerprints.map(fp => fp.signatureKey).filter(Boolean));

    for (const { content, mlsSignature, mlsSignerKeyId } of candidates) {
      const fp = await this.mlsService.getKeyPackageFingerprint(content).catch(() => null);
      if (!fp?.signatureKey || !existingSigKeys.has(fp.signatureKey)) {
        return { kpBytes: bytesFromInput(content), mlsSignature: mlsSignature ?? null, mlsSignerKeyId: mlsSignerKeyId ?? null };
      }
    }
    return null;
  }

  // ── Cleanup ────────────────────────────────────────────

  async archiveThread(groupId) {
    const actor = await getCurrentActor();
    await this.mlsService.deleteGroup(actor.id, groupId);
    // Collect and delete local attachment files before wiping messages
    const msgs = await this.storage.listMessages(groupId);
    const paths = msgs.flatMap(m => _collectLocalPaths(m.content || m));
    this._deleteAttachmentFiles(paths);
    await this.storage.deleteGroupMessages(groupId);
    await this.storage.deleteGroupMeta(groupId);
  }

  async clearAllData() {
    const actor = await getCurrentActor();

    // Rust handles: native warning dialog (with irrecoverable warning if no co-devices) → leave all groups → back up & delete SQLite DB
    const response = await this.mlsService.clearAllData(actor.id);
    if (response.cancelled || !response.results) {
      console.warn('[clearAllData] Clear cancelled or failed:', response);
      return false;
    } 

    // Remove this device's key package from the actor profile
    try {
      const ownSigKey = await this.mlsService.getOwnSignatureKey(actor.id);
      if (ownSigKey) await this._deleteKeyPackageForDevice(actor, ownSigKey);
    } catch (e) {
      console.warn('[clearAllData] Failed to delete key package:', e);
    }

    // Distribute self-remove proposals so other members update their state
    for (const result of response.results) {
      try {
        const recipients = await this.getGroupMembers(result.groupId);
        const meta = (await this.storage.loadGroupMeta(result.groupId)) || {};
        const apId = meta.apId || null;
        if (apId && recipients.length > 0) {
          await sendMLSControl(actor, 'PrivateMessage', result.commit, recipients, apId, this.storage);
        }
      } catch (err) {
        console.error(`[clearAllData] Failed to distribute for ${result.groupId}:`, err);
      }
    }

    // Clear JS-side storage and auth
    await this.storage.clearAll();
    // logout as well?
    // localStorage.clear();
    // sessionStorage.clear();
    return true;
  }

  // ── Member / client management ──────────────────────────

  /**
   * Distribute an MLS commit to remaining group members via AP.
   * Shared by all removal methods.
   */
  async _distributeCommit(actor, groupId, commitB64, recipients) {
    const apId = await this.storage.getGroupField(groupId, 'apId', null);
    console.log('[_distributeCommit] apId:', apId, 'recipients:', recipients, 'commitB64 length:', commitB64?.length);
    if (apId && recipients.length > 0) {
      await sendMLSControl(actor, 'PrivateMessage', commitB64, recipients, apId, this.storage);
    }
  }

  /**
   * Add a new member to an existing group.
   * Fetches their KeyPackage, creates an MLS Commit, sends Welcome+GroupInfo
   * to the new member, and distributes the Commit to existing members.
   *
   * @param {string} groupId - group identifier
   * @param {string} recipientMention - @user@domain or actor URI
   * @returns {string} resolved actor URI of the added member
   */
  async addMemberToGroup(groupId, recipientMention, { usePrefix = false } = {}) {
    const actor = await getCurrentActor();
    const currentDomain = new URL(actor.id).hostname;

    const recipientUri = await resolveActorId(recipientMention, currentDomain);
    if (!recipientUri) throw new Error(`Could not resolve ${recipientMention}`);

    const groupCiphersuite = await this.storage.getGroupField(groupId, 'ciphersuite', null);
    const kpResult = await this._fetchKeyPackageForAdd(recipientUri, groupId, actor.id);
    if (!kpResult) {
      const suiteInfo = groupCiphersuite != null ? ` (requires ciphersuite 0x${groupCiphersuite.toString(16).padStart(4, '0')})` : '';
      throw new Error(`No compatible KeyPackage for ${recipientUri}${suiteInfo}`);
    }
    const { kpBytes, mlsSignature, mlsSignerKeyId } = kpResult;

    // Verify endorsement before consuming the KP. Unverified KPs must not be silently added.
    const kpB64 = bytesToBase64(kpBytes);

    // Bootstrap trust for first-contact actors (e.g. cross-server): if the actor's key is not yet in mlsKnownKeys, extract the signature key embedded in the KP and cache it.
    // Trust anchor: we fetched the KP directly from the actor's AP endpoint, so this is TOFU. 
    if (mlsSignerKeyId && mlsSignature && !(await this.storage.getMlsKnownKey(mlsSignerKeyId))) {
      const fp = await this.mlsService.getKeyPackageFingerprint(kpB64).catch(() => null);
      if (fp?.signatureKey) {
        await this.storage.saveMlsKnownKey(mlsSignerKeyId, fp.signatureKey);
      }
    }

    const endorsed = await this._verifyKpEndorsement(kpB64, { mlsSignature, mlsSignerKeyId });
    if (!endorsed) {
      return { pending: true, reason: 'unverified_kp', kpB64, recipientUri, mlsSignature, mlsSignerKeyId };
    }

    const { welcome, ratchetTree, commit } = await this.mlsService.addMember(actor.id, groupId, kpBytes);

    const apId = await this.storage.getGroupField(groupId, 'apId', null);

    // Welcome + GroupInfo (ratchet tree) to the new member
    await this._sendInvite(actor, groupId, recipientUri, welcome, ratchetTree, apId, { usePrefix });

    // Commit to all existing members so their epoch advances
    const allMembers = await this.getGroupMembers(groupId);
    const existingMembers = allMembers.filter(id => id !== recipientUri && id !== actor.id);
    console.log('[addMemberToGroup] allMembers:', allMembers, 'existingMembers (excluding new):', existingMembers, 'commit length:', commit?.length);
    await this._distributeCommit(actor, groupId, commit, existingMembers);

    // Persist updated member list — each client inserts a local system message when they process the Commit
    await this.persistMembers(groupId, [recipientUri]);
    const nickname = await this._getNickname(recipientUri);
    await this._insertSystemMessage(groupId, `${nickname} was added to the group`);

    console.log('[addMemberToGroup] Added', recipientUri, 'to group', groupId);
    return recipientUri;
  }

  /**
   * Handle an Add { object: KeyPackage } activity arriving in the inbox.
   * Verifies the mlsSignature (if present and if we know the actor's devices) before
   * accepting the KP into the local cache. Unknown/unverifiable KPs are logged and dropped.
   *
   * Two valid signer cases (per spec proposal):
   *   (a) A known co-device of the actor signed it (new device endorsement)
   *   (b) The KP's own SignaturePublicKey signed it (self-signed replenishment)
   */
  async _handleKeyPackageAdd(activity) {
    let kpObj = activity.object;
    // Per spec, object may be a URL string — dereference it
    if (typeof kpObj === 'string') {
      const res = await apFetch(kpObj, { headers: { Accept: 'application/activity+json' } });
      if (!res.ok) return;
      kpObj = await res.json();
    }
    const kpB64 = kpObj?.content ?? kpObj?.["mls:content"];
    const actorUri = kpObj?.attributedTo || activity.actor;
    if (!kpB64 || !actorUri) return;

    const sig = activity.mlsSignature;
    const signerKeyId = activity.mlsSignerKeyId;

    if (sig && signerKeyId) {
      // Direct cache lookup — no iteration, never trust server-fetched keys
      const signerKey = await this.storage.getMlsKnownKey(signerKeyId);
      if (!signerKey) {
        console.warn('[_handleKeyPackageAdd] mlsSignerKeyId not in local cache for', actorUri, '— KP needs out-of-band verification');
        return;
      }
      const verified = await this.mlsService.verifySignature(signerKey, mlsEndorsementPayload(kpB64), sig).catch(() => false);
      if (!verified) {
        console.warn('[_handleKeyPackageAdd] mlsSignature verification failed for', actorUri, '— rejecting KP');
        return;
      }
      console.log('[_handleKeyPackageAdd] KP verified for', actorUri);
    } else if (sig && !signerKeyId) {
      // Legacy: no signerKeyId, try live group state keys (backward compat with old clients)
      const validSigners = await this._getLiveDeviceKeysForActor(actorUri);
      if (validSigners.length > 0) {
        let verified = false;
        for (const key of validSigners) {
          try {
            if (await this.mlsService.verifySignature(key, mlsEndorsementPayload(kpB64), sig)) {
              verified = true;
              break;
            }
          } catch { /* try next */ }
        }
        if (!verified) {
          console.warn('[_handleKeyPackageAdd] Legacy mlsSignature verification failed for', actorUri, '— rejecting KP');
          return;
        }
      }
    } else {
      // Unsigned — only accept if no known devices for this actor (first device case)
      const liveKeys = await this._getLiveDeviceKeysForActor(actorUri);
      if (liveKeys.length > 0) {
        console.warn('[_handleKeyPackageAdd] Unsigned Add from', actorUri, '— rejecting (known devices exist)');
        return;
      }
      console.log('[_handleKeyPackageAdd] Unsigned Add accepted for', actorUri, '(no known devices)');
    }
    // 3-step auth step 3 (spec §authentication): confirm KP is in actor's published collection
    const liveKps = await fetchAllActorKeyPackages(actorUri).catch(() => []);
    if (!(liveKps ?? []).some(kp => kp.content === kpB64)) {
      console.warn('[_handleKeyPackageAdd] KP not in actor collection — rejecting (spec 3-step auth)');
      return;
    }
    await this.storage.saveUserField(actorUri, 'keyPackage', kpB64);

    // If this is our own KP being endorsed, signal the pending dialog to close
    const actor = await getCurrentActor();
    if (actorUri === actor.id) {
      try {
        const fp = await this.mlsService.getKeyPackageFingerprint(kpB64);
        const ownSigKey = await this.mlsService.getOwnSignatureKey(actor.id);
        if (fp?.signatureKey === ownSigKey) return { type: 'newDeviceApproved' };
      } catch (e) {
        console.log("not our KP")
      }
    }
  }

  /**
   * Handle an incoming KeyPackage proposal from a co-device (same actor, different device).
   * Checks live MLS group membership to determine if this is a known device (replenishment — ignore)
   * or a new device needing user approval.
   */
  async _handleKeyPackageProposal(kpObject, actor) {
    const kpB64 = kpObject.content;
    if (!kpB64) return null;

    let fingerprintResult;
    try {
      fingerprintResult = await this.mlsService.getKeyPackageFingerprint(kpB64);
    } catch (e) {
      console.warn('[_handleKeyPackageProposal] Could not get fingerprint (invalid KP?):', e);
      return null;
    }
    const { fingerprint, signatureKey } = fingerprintResult;

    // If this is our own device's proposal coming back, show pending verification status.
    // Also guard against ownSigKey being null (MLS not yet initialised) — in that case
    // kpObject.attributedTo === actor.id is the only reliable signal we sent it ourselves.
    const ownSigKey = await this.mlsService.getOwnSignatureKey(actor.id);
    if (signatureKey === ownSigKey || (!ownSigKey && kpObject.attributedTo === actor.id)) {
      console.log('[_handleKeyPackageProposal] Own device proposal received — showing pending status');
      const ownFp = await this.mlsService.getOwnFingerprint(actor.id);
      return { type: 'newDevicePending', fingerprint: ownFp?.fingerprint };
    }

    // A key is "known" only if it is currently a live member of a shared MLS group —
    // MLS is the canonical source of truth; a decommissioned device will not appear here
    const liveCoDeviceKeys = await this._getLiveCoDeviceKeys(actor);
    if (liveCoDeviceKeys.includes(signatureKey)) {
      console.log('[_handleKeyPackageProposal] Known live co-device, ignoring (replenishment):', signatureKey);
      return null;
    }

    // If the key is already published in the actor's server-side keyPackages collection,
    // this proposal was already approved and acted on — skip it (handles stale inbox items).
    if (await this._isKeyAlreadyPublished(actor, signatureKey)) {
      console.log('[_handleKeyPackageProposal] Key already published on server, ignoring stale proposal:', signatureKey);
      return null;
    }

    console.log('[_handleKeyPackageProposal] New co-device key detected, requesting user approval');
    return { type: 'newDeviceRequest', fingerprint, kpB64, signatureKey };
  }

  /**
   * Return the MLS SignaturePublicKeys of all co-devices (same actor identity, different device)
   * that are currently live members of at least one shared group.
   * Uses MLS group state as the canonical source — decommissioned devices are automatically absent.
   */
  async _getLiveCoDeviceKeys(actor) {
    const ownSigKey = await this.mlsService.getOwnSignatureKey(actor.id);
    const keys = new Set();
    for (const { signatureKey } of await this._getLiveDeviceKeysForActor(actor.id)) {
      if (signatureKey !== ownSigKey) keys.add(signatureKey);
    }
    return [...keys];
  }

  /** Check whether the actor's server-side profile contains a KeyPackage from a different device. */
  async _actorHasOtherDevices(actor, ownSigKey) {
    return forEachPublishedKeyPackage(actor, this.mlsService, k => k !== ownSigKey);
  }

  /** Returns true if signatureKey is already in the actor's published keyPackages on the server. */
  async _isKeyAlreadyPublished(actor, signatureKey) {
    return forEachPublishedKeyPackage(actor, this.mlsService, k => k === signatureKey);
  }

  /** Find and delete the key package for a specific device from the actor's keyPackages collection. */
  async _deleteKeyPackageForDevice(actor, signatureKey) {
    const freshActor = await getActor(actor.id).catch(() => actor);
    await deleteKeyPackageForDevice(freshActor, signatureKey, this.mlsService, this.storage);
  }

  /**
   * Return all MLS SignaturePublicKeys currently attributed to a given actor URI
   * across all loaded groups — i.e. every live device leaf for that identity.
   */
  async _getLiveDeviceKeysForActor(actorUri) {
    const actor = await getCurrentActor();
    const groups = await this.storage.listGroupsWithLastMessage();
    const keys = new Set();
    for (const { groupId } of groups) {
      try {
        const members = await this.mlsService.getGroupFingerprints(actor.id, groupId);
        for (const m of members || []) {
          if (m.identity === actorUri) keys.add(m.signatureKey);
        }
      } catch (e) {
        // Group not loaded yet or no longer valid — skip
      }
    }
    return [...keys];
  }

  /**
   * Verify the endorsement on a KP. Returns true if endorsed+verified, false otherwise.
   * @param {string} kpB64 - base64 KP content
   * @param {{mlsSignature, mlsSignerKeyId}} endorsement - from AP activity or KP object
   */
  async _verifyKpEndorsement(kpB64, { mlsSignature, mlsSignerKeyId } = {}) {
    if (!mlsSignature || !mlsSignerKeyId) return false;
    const signerKey = await this.storage.getMlsKnownKey(mlsSignerKeyId);
    if (!signerKey) return false;
    return this.mlsService.verifySignature(signerKey, mlsEndorsementPayload(kpB64), mlsSignature).catch(() => false);
  }

  /**
   * Sign a KeyPackage's base64 content with the user's MLS private signature key.
   * Returns a bare base64 signature string, or null if signing is unavailable.
   * Receivers iterate their own MLS-known keys to verify — the signer identity is not transmitted.
   */
  async _signKeyPackage(userId, kpB64) {
    try {
      const result = await this.mlsService.signData(userId, mlsEndorsementPayload(kpB64));
      if (!result?.signature) return null;
      const signerKeyId = await this.storage.saveMlsKnownKey(userId, result.signerKey);
      return { signature: result.signature, signerKeyId };
    } catch (e) {
      console.warn('[_signKeyPackage] Signing not available:', e);
      return null;
    }
  }

  /**
   * Approve a co-device KeyPackage: publish it to the public keyPackages collection
   * and add the device to all current groups.
   *
   * @param {string} kpB64 - base64-encoded KeyPackage
   */
  async approveNewDevice(kpB64) {
    const actor = await getCurrentActor();
    const kpBytes = bytesFromInput(kpB64);

    // Sign the KP content with ExistingDeviceA's MLS key — this is the endorsement
    const mlsSig = await this._signKeyPackage(actor.id, kpB64);

    // Publish to public keyPackages collection (endorsed by ExistingDeviceA's MLS signature)
    await publishKeyPackage(actor, kpBytes, mlsSig, this.storage);

    // Add to all existing groups
    const groups = await this.storage.listGroupsWithLastMessage();
    for (const { groupId } of groups) {
      try {
        const { welcome, ratchetTree, commit } = await this.mlsService.addMember(actor.id, groupId, kpBytes);
        const apId = await this.storage.getGroupField(groupId, 'apId', null);
        await this._sendInvite(actor, groupId, actor.id, welcome, ratchetTree, apId);
        const existingMembers = (await this.getGroupMembers(groupId)).filter(id => id !== actor.id);
        await this._distributeCommit(actor, groupId, commit, existingMembers);
        // Seed mlsKnownKeys with the new device's signature key so subsequent addMemberToGroup
        // calls can verify its self-signed replenished KP after joining consumes the init key.
        await this._syncMembersFromMLS(groupId, actor);
      } catch (e) {
        console.warn('[approveNewDevice] Could not add co-device to group', groupId, e);
      }
    }

    console.log('[approveNewDevice] Co-device approved and added to', groups.length, 'groups');
  }

  /**
   * Process an incoming PublicMessage from another group member.
   * PublicMessages may carry Commits (epoch advance), Proposals (buffered by
   * OpenMLS until a Commit references them), or signed application data.
   * The Rust decrypt command handles all subtypes correctly via process_message().
   */
  async _handlePublicMessage(groupId, parsed, actor) {
    // Cancel any pending proposal commit timer — a commit arrived, someone else won the race
    if (this._pendingProposalTimers.has(groupId)) {
      clearTimeout(this._pendingProposalTimers.get(groupId));
      this._pendingProposalTimers.delete(groupId);
      console.log('[_handlePublicMessage] Cancelled pending proposal timer for group', groupId);
    }
    // Also dismiss any open co-device confirmation dialog for this group
    const pendingLeave = await this.storage.getGroupField(groupId, 'pendingCoDeviceLeave', null).catch(() => null);
    if (pendingLeave) {
      await this.storage.setGroupField(groupId, 'pendingCoDeviceLeave', null).catch(() => {});
      this.onAsyncResult?.({ type: 'coDeviceLeaveResolved', groupId });
    }
    try {
      const msgBytes = bytesFromInput(parsed.content);
      // decrypt handles: StagedCommitMessage (merges epoch), ProposalMessage (buffered), ApplicationMessage
      await this.mlsService.decrypt(actor.id, groupId, msgBytes);
      console.log('[_handlePublicMessage] Processed public message for group', groupId);
    } catch (e) {
      console.warn('[_handlePublicMessage] Failed to process public message:', e);
    }
    return null;
  }

  /**
   * Handle a buffered MLS Proposal (self-remove from a leaving device).
   *
   * Commit serialization uses deterministic leaf-index ordering (leafIndex × 2s) so
   * all devices independently arrive at the same commit ordering without coordination.
   * RFC §12.4: first commit wins; others cancel when the resulting Commit arrives.
   *
   * Co-device (same actor, different device): show confirmation dialog at leafIndex×2s slot.
   *   Multiple co-devices stagger via their leaf indices; each self-cancels on timer fire if
   *   pendingCoDeviceLeave is already cleared (another co-device committed first).
   *
   * Non-co-device (different actor): auto-commit at leafIndex×2s. If the leaving actor has
   *   surviving co-devices in the group, add CO_DEVICE_WINDOW (10 min) so co-devices get
   *   priority. Non-co-devices act as last-resort fallback only.
   */
  async _handleProposal(groupId, parsed, actor, alreadyDecrypted = false) {
    if (!alreadyDecrypted) {
      const msgBytes = bytesFromInput(parsed.content);
      let result;
      try {
        result = await this.mlsService.decrypt(actor.id, groupId, msgBytes);
      } catch (e) {
        console.warn('[_handleProposal] decrypt failed:', e);
        return null;
      }
      if (!result?.proposalBuffered) return null;
    }

    if (this._pendingProposalTimers.has(groupId)) return null;

    const isCoDevice = parsed.attributedTo === actor.id;
    console.log('[_handleProposal] isCoDevice:', isCoDevice, 'parsed.attributedTo:', parsed.attributedTo, 'actor.id:', actor.id, 'groupId:', groupId);
    const fingerprints = await this.mlsService.getGroupFingerprints(actor.id, groupId).catch(() => []);

    // Our leaf index in the MLS tree — used for deterministic commit ordering
    const ownFp = fingerprints.find(fp => fp.isCurrentClient);
    const ownLeafIndex = ownFp?.index ?? 0;

    if (isCoDevice) {
      const ownSigKey = await this.mlsService.getOwnSignatureKey(actor.id).catch(() => null);
      // Leaving device is still in the group at this point (proposal not yet committed)
      const leavingFp = fingerprints.find(fp => fp.isOwn && fp.signatureKey !== ownSigKey);
      const promptPayload = { type: 'coDeviceLeaving', groupId, proposalActivityId: parsed.id, fingerprint: leavingFp?.fingerprint };

      // Stagger by leaf index so only one co-device shows the dialog at a time.
      // Each slot is 30s — enough time for the user at the earlier-index device to see and
      // confirm before the next co-device's slot fires. On timer fire, bail out if another
      // co-device already committed (pendingCoDeviceLeave cleared).
      const CO_DEVICE_SLOT = 30_000;
      const delay = ownLeafIndex * CO_DEVICE_SLOT;
      this._pendingProposalTimers.set(groupId, setTimeout(async () => {
        this._pendingProposalTimers.delete(groupId);
        const stillPending = await this.storage.getGroupField(groupId, 'pendingCoDeviceLeave', null).catch(() => null);
        console.log('[_handleProposal] timer fired, stillPending:', stillPending, 'onAsyncResult set:', !!this.onAsyncResult);
        // null means already resolved by another co-device
        if (stillPending === null) {
          await this.storage.setGroupField(groupId, 'pendingCoDeviceLeave', parsed.id || true);
          console.log('[_handleProposal] calling onAsyncResult with', promptPayload);
          this.onAsyncResult?.(promptPayload);
        }
      }, delay));
      console.log('[_handleProposal] Co-device leave — scheduled dialog in', delay, 'ms (leafIndex', ownLeafIndex, ', slot', CO_DEVICE_SLOT, 'ms)');
      return null;
    }

    // Non-co-device: check if leaving actor has surviving co-devices — if so, wait 10 min first.
    // Count fingerprints with the leaving actor's identity: if > 1, there's a surviving co-device
    // (one is the leaving device itself; any additional one is a co-device that can confirm removal).
    const leavingActorId = parsed.attributedTo;
    const leavingActorHasCoDevices = fingerprints.filter(fp => fp.identity === leavingActorId).length > 1;
    const CO_DEVICE_WINDOW = leavingActorHasCoDevices ? (window.__BONFIRE_JS_DEBUG__ ? 10_000 : 10 * 60_000) : 0;
    const delay = CO_DEVICE_WINDOW + ownLeafIndex * 2000;

    this._pendingProposalTimers.set(groupId, setTimeout(async () => {
      this._pendingProposalTimers.delete(groupId);
      try {
        const r = await this.mlsService.commitPendingProposals(actor.id, groupId);
        if (r?.commit) {
          const members = await this.getGroupMembers(groupId);
          await this._distributeCommit(actor, groupId, r.commit, members);
          await this._syncMembersFromMLS(groupId, actor);
          if (parsed.id) await this._deleteProposalActivity(actor, parsed.id);
        }
      } catch (e) {
        console.warn('[_handleProposal] Commit failed (likely lost race — will process winner):', e);
      }
    }, delay));
    console.log('[_handleProposal] Non-co-device proposal — scheduled commit in', delay, 'ms (leafIndex', ownLeafIndex, ', co-device window', CO_DEVICE_WINDOW, 'ms)');
    return null;
  }

  /**
   * Commit a pending co-device leave proposal and distribute the result.
   * Called by the UI after the user confirms the leaving-device prompt.
   */
  async commitCoDeviceLeaving(groupId, proposalActivityId) {
    const actor = await getCurrentActor();
    await this.mlsService.getGroup(actor.id, groupId);
    const result = await this.mlsService.commitPendingProposals(actor.id, groupId);
    if (!result?.commit) {
      console.warn('[commitCoDeviceLeaving] No commit produced for group', groupId);
      return;
    }
    const members = await this.getGroupMembers(groupId);
    await this._distributeCommit(actor, groupId, result.commit, members);
    await this._syncMembersFromMLS(groupId, actor);
    await this.storage.setGroupField(groupId, 'pendingCoDeviceLeave', null);
    if (proposalActivityId) await this._deleteProposalActivity(actor, proposalActivityId);
    console.log('[commitCoDeviceLeaving] Done for group', groupId);
  }

  /** Send a Delete for a Proposal activity so inboxes don't re-serve it. */
  async _deleteProposalActivity(actor, proposalActivityId) {
    await postToOutbox(actor, {
      type: 'Delete',
      object: proposalActivityId,
      to: [actor.id],
    }, this.storage).catch(e => console.warn('[_deleteProposalActivity] Failed:', e));
  }

  /**
   * Remove a single client (leaf node) from a group and distribute
   * the commit to remaining members.
   *
   * @param {string} groupId - group identifier
   * @param {number} leafIndex - leaf node index to remove
   */
  async removeGroupMemberClient(groupId, leafIndex) {
    const actor = await getCurrentActor();
    const result = await this.mlsService.removeGroupMemberClient(actor.id, groupId, [leafIndex]);
    await this._distributeCommit(actor, groupId, result.commit, await this.getGroupMembers(groupId));
    return result;
  }

  /**
   * Remove all of an actor's clients from a group (kick a member).
   * The Rust backend resolves leaf indexes internally by matching member identity.
   *
   * @param {string} groupId - group identifier
   * @param {string} actorIdentity - actor URI of the member to remove
   */
  async removeGroupMember(groupId, actorIdentity) {
    const actor = await getCurrentActor();
    await this.mlsService.getGroup(actor.id, groupId).catch(() => {}); // ensure loaded in Rust memory
    const result = await this.mlsService.removeGroupMember(actor.id, groupId, actorIdentity);
    if (result?.cancelled) return result;

    // Get live MLS members (already updated after remove), persist for page reloads.
    // Explicitly filter out the removed actor in case MLS state is lost and getGroupMembers
    // falls back to the stale IndexedDB list (which still includes the removed actor).
    const currentMembers = await this.getGroupMembers(groupId);
    const afterRemoval = currentMembers.filter(id => id !== actorIdentity);
    const remaining = afterRemoval.filter(id => id !== actor.id);
    await this.persistMembers(groupId, afterRemoval, { replace: true });
    try {
      // Include the removed actor so they receive the Commit and learn they were excluded.
      // In MLS the removed party must process the Commit to update their local state.
      await this._distributeCommit(actor, groupId, result.commit, [...remaining, actorIdentity]);
    } catch (e) {
      console.warn('[removeGroupMember] Failed to distribute commit:', e);
    }
    const nickname = await this._getNickname(actorIdentity);
    await this._insertSystemMessage(groupId, `${nickname} was removed from the group`);
    return result;
  }

  /**
   * Leave a group. Shows a native Rust confirmation dialog.
   * Sends a Commit to remaining members so their epoch advances.
   * Only deletes MLS crypto state locally — message history is preserved.
   */
  async leaveGroup(groupId) {
    const actor = await getCurrentActor();

    await this.mlsService.getGroup(actor.id, groupId).catch(() => {}); // ensure loaded in Rust memory

    const result = await this.mlsService.leaveGroup(actor.id, groupId);
    if (result?.cancelled) return result;

    // Delete local MLS state and mark non-member BEFORE distributing so that any concurrent
    // pollInbox call hits found=false (safe EncryptionLostError path) rather than the
    // PendingProposal state left by mlsService.leaveGroup, which can panic in OpenMLS.
    await this.mlsService.deleteGroup(actor.id, groupId);
    await this.storage.setGroupField(groupId, 'noLongerMember', true);

    // Notify remaining members. Include own actor so co-devices (same actor, different device)
    // receive the self-remove Proposal via the shared inbox.
    const allMembers = await this.getGroupMembers(groupId);
    const remaining = [...new Set([...allMembers.filter(id => id !== actor.id), actor.id])];
    try {
      await this._distributeCommit(actor, groupId, result.commit, remaining);
    } catch (e) {
      console.warn('[leaveGroup] Failed to distribute commit:', e);
    }
    await this._insertSystemMessage(groupId, 'You left this group.');

    return { left: true };
  }

  /**
   * Edit a previously sent message. Updates locally (optimistic) and sends an encrypted
   * Update activity to all group members.
   * @param {string} groupId
   * @param {string} messageId - inner ap-mls:// message ID
   * @param {string} newContent
   */
  /** Send an encrypted Update activity. Saves `updatedContent` to storage and broadcasts to peers. */
  async updateMessageObject(groupId, messageId, updatedContent, storedTimestamp) {
    const actor = await getCurrentActor();
    const { recipients, apId } = await this._groupSendContext(groupId, actor);
    await this.storage.saveMessage(groupId, updatedContent, messageId, true, undefined, undefined, storedTimestamp);
    this._sendEncryptedActivity(groupId, {
      type: 'Update', id: messageUri(),
      object: updatedContent,
    }, recipients, apId);
  }

  async editMessage(groupId, messageId, newContent) {
    const stored = await this._resolveMessage(messageId);
    const updatedContent = { ...(stored?.content || {}), content: newContent };
    return this.updateMessageObject(groupId, stored?.id || messageId, updatedContent, stored?.timestamp);
  }

  /**
   * Delete a previously sent message. Tombstones it locally (wipes content, preserves ID for
   * reply threads) and sends an encrypted Delete activity to all group members.
   * @param {string} groupId
   * @param {string} messageId - inner ap-mls:// message ID
   */
  async deleteMessage(groupId, messageId) {
    const actor = await getCurrentActor();
    const { recipients, apId } = await this._groupSendContext(groupId, actor);
    const stored = await this._resolveMessage(messageId);
    if (stored) this._deleteAttachmentFiles(_collectLocalPaths(stored.content || stored));
    await this.storage.tombstoneMessage(stored?.id || messageId);
    await this._sendEncryptedActivity(groupId, {
      type: 'Delete', id: messageUri(),
      object: stored?.id || messageId,
    }, recipients, apId);
  }

  /** Fire-and-forget: delete local .gz attachment files. */
  _deleteAttachmentFiles(localPaths) {
    for (const p of localPaths) {
      this.mlsService.backend.removeAttachment?.({ localPath: p }).catch(() => {});
    }
  }

  /** DRY helper: resolve recipients + apId for a group send. */
  async _groupSendContext(groupId, actor) {
    const members = await this.getGroupMembers(groupId);
    // Always include own actor so other devices receive messages via own inbox
    const recipients = members.includes(actor.id) ? members : [...members, actor.id];
    const apId = await this.storage.getGroupField(groupId, 'apId', null);
    return { recipients, apId };
  }

  /** DRY helper: extract id from AP object-or-string. */
  _objectId(obj) { return typeof obj === 'string' ? obj : obj?.id || null; }

  /** DRY helper: resolve a message by inner id or outer apId. */
  async _resolveMessage(id) {
    if (!id) return null;
    return (await this.storage.getMessage(id)) || (await this.storage.getMessageByApId(id)) || null;
  }

  /** DRY helper: store the comment Note that accompanies an Announce (send & receive path). */
  async _saveAnnounceComment(groupId, announceId, attributedTo, content, isLocal, id = messageUri()) {
    return this.storage.saveMessage(groupId, {
      type: 'Note', attributedTo,
      content, inReplyTo: announceId, timestamp: Date.now(),
    }, id, isLocal, undefined);
  }

  async likeMessage(groupId, messageId, emoji = '👍') {
    const actor = await getCurrentActor();
    const { recipients, apId } = await this._groupSendContext(groupId, actor);
    const activityId = messageUri();
    await this.storage.addReaction(messageId, actor.id, emoji, activityId);
    await this._sendEncryptedActivity(groupId, {
      type: 'Like', id: activityId,
      object: messageId,
      content: emoji,
    }, recipients, apId);
  }

  async undoLike(groupId, messageId, emoji = '👍') {
    const actor = await getCurrentActor();
    const { recipients, apId } = await this._groupSendContext(groupId, actor);
    const reactionActivityId = await this.storage.getReactionActivityId(messageId, actor.id, emoji);
    await this.storage.removeReaction(messageId, actor.id, emoji);
    await this._sendEncryptedActivity(groupId, {
      type: 'Undo', id: messageUri(),
      object: {
        type: 'Like',
        id: reactionActivityId || messageUri(),
        object: messageId,
        content: emoji,
      },
    }, recipients, apId);
  }

  async announceMessage(groupId, messageId, comment = '', _sourceGroupId = null, inlineContent = undefined) {
    const actor = await getCurrentActor();
    const { recipients, apId } = await this._groupSendContext(groupId, actor);
    const announceId = messageUri();
    // Cross-group boost: inline the original message content so recipients can read it without access to the source group
    const objectPayload = inlineContent
      ? { ...inlineContent, id: messageId }
      : messageId;

    await this.storage.saveMessage(groupId, {
      type: 'Announce', attributedTo: actor.id,
      object: messageId, content: null, timestamp: Date.now(),
    }, announceId, true, undefined);
    await this._sendEncryptedActivity(groupId, {
      type: 'Announce', id: announceId,
      object: objectPayload,
    }, recipients, apId);

    if (comment.trim()) {
      const noteId = messageUri();
      await this._saveAnnounceComment(groupId, announceId, actor.id, comment, true, noteId);
      await this._sendEncryptedActivity(groupId, {
        type: 'Note', id: noteId, content: comment, inReplyTo: announceId,
      }, recipients, apId);
    }
    return announceId;
  }

  /**
   * Decommission one of the current actor's other devices.
   * Removes the client (by signatureKey) from ALL groups, then deletes
   * the key package from the server via AP Remove.
   *
   * @param {string} signatureKeyB64 - base64-encoded signature key of the device to remove
   */
  async removeOwnClient(signatureKeyB64) {
    const actor = await getCurrentActor();

    const response = await this.mlsService.decommissionClient(actor.id, signatureKeyB64);
    if (response.cancelled) return { cancelled: true };

    // Distribute commits for each affected group
    for (const { groupId, commit } of response.results) {
      try {
        await this._distributeCommit(actor, groupId, commit, await this.getGroupMembers(groupId));
      } catch (err) {
        console.error(`[removeOwnClient] Failed to distribute commit for group ${groupId}:`, err);
      }
    }

    try {
      await this._deleteKeyPackageForDevice(actor, signatureKeyB64);
    } catch (e) {
      console.warn('[removeOwnClient] Failed to delete key package:', e);
    }
    // Refresh actor cache so _actorHasOtherDevices sees the updated keyPackages
    await getActor(actor.id).then(fresh => {
      localStorage.setItem('actor', JSON.stringify(fresh));
    }).catch(() => {});
    return { cancelled: false };
  }

  // ── Delivery receipts ──────────────────────────────────

  /**
   * Encrypt a payload and send it as a PrivateMessage. Fire-and-forget.
   * `overrides` are merged into the outer AP activity (e.g. for type arrays or plaintext fields).
   */
  _sendEncryptedActivity(groupId, payload, recipients, contextId, inReplyTo, overrides = {}) {
    return (async () => {
      try {
        const actor = await getCurrentActor();
        // Ensure the MLS group is loaded into Rust memory before encrypt — getGroup loads from SQLite.
        await this.mlsService.getGroup(actor.id, groupId).catch(() => {});
        const { pendingId } = await this.mlsService.encrypt(actor.id, groupId, payload);
        const apBody = buildPrivateMessageBody(actor, pendingId, recipients, contextId, { inReplyTo, overrides });
        await ensureFreshToken();
        const accessToken = localStorage.getItem('access_token');
        const res = await this.mlsService.sendMessage(pendingId, actor.outbox, accessToken, apBody);
        if (!res?.ok) await this.mlsService.discardMessage(pendingId);
        else if (res?.id) await this.storage.markProcessed(actor.id, res.id);
        console.log('[receipt] Sent', payload.type, 'for:', payload.object);
      } catch (e) {
        console.warn('[receipt] Failed to send', payload.type, ':', e.message || e);
      }
    })();
  }

  /** Debounced Acknowledge — cancelled if a Read receipt is sent first. */
  _scheduleAck(groupId, innerMessageId, parsed, _actor) {
    if (this._pendingAcks.has(innerMessageId)) return; // already scheduled
    const handle = setTimeout(() => {
      this._pendingAcks.delete(innerMessageId);
      this._sendEncryptedActivity(
        groupId,
        { type: 'Acknowledge', object: innerMessageId, timestamp: Date.now() },
        [parsed.attributedTo],
        parsed.context,
        parsed.id
      );
    }, 3000);
    this._pendingAcks.set(innerMessageId, handle);
  }

  /**
   * Send an Failure receipt when decryption fails.
   * type: ["PrivateMessage", "Failure"] so the server routes it and clients can identify
   * it without decrypting. Also carries an encrypted payload for clients that can decrypt.
   */
  _sendFailureReceipt(outerMessageId, parsed, _actor) {
    (async () => {
      try {
        const groupId = await this.storage.getGroupByField('apId', parsed.context);
        if (groupId) {
          this._sendEncryptedActivity(
            groupId,
            { type: 'Failure', object: outerMessageId, timestamp: Date.now() },
            [parsed.attributedTo],
            parsed.context,
            parsed.id,
            { type: ['PrivateMessage', 'Failure'], object: outerMessageId }  // plaintext fallback fields
          );
        } else {
          // No group found — send plaintext-only Failure
          const actor = await getCurrentActor();
          await postToOutbox(actor, {
            type: ['PrivateMessage', 'Failure'],
            attributedTo: actor.id,
            to: [parsed.attributedTo],
            object: outerMessageId
          }, this.storage);
          console.log('[receipt] Sent plaintext Failure (no group) for:', outerMessageId);
        }
      } catch (e) {
        console.warn('[receipt] Failed to send Failure:', e.message || e);
      }
    })();
  }

  /** Handle incoming encrypted Acknowledge — update delivery status on the referenced message. */
  async _handleAcknowledgeReceipt(decryptedContent, parsed, senderSignatureKey) {
    const referencedId = decryptedContent.object;
    if (!referencedId) return null;
    const msg = await this.storage.getMessage(referencedId) || await this.storage.getMessageByApId(referencedId);
    if (msg) {
      const key = senderSignatureKey || parsed.attributedTo;
      // Don't overwrite engagement receipts (Read/Listen/View) with a plain Acknowledge
      const existing = msg.deliveryStatus?.[key];
      if (existing && ['Read', 'Listen', 'View'].includes(existing.status)) {
        return { type: 'receipt', groupId: msg.groupId };
      }
      const entry = senderSignatureKey ? { actorId: parsed.attributedTo, status: 'acknowledged' } : { status: 'acknowledged' };
      await this.storage.updateDeliveryStatus(msg.id, key, entry);
      console.log('[receipt] Acknowledged by', parsed.attributedTo, '(client:', senderSignatureKey?.slice(0, 8), ') for message:', msg.id);
      return { type: 'receipt', groupId: msg.groupId };
    }
    return null;
  }

  /**
   * Handle incoming Failure receipt.
   * Decrypts the Failure when possible (confirms encryption works in the other direction).
   * Falls back to the plaintext `object` field for message lookup.
   */
  async _handleFailureReceipt(activity) {
    const fromActorId = activity.attributedTo || activity.actor;
    if (!fromActorId) return null;

    let referencedId = activity.object;
    // Assume keys_broken until we successfully decrypt the encrypted payload
    let deliveryStatus = 'keys_broken';

    let senderSignatureKey = null;
    if (activity.content && activity.encoding === 'base64') {
      try {
        const actor = await getCurrentActor();
        const ciphertext = bytesFromInput(activity.content);
        const groupId = await this.storage.getGroupByField('apId', activity.context);
        if (groupId) {
          const decrypted = await this.mlsService.decrypt(actor.id, groupId, ciphertext);
          // decrypted = { content, senderIdentity, senderSignatureKey }
          const inner = decrypted?.content;
          if (inner?.object) referencedId = inner.object;
          if (decrypted?.senderSignatureKey) senderSignatureKey = decrypted.senderSignatureKey;
          deliveryStatus = 'failed'; // encrypted Failure — only their incoming decryption failed
        }
      } catch {}
    }

    if (!referencedId) return null;
    const msg = await this.storage.getMessage(referencedId) || await this.storage.getMessageByApId(referencedId);
    if (msg) {
      const key = senderSignatureKey || fromActorId;
      const entry = senderSignatureKey ? { actorId: fromActorId, status: deliveryStatus } : { status: deliveryStatus };
      await this.storage.updateDeliveryStatus(msg.id, key, entry);
      console.log('[receipt] Failure from', fromActorId, '(client:', senderSignatureKey?.slice(0, 8), ') status:', deliveryStatus, 'for message:', msg.id);
      return { type: 'receipt', groupId: msg.groupId };
    }
    return null;
  }

  // ── Helpers ────────────────────────────────────────────

  /**
   * Extract a display nickname from an actor URI.
   */
  /**
   * Return a stable color index for a given actor ID.
   * The same actor always gets the same index (within a session).
   */
  getActorColorIndex(actorId, paletteSize) {
    if (!actorId) return 0;
    if (!this._actorColorMap) this._actorColorMap = new Map();
    if (this._actorColorMap.has(actorId)) return this._actorColorMap.get(actorId);
    const idx = this._actorColorMap.size % paletteSize;
    this._actorColorMap.set(actorId, idx);
    return idx;
  }

  /**
   * Extract and persist an actor's profile from a full AP actor object.
   */
  async _saveActorProfileFromAP(actor) {
    if (!actor?.id) return;
    const iconUrl = typeof actor.icon === 'string' ? actor.icon
      : actor.icon?.url || actor.icon?.href || null;
    await this.storage.saveActorProfile(actor.id, {
      name: actor.name || null,
      preferredUsername: actor.preferredUsername || null,
      icon: iconUrl
    });
  }

  /**
   * Re-fetch my actor's profile from the server and update storage + localStorage cache.
   * Fire-and-forget — errors are silently logged.
   */
  _refreshMyActorProfile(actorId) {
    getActor(actorId).then(async (actor) => {
      await this._saveActorProfileFromAP(actor);
      // Also update the localStorage cache so getCurrentActor() returns fresh data
      localStorage.setItem('actor', JSON.stringify(actor));
      console.log('[ChatController] Refreshed actor profile:', actorId);
    }).catch(e => {
      console.warn('[ChatController] Background profile refresh failed:', e.message || e);
    });
  }

  /**
   * Get a stored actor profile (name, avatar, etc.) from Dexie.
   */
  async getActorProfile(actorId) {
    if (!actorId) return null;
    return this.storage.getActorProfile(actorId);
  }

  /**
   * Resolve a single recipient input (mention or URI), fetch their key package
   * and profile. Returns a result object for the UI to display.
   */
  async resolveRecipient(input) {
    const currentDomain = this.currentActorId ? new URL(this.currentActorId).hostname : null;
    const actorUri = await resolveActorId(input, currentDomain);
    if (!actorUri) return { input, resolved: false, error: 'Could not resolve actor' };
    if (actorUri === this.currentActorId) return { input, resolved: false, error: 'Cannot add yourself' };

    let hasKey = false;
    let fingerprint = null;
    let keyError = null;
    try {
      const kpBytes = await this.fetchLatestKeyPackage(actorUri);
      if (kpBytes) {
        hasKey = true;
        const kpB64 = bytesToBase64(kpBytes);
        const fp = await this.mlsService.getKeyPackageFingerprint(kpB64).catch(e => {
          console.warn('[resolveRecipient] getKeyPackageFingerprint failed:', e);
          keyError = e?.message || String(e);
          return null;
        });
        if (fp?.fingerprint) fingerprint = fp.fingerprint;
      }
    } catch {}

    const profile = await this.getActorProfile(actorUri);
    return {
      input, resolved: true, actorUri,
      displayName: profile?.name || this.getActorNickname(actorUri),
      avatar: profile?.icon || null,
      hasKey, fingerprint,
      error: !hasKey ? 'No encryption key available' : keyError || null
    };
  }

  async _getNickname(actorId) {
    if (!actorId) return 'Someone';
    const profile = await this.storage.loadUserState(actorId);
    return this.getActorNickname(actorId, profile);
  }

  getActorNickname(actorId, profile) {
    if (!actorId) return null;
    const p = profile || this.storage.loadUserState?.(actorId);
    // If we have a cached profile preferredUsername, use it (append @host if not already remote)
    const pref = (p instanceof Promise ? null : p)?.preferredUsername;
    if (pref) {
      if (pref.includes('@')) return pref;
      try { return pref + '@' + new URL(actorId).host; } catch {}
      return pref;
    }
    try {
      const url = new URL(actorId);
      const parts = url.pathname.split('/').filter(Boolean);
      return parts[parts.length - 1].replace(/^@/, '') + '@' + url.host;
    } catch {
      return actorId;
    }
  }

  /**
   * Return structured member data for the members panel:
   * [{ identity, isOwn, clients }]
   * Fingerprints are grouped by actor identity.
   */
  async getGroupMembersData(groupId) {
    const fingerprints = await this.getGroupFingerprints(groupId);
    const byActor = new Map();
    for (const fp of fingerprints) {
      if (!byActor.has(fp.identity)) byActor.set(fp.identity, []);
      byActor.get(fp.identity).push(fp);
    }
    return Array.from(byActor.entries()).map(([identity, clients]) => ({
      identity,
      isOwn: clients[0].isOwn,
      clients,
    }));
  }

  /**
   * Resolve AP ID from a postToOutbox response, fetching the activity if needed.
   */
  async _resolveApId(res) {
    if (!res) return null;

    // Case 1: embedded object
    if (res.object && typeof res.object === 'object' && res.object.id) {
      return res.object.id;
    }
    // Case 2: object URI string
    if (res.object && typeof res.object === 'string') {
      return res.object;
    }
    // Case 3: activity ID — need to fetch
    if (res.id) {
      try {
        const activityRes = await apFetch(res.id);
        const data = await activityRes.json();
        if (data.object && typeof data.object === 'object' && data.object.id) return data.object.id;
        if (data.object && typeof data.object === 'string') return data.object;
      } catch (e) {
        console.error('Failed to fetch activity:', e);
      }
    }
    return null;
  }
}

function uniqueActors(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}
