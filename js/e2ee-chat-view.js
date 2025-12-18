import * as ulidx from "https://cdn.jsdelivr.net/npm/ulidx@2.4.1/+esm"
import { html, css, LitElement } from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'
import { getCurrentActor } from './activitypub/auth.js'
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
    .message-input {
      display: flex;
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

        let activities = await Promise.all(groupsWithLast.map(async g => {
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
        return activities;
    }

    async loadGroups() {
        this.loading = true
        try {
            this.groups = await this.listGroupsWithLastMessageDecrypted();
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
                content: this.input.trim()
            };
            await saveMessage(this.selectedGroupId, msgObj, msgObj.id, true);
            this.input = '';
            await this.loadMessages(this.selectedGroupId);
        } catch (e) {
            this.error = e.message;
        }
        this.loading = false;
    }
    
    decryptedSummary(msg) {
        return typeof msg === 'string' ? msg : msg && (msg.name || msg.summary || this.decryptedContent(msg.content))
    }

    decryptedContent(msg) {
      return  typeof msg === 'string' ? msg : msg && msg.content
    }

  render() {
    return html`
      <div class="chat-container">
        <div class="group-list">
          <button class="send-btn" style="width:90%;margin:1rem;" @click=${() => this.createNewGroup()}>+ New Thread</button>
          ${this.groups.map(g => html`
            <div class="group-item ${this.selectedGroupId === g.id ? 'selected' : ''}" @click=${() => this.loadMessages(g.id)}>
              <div><b>Group:</b> ${g.id}</div>
              <div style="font-size:0.9em;color:#555;">${g.isEncrypted ? '[Encrypted]' : ''} ${this.decryptedSummary(g.decryptedContent) || this.decryptedSummary(g.lastMessage) || ''}</div>
            </div>
          `)}
        </div>
        <div class="messages-pane">
          <div class="messages-list">
            ${this.messages.map(msg => html`<div class="mb-2">${this.decryptedContent(msg)}</div>`)}
          </div>
          <form class="message-input" @submit=${e => { e.preventDefault(); this.sendMessage(); }}>
            <input class="input" type="text" .value=${this.input} @input=${e => this.input = e.target.value} placeholder="Type a message..." />
            <button class="send-btn" type="submit">Send</button>
          </form>
          ${this.error ? html`<div class="text-red-500 mt-2">${this.error}</div>` : ''}
        </div>
      </div>
    `;
  }

  async createNewGroup() {
    this.loading = true;
    try {
      const newGroupId = this.ulid();
      await OpenMLS.createOrLoad(newGroupId);
      await this.loadGroups();
      this.selectedGroupId = newGroupId;
    //   await this.loadMessages(newGroupId);
    } catch (e) {
      this.error = e.message;
    }
    this.loading = false;
  }
}

customElements.define('e2ee-chat-view', E2EEChatView)
