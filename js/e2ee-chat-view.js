import { html, css, LitElement } from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'
import { getCurrentActor, apFetch, getActorId, getActor } from './activitypub/auth.js'
import { initOpenMLS, OpenMLS } from './openmls/openmls.js'
import { saveMessage, listMessagesInGroup, listGroupsWithLastMessage, saveGroupState, loadGroupState, saveUserKeyPackageDraft, saveUserKeyPackagePublished, loadUserKeyPackage, setKeyPackagePublishedDate, loadUserState } from './openmls/openmlsStorage.js'
import { getUserKeyPackage, createUserKeyPackage } from './openmls/openmlsUser.js'
import { bytesToBase64, hexToBytes, arrayToUint8Array, hasKeyPackage, ulid, bytesFromInput, bytesToHex } from './openmls/openmlsUtils.js'
import { isProcessedActivityId, saveProcessedActivityId } from './openmls/openmlsStorage.js';

export class E2EEChatView extends LitElement {
  static styles = css`
    .chat-container {
      display: flex;
      height: 80vh;
      max-width: 100vw;
    }
    .group-list {
      width: 300px;
      border-right: 1px solid #e5e7eb;
      overflow-y: auto;
      background: #f9fafb;
    }
    .group-item {
      padding: 1rem;
      border-bottom: 1px solid #e5e7eb;
      cursor: pointer;
    }
    .group-item.selected {
      background: #e0e7ff;
    }
    .messages-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: #fff;
    }
    .messages-list {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .message-bubble {
      max-width: 70%;
      padding: 0.75rem;
      border-radius: 0.75rem;
      margin-bottom: 0.5rem;
    }
    .message-sent {
      align-self: flex-end;
      background: #2563eb;
      color: white;
      border-bottom-right-radius: 0.25rem;
    }
    .message-received {
      align-self: flex-start;
      background: #f3f4f6;
      color: #1f2937;
      border-bottom-left-radius: 0.25rem;
    }
    .message-actor {
      font-size: 0.75rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
      opacity: 0.8;
    }
    .message-name {
      font-weight: 700;
      font-size: 1.1rem;
      margin-bottom: 0.5rem;
    }
    .message-summary {
      font-style: italic;
      font-size: 0.9rem;
      margin-bottom: 0.5rem;
      opacity: 0.9;
    }
    .message-content {
      line-height: 1.4;
    }
    .toggle-content-btn {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      margin-top: 0.5rem;
      background: rgba(0,0,0,0.1);
      border: none;
      border-radius: 0.25rem;
      cursor: pointer;
    }
    .message-inputs {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 1rem;
      border-top: 1px solid #e5e7eb;
      background: #f3f4f6;
    }
    .input {
      flex: 1;
      border-radius: 0.5rem;
      border: 1px solid #e5e7eb;
      padding: 0.75rem;
      font-size: 1rem;
    }
    .send-btn {
      border-radius: 0.5rem;
      background: #2563eb;
      color: #fff;
      padding: 0.75rem 1.5rem;
      font-size: 1rem;
      border: none;
      cursor: pointer;
    }
  `;

  static get properties() {
    return {
      groups: { type: Array, state: true },
      selectedGroupId: { type: String, state: true },
      messages: { type: Array, state: true },
      input: { type: String, state: true },
      name: { type: String, state: true },
      summary: { type: String, state: true },
      to: { type: String, state: true },
      loading: { type: Boolean, state: true },
      error: { type: String, state: true }
    }
  }

  constructor() {
    super()
    this.groups = []
    this.selectedGroupId = null
    this.messages = []
    this.input = ''
    this.name = ''
    this.summary = ''
    this.to = ''
    this.creatingNewThread = false
    this.loading = false
    this.error = ''
  }

