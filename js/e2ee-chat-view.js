import * as ulidx from "https://cdn.jsdelivr.net/npm/ulidx@2.4.1/+esm"
import { html, css, LitElement } from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'
import { getCurrentActor, apFetch, getActorId } from './activitypub/auth.js'
import { saveMessage, listMessagesInGroup, listGroupsWithLastMessage } from './openmls/openmlsStorage.js'
import { OpenMLS } from './openmls/openmls.js'

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
    }

    async connectedCallback() {
        super.connectedCallback();
        await this.loadGroups();
    }

    ulid() {
        return ulidx.ulid ? ulidx.ulid() : (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))
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
                    console.log(error, 'Failed to decrypt last message for group:', g.groupId);
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
      const timestamp = activity.updated
        ? activity.updated
        : activity.published

      if (new Date(timestamp).getTime() <= Date.now() - this.MAX_TIME_WINDOW) {
        break
      }
    }
    this._activities = [...this._activities, ...activities]
    if (this._activities) {
      localStorage.setItem(
        'inbox-activities',
        JSON.stringify(this._activities)
      )
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
        if (message.isLocal) {
            return message.content;
        }
        try {
            const group = await OpenMLS.createOrLoad(groupId);
            return group.decrypt(message.content);
        } catch (error) {
            console.log('Failed to decrypt message:', message);
            return "Failed to decrypt message.";
        }
    }

    async sendMessage() {
        if (!this.input.trim() || !this.selectedGroupId) return;
        this.loading = true;
        try {
            const group = await OpenMLS.createOrLoad(this.selectedGroupId);
            const msgObj = {
                type: 'Note',
              id: 'uri:uuid:' + this.ulid(),
                summary: this.summary.trim(),
                content: this.input.trim()
            };
          let toUris = [];
          if (this.creatingNewThread) {
            msgObj.name = this.name.trim();
            toUris = (this.to || '').split(/\s+/).map(s => s.trim()).filter(Boolean);
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
            toUris = toUris.filter(Boolean);
            this.to = '';
            // Save toActors in group info
            await saveMessage(this.selectedGroupId, { type: 'GroupInfo', toActors: toUris }, 'groupinfo-' + this.selectedGroupId, true);
          }
            this.input = '';
            this.name = '';
            this.summary = '';
          this.creatingNewThread = false;
          // save the encrypted message in plaintext in local storage 
          await saveMessage(this.selectedGroupId, msgObj, msgObj.id, true);
          await this.loadMessages(this.selectedGroupId);
          await this.loadGroups();
          // encrypt the message for transmission
          const ciphertext = await this.encryptMessage(msgObj)
          // send it
          this.transmitMessage(ciphertext, group, toUris);
        } catch (e) {
            this.error = e.message;
        }
        this.loading = false;
    }

  async encryptMessage(plaintext) {
    // Encrypts and returns base64 ciphertext, updates this.group
    if (!this.group) {
      this.group = await OpenMLS.createOrLoad(this.selectedGroupId)
    }
    const ciphertextArr = this.group.encrypt(plaintext)
    return btoa(String.fromCharCode(...ciphertextArr))
  }


  async transmitMessage(ciphertext, group, toUris) {
    const actor = await getCurrentActor();
    const apObj = {
      type: 'Note',
      to: toUris && toUris.length ? toUris : [actor.id],
      summary: 'This is an encrypted message. Please read it using a compatible app (supporting MLS end-to-end encryption).',
      content: ciphertext,
      mediaType: 'application/mls+json',
      context: this.selectedGroupId, // TODO: should be the matching canonical URI 
      inReplyTo: this.replyToId || undefined // TODO: should be the matching canonical URI 
    };
    try {
      const res = await this.postActivity(actor, apObj);
      if (res && (res.ok === false || res.status >= 400)) {
        throw new Error('Failed to send ActivityPub message: ' + (res.status || 'unknown status'));
      }
      console.log('ActivityPub message sent:', apObj);
    } catch (e) {
      console.error('Failed to send ActivityPub message:', e);
      this.error = 'Failed to send ActivityPub message: ' + e.message;
    }
  }

  async postActivity(actor, obj) {
    const outbox = actor.outbox
    const res = await apFetch(outbox, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/activity+json'
      },
      body: JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        ...obj
      })
    })
    return await res.json()
  }
    
  decryptedSummary(msg) {
    return typeof msg === 'string' ? msg : msg && (msg.name || msg.summary || msg.content)
  }

  decryptedContent(msg) {
    return typeof msg === 'string' ? msg : msg && msg.content
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
      const newGroupId = this.ulid();
      // Set up for new thread: clear name/to/summary/input and set selectedGroupId
      this.selectedGroupId = newGroupId;
      this.name = '';
      this.to = '';
      this.summary = '';
      this.input = '';
      this.creatingNewThread = true;
      await OpenMLS.createOrLoad(newGroupId);
      // Save empty group info with toActors for new thread
      // await saveMessage(newGroupId, { type: 'GroupInfo', toActors: [] }, 'groupinfo-' + newGroupId, true);
      // await this.loadGroups();
    } catch (e) {
      this.error = e.message;
    }
    this.loading = false;
  }
}

customElements.define('e2ee-chat-view', E2EEChatView)
