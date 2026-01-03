import { html, css, LitElement } from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'
import { getCurrentActor, apFetch, getActorId, getActor } from './activitypub/auth.js'
import { OpenMLS } from './openmls/openmls.js'
import { saveMessage, listMessagesInGroup, listGroupsWithLastMessage, saveGroupState, loadGroupState, saveUserKeyPackageDraft, saveUserKeyPackagePublished, loadUserKeyPackage, getKeyPackageLastPublishedDate, setKeyPackagePublishedDate } from './openmls/openmlsStorage.js'
import { getUserKeyPackageHex } from './openmls/openmlsUser.js'
import { bytesToBase64, hexToBytes, arrayToUint8Array, hasKeyPackage, ulid } from './openmls/openmlsUtils.js'
import { ensureKeyPackagesAvailable } from './openmls/openmlsUser.js'

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
    this.processedActivityIds = new Set() // Track processed activities to avoid duplicates
  }

  async connectedCallback() {
    super.connectedCallback();
    await this.ensurePublishedKeyPackage();
    await this.loadGroups();

    // Poll inbox for new messages every 5 seconds ?
    this.inboxPollingInterval = setInterval(() => {
      this.pollInbox();
    }, 5000);

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
      for (const item of itemsToProcess) {
        // Skip if already processed
        const itemId = item.id || item.object?.id;
        if (itemId && this.processedActivityIds.has(itemId)) {
          console.log('[Inbox] Skipping already processed activity:', itemId);
          continue;
        }

        const result = await this.handleInboxActivity(item);
        if (result) {
          console.log('[Inbox] Processed activity:', result, 'ID:', itemId);
          if (itemId) {
            this.processedActivityIds.add(itemId);
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

      let groups = await Promise.all(groupsWithLast.map(async g => {
        let lastMessage = g.lastMessage;
        let encrypted = false;
        let decryptedContent = null;
        // Try to decrypt if lastMessage is encrypted (e.g., base64 string)
        if (lastMessage && typeof lastMessage === 'string' && /[A-Za-z0-9+/=]{16,}/.test(lastMessage)) {
          try {
            decryptedContent = await this.maybeDecryptContent(lastMessage, g.groupId);
            encrypted = true;
          } catch (error) {
            console.error('Error decrypting last message for group:', g.groupId, error);
            decryptedContent = '[decryption failed]';
            encrypted = true;
          }
        }
        return {
          id: g.groupId,
          isGroup: true,
          lastMessage: lastMessage,
          groupState: g.groupState,
          encrypted,
          decryptedContent
        };
      }));

      // TODO backfill or load new messages with _loadActivities()

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

      this.messages = await Promise.all(arr.map(async m => this.maybeDecryptContent(m, groupId)));

    } catch (e) {
      this.error = e.message
    }
    this.loading = false
    }

  async maybeDecryptContent(message, groupId) {
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

      // Check if group state exists before trying to load/create
      const groupState = await loadGroupState(groupId);
      if (!groupState || (!groupState.welcome && !groupState.ratchetTree)) {
        console.warn('[Decrypt] Group state not found - waiting for Welcome+GroupInfo to join');
        return "[Waiting to join group...]";
      }

      // Try to load or create the group
      const group = await OpenMLS.createOrLoad(groupId, actor.id);
      if (!group) {
        console.warn('[Decrypt] Failed to load group');
        return "[Failed to load group]";
      }
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
      const group = await OpenMLS.createOrLoad(this.selectedGroupId, actor.id);
      const msgObj = {
        type: 'Note',
        id: 'uri:uuid:' + ulid(),
        summary: this.summary.trim(),
        content: this.input.trim()
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
        this.group = await OpenMLS.createOrLoad(this.selectedGroupId, actor.id);
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
      const cached = await loadUserKeyPackage(actorUri);
      if (cached) {
        return Uint8Array.from(atob(cached), c => c.charCodeAt(0));
      }
      const actor = await getActor(actorUri);
      let kp = actor.keyPackages;
      if (!kp) return null;

      const content = await this.extractKeyPackageContent(kp);
      if (content) {
        await saveUserKeyPackagePublished(actorUri, content);
        return Uint8Array.from(atob(content), c => c.charCodeAt(0));
      }
    } catch (err) {
      console.error('Failed to fetch key package for', actorUri, err);
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
    }
  }

  async ensurePublishedKeyPackage() {
    const actor = await getCurrentActor();

    // NOTE: Due to OpenMLS WASM's in-memory storage limitation, KeyPackages
    // are regenerated on every page load. This means we need to publish a new
    // KeyPackage each time. Once OpenMLS adds persistent storage support,
    // we can optimize this to only publish when actually needed.
    console.log('Publishing KeyPackage (regenerated due to OpenMLS WASM limitation)...');
    await this.publishKeyPackage(actor);

    // Verify the key package was actually published
    const updatedActor = await getActor(actor.id);
    if (hasKeyPackage(updatedActor.keyPackages)) {
      console.log('KeyPackage publication verified.');
      return true;
    } else {
      console.warn('KeyPackage publication could not be verified');
      return false;
    }
  }

  async publishKeyPackage(actor) {
    const kpHex = await getUserKeyPackageHex(actor.id);
    const kpBytes = hexToBytes(kpHex);
    const kpB64 = bytesToBase64(kpBytes);

    console.log('Publishing KeyPackage:', {
      hexLength: kpHex.length,
      bytesLength: kpBytes.length,
      base64Length: kpB64.length,
      hexPreview: kpHex.slice(0, 40) + '...',
      base64Preview: kpB64.slice(0, 40) + '...'
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

    if (target) {
      await this.postActivity(actor, {
        type: 'Add',
        actor: actor.id,
        to: 'as:Public',
        object: keyPackageObj,
        target: target
      });
    } else {
      // No keyPackages collection, so Update the actor with the new keyPackage
      await this.postActivity(actor, {
        type: 'Update',
        actor: actor.id,
        to: 'as:Public',
        object: {
          id: actor.id,
          type: actor.type,
          keyPackages: [keyPackageObj]
        }
      });
    }

    // Cache our published KeyPackage as base64 (what others will fetch)
    await saveUserKeyPackageDraft(actor.id, kpB64);
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
    const obj = activity && activity.object ? activity.object : activity;
    if (!obj || !obj.type) return null;

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
      const welcomeBytes = Uint8Array.from(atob(obj.content), c => c.charCodeAt(0));
      console.log('[Handler] Welcome bytes length:', welcomeBytes.length);

      const state = (await loadGroupState(groupId)) || {};
      const nextState = { ...state, welcome: Array.from(welcomeBytes) };
      await saveGroupState(groupId, nextState);
      console.log('[Handler] Saved welcome to storage');

      if (nextState.ratchetTree) {
        console.log('[Handler] Found ratchet tree, attempting to join group');
        const ratchetTreeBytes = Uint8Array.from(nextState.ratchetTree);
        try {
          await OpenMLS.joinFromWelcome(groupId, welcomeBytes, ratchetTreeBytes, actorLabel);
          console.log('[Handler] Successfully joined group, reloading groups');
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
      const ratchetTreeBytes = Uint8Array.from(atob(obj.content), c => c.charCodeAt(0));
      console.log('[Handler] RatchetTree bytes length:', ratchetTreeBytes.length);

      const state = (await loadGroupState(groupId)) || {};
      const nextState = { ...state, ratchetTree: Array.from(ratchetTreeBytes) };
      await saveGroupState(groupId, nextState);
      console.log('[Handler] Saved ratchet tree to storage');

      if (nextState.welcome) {
        console.log('[Handler] Found welcome, attempting to join group');
        const welcomeBytes = Uint8Array.from(nextState.welcome);
        try {
          await OpenMLS.joinFromWelcome(groupId, welcomeBytes, ratchetTreeBytes, actorLabel);
          console.log('[Handler] Successfully joined group, reloading groups');
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
        // Save the encrypted message - store just the base64 string
        const messageId = obj.id || 'msg-' + Date.now();
        console.log('[Handler] Saving encrypted message:', messageId, 'content length:', obj.content.length);
        await saveMessage(groupId, obj.content, messageId, false);
        console.log('[Handler] Message saved successfully');

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
        console.error('[Handler] Failed to save received message:', e);
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

  render() {
    const isNewThread = this.creatingNewThread;
    return html`
      <div class="chat-container">
        <div class="group-list">
          <button class="send-btn" style="width:90%;margin:1rem;" @click=${() => this.createNewGroup()}>+ New Thread</button>
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
              const hasSummary = msg && msg.summary;
              const showContent = this[`showContent${idx}`] || false;
              return html`
                <hr/>
                <div class="mb-2">
                  ${msg && msg.name ? html`<strong class="font-bold">${msg.name}</strong>` : ''}
                  ${hasSummary ? html`
                    <div class="italic text-gray-600">${msg.summary}</div>
                    <button class="send-btn" style="margin:0.5em 0;" @click=${() => { this[`showContent${idx}`] = !showContent; this.requestUpdate(); }}>
                      ${showContent ? 'Hide' : 'Show'} Content
                    </button>
                  ` : ''}
                  ${!hasSummary || showContent ? html`<div>${msg && msg.content}</div>` : ''}
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
      await OpenMLS.createOrLoad(newGroupId, actor.id);
    } catch (e) {
      this.error = e.message;
    }
    this.loading = false;
  }
}

customElements.define('e2ee-chat-view', E2EEChatView)