  async connectedCallback() {
    super.connectedCallback();
    const actor = await getCurrentActor();
    await this.ensurePublishedKeyPackage(actor);
    await this.loadGroups();

    // Poll inbox for new messages every 5 seconds?
    // this.inboxPollingInterval = setInterval(() => {
    //   this.pollInbox();
    // }, 5000);

    // Initial poll
    this.pollInbox();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.inboxPollingInterval) {
      clearInterval(this.inboxPollingInterval);
    }
  }

  async pollInbox() {
    try {
      const actor = await getCurrentActor();
      const inboxUrl = typeof actor.inbox === 'string' ? actor.inbox : actor.inbox.id;
      console.log('[Inbox] Polling inbox:', inboxUrl);

      const res = await apFetch(inboxUrl, { headers: { Accept: 'application/activity+json' } });
      if (!res.ok) {
        console.warn('[Inbox] Failed to fetch inbox, status:', res.status);
        return;
      }

      const inbox = await res.json();
      console.log('[Inbox] Raw inbox response:', inbox);

      // First check if the response itself is a page with items
      let items = [];

      // Check for direct items in response (this is what Bonfire returns)
      if (inbox.orderedItems && Array.isArray(inbox.orderedItems)) {
        items = inbox.orderedItems;
        console.log('[Inbox] Found', items.length, 'orderedItems directly in response');
      } else if (inbox.items && Array.isArray(inbox.items)) {
        items = inbox.items;
        console.log('[Inbox] Found', items.length, 'items directly in response');
      }

      // If still no items and there's a first page
      if (items.length === 0 && inbox.first) {
        // first might be an object with orderedItems, or a URL string
        if (typeof inbox.first === 'object' && (inbox.first.orderedItems || inbox.first.items)) {
          items = inbox.first.orderedItems || inbox.first.items;
          console.log('[Inbox] Found', items.length, 'items in embedded first page object');
        } else {
          // It's a URL string or an object with an id - fetch it
          const firstPageUrl = typeof inbox.first === 'string' ? inbox.first : inbox.first.id;
          if (firstPageUrl) {
            console.log('[Inbox] Fetching first page from URL:', firstPageUrl);
            try {
              const pageRes = await apFetch(firstPageUrl, { headers: { Accept: 'application/activity+json' } });
              if (pageRes.ok) {
                const page = await pageRes.json();
                items = page.orderedItems || page.items || [];
                console.log('[Inbox] Found', items.length, 'items in fetched first page');
              }
            } catch (e) {
              console.error('[Inbox] Error fetching first page:', e);
            }
          }
        }
      }

      // Process recent items (last 10) - REVERSE order so oldest/setup messages are processed first
      const itemsToProcess = items.slice(0, 10).reverse();
      let processedChanged = false;
      for (const item of itemsToProcess) {
        // Skip if already processed
        const itemId = item.id || item.object?.id;

        if (!itemId) {
          console.warn('[Inbox] Activity has no ID, skipping as cannot track processed status:', item);
        } else {
          if (await isProcessedActivityId(actor.id, itemId)) {
            console.log('[Inbox] Skipping already processed activity:', itemId);
          } else {
            const result = await this.handleInboxActivity(item);
            if (result) {
              console.log('[Inbox] Processed activity:', result, 'ID:', itemId);
              await saveProcessedActivityId(actor.id, itemId);
              processedChanged = true;
            } else {
              console.log('[Inbox] No action taken for activity ID:', itemId);
            }
          }
        }
      }
    } catch (e) {
      console.error('[Inbox] Error polling inbox:', e);
    }
  }


  async listGroupsWithLastMessageDecrypted() {
    const groupsWithLast = await listGroupsWithLastMessage();
    console.log('Loaded groups with last message:', groupsWithLast);

    let groups = groupsWithLast.map(g => {
      let lastMessage = g.lastMessage;
        let decryptedContent = null;

      // Messages are now stored decrypted, so just extract the content
      if (lastMessage && lastMessage.content) {
        // Handle object with content field
        decryptedContent = lastMessage.content;
      } else if (lastMessage) {
        // Handle direct content
        decryptedContent = lastMessage;
      }

        return {
          id: g.groupId,
          isGroup: true,
          lastMessage: lastMessage,
          groupState: g.groupState,
          encrypted: false, // Messages are stored decrypted now
          decryptedContent
        };
    });

      return groups;
    }

  async _loadActivities() {
    this._isLoading = true
    const activitiesJSON = localStorage.getItem('inbox-activities')
    const cached = activitiesJSON ? JSON.parse(activitiesJSON) : []

    if (cached.length > 0) {
      this._activities = [...cached].slice(0, this.MAX_ACTIVITIES)
    }

    let inbox = localStorage.getItem('inbox')
    if (!inbox) {
      const actor = await getCurrentActor()
      inbox = await this.toId(actor.inbox)
      localStorage.setItem('inbox', inbox)
    }

    const latestId = cached && cached.length > 0 ? cached[0].id : null
    const activities = []
    for await (const activity of this.items(inbox)) {
      let displayActivity = activity
      await this.handleInboxActivity(activity)

      if (activity.object && isMLSMessage(activity.object)) {
        try {
          const decrypted = await decryptMessage(this.groupId, activity.object.content)
          displayActivity = {
            ...activity,
            decryptedContent: decrypted,
            isEncrypted: true
          }
        } catch {
          displayActivity = {
            ...activity,
            decryptedContent: '[decryption failed]',
            isEncrypted: true
          }
        }
      }

      if (!isActivity(activity)) {
        continue
      }
      if (latestId && activity.id === latestId) {
        break
      }
      activities.push(displayActivity)
      if (activities.length >= this.MAX_ACTIVITIES) {
        break
      }
      const timestamp = activity.updated ? activity.updated : activity.published
      if (new Date(timestamp).getTime() <= Date.now() - this.MAX_TIME_WINDOW) {
        break
      }
    }

    this._activities = [...this._activities, ...activities]
    if (this._activities) {
      localStorage.setItem('inbox-activities', JSON.stringify(this._activities))
    }
    this._isLoading = false
  }


  async loadGroups() {
    this.loading = true
    try {
      let groups = await this.listGroupsWithLastMessageDecrypted();
      // Sort groups by most recent ULID (descending)
      groups.sort((a, b) => {
        const aUlid = a.lastMessage && a.lastMessage.id ? a.lastMessage.id.replace(/^uri:uuid:/, '') : a.id;
        const bUlid = b.lastMessage && b.lastMessage.id ? b.lastMessage.id.replace(/^uri:uuid:/, '') : b.id;
        return bUlid.localeCompare(aUlid);
      });
      this.groups = groups;
      console.log('Decrypted groups with last messages:', this.groups);
      if (this.groups.length > 0 && !this.selectedGroupId) {
        this.selectedGroupId = this.groups[0].id;
        await this.loadMessages(this.selectedGroupId);
      }
    } catch (e) {
      console.log('Error loading groups:', e);
      this.error = e.message
    }
    this.loading = false
    }

  async loadMessages(groupId) {
    this.loading = true
    this.selectedGroupId = groupId;
    try {
      const arr = await listMessagesInGroup(groupId);
      console.log('[LoadMessages] Found', arr.length, 'messages for group:', groupId);

      // TODO: backfill from ActivityPub collection if needed?
      // const encryptedBackfillArr = await fetchEncryptedMessagesByGroup(this.context || this.groupId)
      // this.messages = (await Promise.all(encryptedBackfillArr.map(async m => {
      //   try {
      //     const msg = await decryptMessage(this.groupId, m)
      //     // Filter: match context (thread/group) or inReplyTo
      //     if (
      //       (this.context && msg.context === this.context) ||
      //       (this.groupId && msg.context === this.groupId) ||
      //       (this.replyToId && msg.inReplyTo === this.replyToId)
      //     ) {
      //       return msg
      //     }
      //     return null
      //   } catch {
      //     return null
      //   }
      // }))).filter(Boolean)

      // Keep the full message object with isLocal flag and content
      this.messages = arr.map(m => ({
        isLocal: m.isLocal,
        attributedTo: m.content?.attributedTo,
        ...m.content
      }));

    } catch (e) {
      this.error = e.message
    }
    this.loading = false
    }

  async maybeDecryptContent(message, groupId) {
    // NOTE: This method is now mostly unused since messages are decrypted immediately
    // upon receipt and stored in plaintext. Kept for backwards compatibility.

    // If message is local (our own), it's already decrypted
    if (message.isLocal) {
      return message.content;
    }

    // Get the content - it might be the message object or already the content string
    const content = typeof message === 'string' ? message :
      (typeof message.content === 'string' ? message.content :
        (message.content?.content || message.content));

    if (!content || typeof content !== 'string') {
      console.error('[Decrypt] Invalid content type:', typeof content, message);
      return "Invalid message content.";
    }

    try {
      const actor = await getCurrentActor();

      // Use getGroup() to retrieve from cache only
      const group = await OpenMLS.getGroup(groupId, actor.id);
      console.log('[Decrypt] Attempting to decrypt content of length:', content.length);
      const decrypted = await group.decrypt(content);
      if (decrypted && typeof decrypted === 'object' && decrypted.content) {
        console.log('[Decrypt] Successfully decrypted message');
        return decrypted.content;
      } else if (typeof decrypted === 'string') {
        console.log('[Decrypt] Successfully decrypted message');
        return decrypted;
      } else {
        console.warn('[Decrypt] Decryption returned unexpected type:', typeof decrypted);
        return String(decrypted || '[Empty decrypted content]');
      }
    } catch (error) {
      console.error('[Decrypt] Failed to decrypt message:', error, 'Message:', message);
      return "Failed to decrypt message: " + error.message;
    }
  }

  async sendMessage() {
    if (!this.input.trim() || !this.selectedGroupId) return;
    this.loading = true;
    try {
      const actor = await getCurrentActor();
      // Use getGroup() since the group must already exist to send messages
      const group = await OpenMLS.getGroup(this.selectedGroupId, actor.id);
      const msgObj = {
        type: 'Note',
        id: 'uri:uuid:' + ulid(),
        summary: this.summary.trim(),
        content: this.input.trim(),
        attributedTo: actor.id
      };
      let toUris = [];
      if (this.creatingNewThread) {
        msgObj.name = this.name.trim();
        toUris = await this.resolveRecipientUris();
        this.to = '';
        await saveMessage(this.selectedGroupId, { type: 'GroupInfo', toActors: toUris }, 'groupinfo-' + this.selectedGroupId, true);

        const successfulInvites = [];
        for (const recipient of toUris) {
          try {
            const kpBytes = await this.fetchLatestKeyPackage(recipient);
            if (!kpBytes) {
              this.error = `No KeyPackage for ${recipient}, so they were not included.`;
              continue;
            }
            const { welcome, ratchetTree } = await group.addMember(kpBytes);
            console.log('[Invite] Welcome bytes:', welcome && welcome.length, 'RatchetTree bytes:', ratchetTree && ratchetTree.length);
            await this.sendMLSControl('Welcome', bytesToBase64(welcome), [recipient]);
            await this.sendMLSControl('GroupInfo', bytesToBase64(ratchetTree), [recipient]);
            successfulInvites.push(recipient);
          } catch (err) {
            console.error('Failed to invite', recipient, err);
            this.error = `Failed to invite ${recipient}: ${err.message} (so they were not included).`;
            continue;
          }
        }
        const members = this.uniqueActors([actor.id, ...successfulInvites]);
        await this.persistMembers(this.selectedGroupId, members);
      }

      this.input = '';
      this.name = '';
      this.summary = '';
      this.creatingNewThread = false;

      await saveMessage(this.selectedGroupId, msgObj, msgObj.id, true);
      await this.loadMessages(this.selectedGroupId);
      await this.loadGroups();

      const ciphertext = await this.encryptMessage(msgObj);
      const members = await this.getGroupMembers(this.selectedGroupId);
      const recipients = members && members.length ? members : toUris;
      await this.transmitMessage(ciphertext, group, recipients && recipients.length ? recipients : [actor.id]);
    } catch (e) {
      this.error = e.message;
    }
    this.loading = false;
  }

  async encryptMessage(plaintext) {
    try {
      const actor = await getCurrentActor();

      if (!this.group) {
        // Use getGroup() since group must already exist to encrypt
        this.group = await OpenMLS.getGroup(this.selectedGroupId, actor.id);
      }
      const ciphertextArr = this.group.encrypt(plaintext);
      return btoa(String.fromCharCode(...ciphertextArr));
    } catch (error) {
      console.error('Failed to encrypt message:', error);
      throw error;
    }
  }

  async resolveRecipientUris() {
    let toUris = (this.to || '').split(/\s+/).map(s => s.trim()).filter(Boolean);
    const actor = await getCurrentActor();
    const currentDomain = actor.id ? (new URL(actor.id)).hostname : '';
    toUris = await Promise.all(toUris.map(async s => {
      if (/^@?[^@\s]+(@[^@\s]+)?$/.test(s)) {
        let mention = s.replace(/^@/, '');
        if (!mention.includes('@')) {
          mention = `${mention}@${currentDomain}`;
        }
        try {
          return await getActorId(mention);
        } catch (e) {
          this.error = `Failed to resolve mention: ${s}`;
          return null;
        }
      }
      return s;
    }));
    return toUris.filter(Boolean);
  }

  async extractKeyPackageContent(kp) {
    // Handle string (URL to fetch)
    if (typeof kp === 'string') {
      const res = await apFetch(kp, { headers: { Accept: 'application/activity+json' } });
      if (!res.ok) return null;
      kp = await res.json();
    }

    // Handle collection with items array
    if (kp && Array.isArray(kp.items) && kp.items.length) {
      const first = kp.items[0];
      if (typeof first === 'string') {
        const res = await apFetch(first, { headers: { Accept: 'application/activity+json' } });
        if (!res.ok) return null;
        kp = await res.json();
      } else {
        kp = first;
      }
    }

    // Handle direct array format
    if (Array.isArray(kp) && kp.length > 0) {
      kp = kp[0];
      if (typeof kp === 'string') {
        const res = await apFetch(kp, { headers: { Accept: 'application/activity+json' } });
        if (!res.ok) return null;
        kp = await res.json();
      }
    }

    return kp && kp.content ? kp.content : null;
  }

  async fetchLatestKeyPackage(actorUri) {
    try {
      // Always try to fetch the latest published KeyPackage first
      const actor = await getActor(actorUri);
      let kp = actor.keyPackages;
      if (kp) {
        console.log('[KeyPackage] Fetching published KeyPackage for', actorUri, kp);
        const content = await this.extractKeyPackageContent(kp);
        if (content) {
          console.log('[KeyPackage] Key content fetched:', content);
          await saveUserKeyPackagePublished(actorUri, content);
          const contentBytes = bytesFromInput(content);
          console.log('[KeyPackage] Key (bytes):', contentBytes);
          return contentBytes;
        }
      }
      // Fallback to cache if no published KeyPackage found
      const cached = await loadUserKeyPackage(actorUri);
      if (cached) {
        const cachedBytes = bytesFromInput(cached);
        console.warn('[KeyPackage] Using cached KeyPackage as fallback:', cached);
        console.warn('[KeyPackage] Cached (hex):', bytesToHex(cachedBytes));
        return cachedBytes;
      }
    } catch (err) {
      console.error('Failed to fetch key package for', actorUri, err);
      // Fallback to cache if fetch fails
      const cached = await loadUserKeyPackage(actorUri);
      if (cached) {
        const cachedBytes = bytesFromInput(cached);
        console.warn('[KeyPackage] Using cached KeyPackage as fallback after error:', cached);
        console.warn('[KeyPackage] Cached (hex):', bytesToHex(cachedBytes));
        return cachedBytes;
      }
    }
    return null;
  }

  async sendMLSControl(type, contentB64, recipients) {
    const actor = await getCurrentActor();
    const controlObj = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://purl.archive.org/socialweb/mls'
      ],
      type,
      attributedTo: actor.id,
      to: recipients,
      mediaType: 'message/mls',
      encoding: 'base64',
      content: contentB64,
      summary: `MLS ${type} for group ${this.selectedGroupId}`,
      context: this.selectedGroupId // TODO: AP URI
    };
    const res = await this.postActivity(actor, controlObj);
    if (res && (res.ok === false || res.status >= 400)) {
      throw new Error('Failed to send MLS control: ' + (res.status || 'unknown status'));
    } else {
      console.log(`MLS ${type} sent to`, recipients, controlObj);
    }
  }

  async ensurePublishedKeyPackage(actor) {
    const loaded = await getUserKeyPackage(actor.id);
    let keyPackage, keyPackageHex, kpBytes, kpB64;
    if (!loaded || !loaded.keyPackageHex) {
      console.warn('[KeyPackage] No KeyPackage found, creating new one.');
      const created = await createUserKeyPackage(actor.id, loaded.provider, loaded.identity);
      keyPackage = created.keyPackage;
      keyPackageHex = created.keyPackageHex;
    } else {
      const openMLS = await initOpenMLS();
      console.log('[KeyPackage] Loaded existing KeyPackage from storage', loaded);
      let bytes = bytesFromInput(loaded.keyPackageHex)
      keyPackage = openMLS.KeyPackage.from_bytes(bytes);
      keyPackageHex = loaded.keyPackageHex;
    }
    kpBytes = keyPackage.to_bytes();
    kpB64 = bytesToBase64(kpBytes);
    const state = await loadUserState(actor.id);
    const existingKeyPackage = state.keyPackage;
    const publishedDate = state.publishedDate;
    console.log('[KeyPackage] ensurePublishedKeyPackage comparison:',
      {
        existingKeyPackage,
        keyPackageHex,
        kpB64,
        publishedDate
      });
    if (existingKeyPackage && (existingKeyPackage === keyPackageHex || existingKeyPackage === kpB64)) {



      if (publishedDate) {
        console.log('[KeyPackage] Already published and up to date. Last published:', publishedDate);
        // const kpB64 = bytesToBase64(bytes);
        // console.log('[KeyPackage] Existing published KeyPackage (base64):', kpB64);
        return;
    } else {
      console.warn('[KeyPackage] KeyPackage matches but has no publishedDate, republishing.');
    }
  }
    console.log('[KeyPackage] Publishing KeyPackage. Last published:', publishedDate);
    await this.publishKeyPackage(actor, keyPackage);
  }

  async publishKeyPackage(actor, keyPackage) {
    // Accept a KeyPackage object, always use its to_bytes() for publication
    const kpBytes = keyPackage.to_bytes();
    const kpB64 = bytesToBase64(kpBytes);

    console.log('Publishing KeyPackage:', {
      bytesLength: kpBytes.length,
      base64Length: kpB64.length,
      base64: kpB64
    });

    const keyPackages = actor.keyPackages;
    const target = keyPackages ? (typeof keyPackages === 'string' ? keyPackages : keyPackages.id) : null;

    // const kpId = target ? `${target.replace(/\/?$/, '/')}${ulid()}` : `${actor.id}/keypackage/${ulid()}`;
    const keyPackageObj = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://purl.archive.org/socialweb/mls'
      ],
      type: 'KeyPackage',
      // id: kpId,
      attributedTo: actor.id,
      to: 'as:Public',
      summary: 'MLS KeyPackage',
      mediaType: 'message/mls',
      encoding: 'base64',
      content: kpB64,
      generator: {
        type: 'Application',
        name: 'Bonfire MLS client'
      }
    };

    let published = false;
    if (target) {
      console.log('Adding KeyPackage to existing collection:', target);
      const res = await this.postActivity(actor, {
        type: 'Add',
        actor: actor.id,
        to: 'as:Public',
        object: keyPackageObj,
        target: target
      });
      published = res && res.ok;
    } else {
      // No keyPackages collection, so Update the actor with the new keyPackage
      console.log('Updating actor with keyPackages collection with KeyPackage');
      const res = await this.postActivity(actor, {
        type: 'Update',
        actor: actor.id,
        to: 'as:Public',
        object: {
          id: actor.id,
          type: actor.type,
          keyPackages: [keyPackageObj]
        }
      });
      published = res && res.ok;
    }

    // Cache our published KeyPackage as base64 (what others will fetch)
    await saveUserKeyPackageDraft(actor.id, kpB64);
    if (published) {
      await setKeyPackagePublishedDate(actor.id, Date.now());
      // Clear cached actor so others will fetch the updated KeyPackage
      localStorage.removeItem('actor');
      console.log('[KeyPackage] Cleared cached actor to force refresh of KeyPackage');
    }
  }

  prepareMessage(actor, ciphertext, toUris) {
    const recipients = toUris && toUris.length ? toUris : [actor.id];
    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://purl.archive.org/socialweb/mls'
      ],
      type: 'PrivateMessage',
      attributedTo: actor.id,
      to: recipients,
      summary: 'This is an encrypted message. Please read it using a compatible MLS-capable app.',
      mediaType: 'message/mls',
      encoding: 'base64',
      content: ciphertext,
      context: this.selectedGroupId, // TODO: AP URI
      inReplyTo: this.replyToId || undefined
    };
  }

  async transmitMessage(ciphertext, group, toUris) {
    const actor = await getCurrentActor();
    const apObj = this.prepareMessage(actor, ciphertext, toUris);
    try {
      const res = await this.postActivity(actor, apObj);
      if (res && (res.ok === false || res.status >= 400)) {
        throw new Error('Got HTTP response ' + (res.status || 'unknown status'));
      }
      console.log('ActivityPub message sent:', apObj);
    } catch (e) {
      console.error('Failed to send ActivityPub message:', e);
      this.error = 'Failed to send ActivityPub message: ' + e.message;
    }
  }

  async postActivity(actor, obj) {
    const outbox = actor.outbox;
    const res = await apFetch(outbox, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/activity+json'
      },
      body: JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        ...obj
      })
    });

    let data = {
      status: res.status,
      ok: res.ok
    };

    const contentType = res.headers && res.headers.get ? res.headers.get('content-type') : '';
    try {
    if (contentType && contentType.includes('application/json')) {
      const json = await res.json();
      data = { ...data, ...json };
    } else {
      const text = await res.text();
      data.body = text;
      // Only include preview of HTML errors
      if (text.includes('<!DOCTYPE') || text.includes('<html')) {
        data.error = `Server returned HTML error (status ${res.status})`;
      } else {
        data.error = text;
      }
      }
    } catch (e) {
      data.error = `Failed to parse response: ${e.message}`;
    }

    return data;
  }

  async handleInboxActivity(activity) {
    let obj = activity && activity.object ? activity.object : activity;
    // If object is a URL, fetch it
    if (typeof obj === 'string' && /^https?:\/\//.test(obj)) {
      try {
        const res = await apFetch(obj, { headers: { Accept: 'application/activity+json' } });
        if (res.ok) {
          obj = await res.json();
          console.log('[Handler] Fetched object from URL:', obj);
        } else {
          console.warn('[Handler] Failed to fetch object URL:', obj, res.status);
          return null;
        }
      } catch (e) {
        console.error('[Handler] Error fetching object URL:', obj, e);
        return null;
      }
    }
    if (!obj || !obj.type) {
      console.error('[Handler] Invalid activity object, missing type:', obj);
      return null;
    }
    const types = Array.isArray(obj.type) ? obj.type : [obj.type];
    console.log('[Handler] Processing activity type(s):', types.join(', '), 'ID:', obj.id || activity.id);

    if (!obj.content || !obj.encoding || obj.encoding !== 'base64') {
      console.log('[Handler] Skipping - missing content or not base64 encoded');
      return null;
    }

    const groupId = obj.context || activity.context || this.selectedGroupId;
    if (!groupId) {
      console.log('[Handler] Skipping - no groupId found');
      return null;
    }
    console.log('[Handler] Group ID:', groupId);

    const actor = await getCurrentActor();
    const actorLabel = actor.id;

    if (types.includes('Welcome')) {
      console.log('[Handler] Processing Welcome message for group:', groupId);
      const welcomeBytes = bytesFromInput(obj.content);
      console.log('[Handler] Welcome bytes length:', welcomeBytes.length);

      const state = (await loadGroupState(groupId)) || {};
      const nextState = { ...state, welcome: Array.from(welcomeBytes) };

      // Always save the welcome to storage first
      await saveGroupState(groupId, nextState);
      console.log('[Handler] Saved welcome to storage');

      if (nextState.ratchetTree) {
        console.log('[Handler] Found ratchet tree, attempting to join group');
        const ratchetTreeBytes = Uint8Array.from(nextState.ratchetTree);
        try {
          await OpenMLS.joinFromWelcome(groupId, welcomeBytes, ratchetTreeBytes, actorLabel);
          console.log('[Handler] Successfully joined group');

          // Reload groups after joining new group
          await this.loadGroups();
        } catch (joinError) {
          console.error('[Handler] Failed to join from Welcome:', joinError);
          // Don't throw - we'll try again when the message is decrypted
        }
      } else {
        console.log('[Handler] No ratchet tree yet, waiting for GroupInfo');
      }
      return 'welcome';
    }

    if (types.includes('GroupInfo')) {
      console.log('[Handler] Processing GroupInfo message for group:', groupId);
      const ratchetTreeBytes = bytesFromInput(obj.content);
      console.log('[Handler] RatchetTree bytes length:', ratchetTreeBytes.length);

      const state = (await loadGroupState(groupId)) || {};
      const nextState = { ...state, ratchetTree: Array.from(ratchetTreeBytes) };

      // Always save the ratchet tree to storage first
      await saveGroupState(groupId, nextState);
      console.log('[Handler] Saved ratchet tree to storage');

      if (nextState.welcome) {
        console.log('[Handler] Found welcome, attempting to join group');
        try {
          const welcomeBytes = Uint8Array.from(nextState.welcome);
          console.log('[Handler] groupId:', groupId);
          console.log('[Handler] actor:', actorLabel);
          console.log('[Handler] Welcome bytes:', welcomeBytes);
          console.log('[Handler] ratchetTree bytes:', ratchetTreeBytes);
          await OpenMLS.joinFromWelcome(groupId, welcomeBytes, ratchetTreeBytes, actorLabel);
          console.log('[Handler] Successfully joined group');

          // Reload groups after joining new group
          await this.loadGroups();
        } catch (joinError) {
          console.error('[Handler] Failed to join from Welcome:', joinError);
          // Don't throw - we'll try again when the message is decrypted
        }
      } else {
        console.log('[Handler] No welcome yet, waiting for Welcome message');
      }
      return 'groupinfo';
    }

    // Handle encrypted messages (PrivateMessage type)
    if (types.includes('PrivateMessage')) {
      console.log('[Handler] Processing PrivateMessage for group:', groupId);
      try {
        // Save the encrypted message - store just the base64/hex string
        const messageId = obj.id || 'msg-' + Date.now();
        console.log('[Handler] Received encrypted message:', messageId, 'content length:', obj.content.length);

        // Decrypt the message immediately using cached group
        let decryptedContent;
        try {
          // Use getGroup() which only retrieves from cache - doesn't try to join
          const group = await OpenMLS.getGroup(groupId, actorLabel);
          console.log('[Handler] Decrypting message with cached group...');
          const decrypted = await group.decrypt(obj.content);
          decryptedContent = typeof decrypted === 'object' ? decrypted : { content: decrypted };

          // Include attributedTo from the activity object
          if (obj.attributedTo) {
            decryptedContent.attributedTo = obj.attributedTo;
          }

          console.log('[Handler] Message decrypted successfully:', decryptedContent);

          // Save the decrypted message (not the ciphertext)
          await saveMessage(groupId, decryptedContent, messageId, false);
          console.log('[Handler] Decrypted message saved successfully');
        } catch (decryptError) {
          console.error('[Handler] Failed to decrypt message:', decryptError);
          // Save as encrypted with error marker
          await saveMessage(groupId, {
            error: 'Failed to decrypt: ' + decryptError.message,
            encryptedContent: obj.content,
            attributedTo: obj.attributedTo
          }, messageId, false);
        }

        // Reload messages if this is the selected group
        if (this.selectedGroupId === groupId) {
          console.log('[Handler] This is the selected group, reloading messages');
          await this.loadMessages(groupId);
        }

        // Reload groups to update last message
        console.log('[Handler] Reloading groups to update last message');
        await this.loadGroups();

        return 'message';
      } catch (e) {
        console.error('[Handler] Failed to process received message:', e);
      }
    }

    console.log('[Handler] No matching handler for activity type:', types.join(', '));
    return null;
  }

  decryptedSummary(msg) {
    return typeof msg === 'string' ? msg : msg && (msg.name || msg.summary || msg.content);
  }

  decryptedContent(msg) {
    return typeof msg === 'string' ? msg : msg && msg.content;
  }

  uniqueActors(list) {
    return Array.from(new Set((list || []).filter(Boolean)));
  }

  async persistMembers(groupId, members) {
    const state = (await loadGroupState(groupId)) || {};
    const existing = state.members || [];
    const nextMembers = this.uniqueActors([...existing, ...(members || [])]);
    await saveGroupState(groupId, { ...state, members: nextMembers });
    return nextMembers;
  }

  async getGroupMembers(groupId) {
    const state = (await loadGroupState(groupId)) || {};
    return state.members || [];
  }

  getActorNickname(actorId) {
    // Extract nickname from ActivityPub actor ID
    // e.g., "https://example.com/users/alice" -> "alice"
    // or "https://example.com/@alice" -> "alice"
    if (!actorId) return 'Unknown';
    try {
      const url = new URL(actorId);
      const parts = url.pathname.split('/').filter(Boolean);
      const lastPart = parts[parts.length - 1];
      return lastPart.replace(/^@/, '');
    } catch (e) {
      return actorId;
    }
  }

  render() {
    const isNewThread = this.creatingNewThread;
    return html`
      <div class="chat-container">
        <div class="group-list">
          <button class="send-btn" style="width:90%;margin:1rem;" @click=${() => this.createNewGroup()}>+ New Thread</button>
          <button class="send-btn" style="width:90%;margin:0.5rem 1rem;" @click=${() => this.pollInbox()}>Refresh</button>
          <button class="send-btn" style="width:90%;margin:0.5rem 1rem;background:#e11d48;" @click=${() => this.handleClearKeyPackage()}>Clear My KeyPackage</button>
          ${this.groups.map(g => html`
            <div class="group-item ${this.selectedGroupId === g.id ? 'selected' : ''}" @click=${() => { this.creatingNewThread = false; this.loadMessages(g.id); }}>
              <div>${g.id}</div>
              <div style="font-size:0.9em;color:#555;">${this.decryptedSummary(g.decryptedContent) || this.decryptedSummary(g.lastMessage && g.lastMessage.content) || ''}</div>
            </div>
          `)}
        </div>
        <div class="messages-pane">
          <div class="messages-list">
            ${this.messages.map((msg, idx) => {
              const isSent = msg.isLocal;
              const hasSummary = msg && msg.summary;
              const showContent = this[`showContent${idx}`] || false;
              const actorNickname = msg.attributedTo ? this.getActorNickname(msg.attributedTo) : 'Unknown';

              return html`
                <div class="message-bubble ${isSent ? 'message-sent' : 'message-received'}">
                  ${!isSent ? html`<div class="message-actor">${actorNickname}</div>` : ''}
                  ${msg && msg.name ? html`<div class="message-name">${msg.name}</div>` : ''}
                  ${hasSummary ? html`
                    <div class="message-summary">${msg.summary}</div>
                    <button class="toggle-content-btn" @click=${() => { this[`showContent${idx}`] = !showContent; this.requestUpdate(); }}>
                      ${showContent ? 'Hide' : 'Show'} Content
                    </button>
                  ` : ''}
                  ${!hasSummary || showContent ? html`<div class="message-content">${msg && msg.content}</div>` : ''}
                </div>
              `;
            })}
          </div>
          ${this.selectedGroupId ? html`
          <form class="message-inputs" @submit=${e => { e.preventDefault(); this.sendMessage(); }}>
            ${isNewThread ? html`
              <input class="input" type="text" .value=${this.name} @input=${e => this.name = e.target.value} placeholder="Name (optional)" />
              <input class="input" type="text" .value=${this.to} @input=${e => this.to = e.target.value} placeholder="To (space-separated URIs or @user@domain)" />
            ` : ''}
            <input class="input" type="text" .value=${this.summary} @input=${e => this.summary = e.target.value} placeholder="CW / Summary (optional)" />
            <textarea class="input" .value=${this.input} @input=${e => this.input = e.target.value} placeholder="Type a message..." ></textarea>
            <button class="send-btn" type="submit">Send</button>
          </form>
          ` : ''}
          ${this.error ? html`<div class="text-red-500 mt-2">${this.error}</div>` : ''}
        </div>
      </div>
    `;
  }

  async createNewGroup() {
    this.loading = true;
    try {
      const newGroupId = ulid();
      this.selectedGroupId = newGroupId;
      this.name = '';
      this.to = '';
      this.summary = '';
      this.input = '';
      this.creatingNewThread = true;
      const actor = await getCurrentActor();
      // Use createGroup() since we're creating a new group
      await OpenMLS.createGroup(newGroupId, actor.id);
    } catch (e) {
      this.error = e.message;
    }
    this.loading = false;
  }

  async handleClearKeyPackage() {
    try {
      const actor = await getCurrentActor();
      // Import here to avoid circular dependency at top
      const { clearUserKeyPackage } = await import('./openmls/openmlsUser.js');
      await clearUserKeyPackage(actor.id);
      this.error = 'KeyPackage cleared. Reload to regenerate.';
      window.location.reload();
    } catch (e) {
      this.error = 'Failed to clear KeyPackage: ' + (e.message || e);
    }

  }
}

customElements.define('e2ee-chat-view', E2EEChatView)

