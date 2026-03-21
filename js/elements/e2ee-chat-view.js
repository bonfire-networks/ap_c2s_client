import { html, css, LitElement } from 'lit'
import { relativeTime } from '../utils.js'
import { ChatController, EncryptionLostError } from '../chat-controller.js'
import { MLSService } from '../mls/mls-service.js'
import * as storage from '../storage/indexeddb-storage.js'
import { logout } from '../activitypub/auth.js'
import { adoptDaisyUI, icon } from './shared-styles.js'
import './theme-picker.js'
import './my-devices-panel.js'

export class E2EEChatView extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      padding-top: env(safe-area-inset-top, 0px);
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    .chat-container {
      flex: 1;
      min-height: 0;
      position: relative;
    }
    .drawer-side {
      height: 100% !important;
      background-color: oklch(var(--b2));
    }
    .chat-container:not(.drawer-open) .drawer-side {
      position: absolute !important;
    }
    .chat-container:not(.drawer-open) .drawer-overlay {
      position: absolute !important;
    }
    .group-list {
      overflow-y: auto;
    }
    .messages-pane {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      flex: 1;
      position: relative;
    }
    .drawer-content {
      min-width: 0;
      min-height: 0;
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    .messages-list {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      display: flex;
      flex-direction: column;
    }

    /* Reddit-style thread nesting */
    .thread-root {
      border-bottom: 1px solid oklch(var(--b3) / 0.5);
      padding: 0.5rem 0;
    }
    .thread-root:last-child {
      border-bottom: none;
    }
    .thread-node {
      position: relative;
    }
    .chat {
      padding-top: 0.1rem;
      padding-bottom: 0.1rem;
    }
    .chat-bubble {
      background: var(--bubble-bg, oklch(var(--b2, 1 0 0))) !important;
      color: inherit !important;
    }
    /* position tail based on avatar-bottom height */
    .chat-start .chat-bubble::before {
      bottom: auto !important;
      top: 1.50rem !important;
    }
    .hover-visible {
      visibility: hidden;
      opacity: 0;
      transition: opacity 0.15s;
      pointer-events: none;
    }
    .chat:hover:not(:has(.chat:hover)) .hover-visible {
      visibility: visible;
      opacity: 1;
      pointer-events: auto;
    }
    .chat-start .chat-image {
      align-self: start !important;
      margin-top: 1.1rem;
      position: relative !important;
      overflow: visible !important;
    }
    .chat { overflow: visible !important; }
    .thread-root {
      position: relative;
    }
    .thread-msg-wrap {
      position: relative;
    }
    .thread-children {
      padding-left: 2.25rem;
    }
    /* Stem: drawn on the click overlay. Fades at bottom so all nested stems appear to end at the same point. */
    .thread-stem-click::before {
      content: '';
      position: absolute;
      left: calc(1.125rem - 1px);
      top: 2.225rem;
      bottom: 0;
      width: 2px;
      background: linear-gradient(to bottom, var(--thread-color, var(--color-base-300)) 70%, transparent 100%);
      opacity: 0.5;
      pointer-events: none;
    }
    /* Angled connector: left:-1.125rem = stem x; width:2.3rem lands exactly at avatar center (cos12°); rotate 12deg */
    .thread-children > .thread-root::after {
      content: '';
      position: absolute;
      left: -1.125rem;
      top: 1.75rem;
      width: 2.3rem;
      height: 2px;
      background: var(--thread-color, var(--color-base-300));
      opacity: 0.4;
      transform-origin: left center;
      transform: rotate(12deg);
    }
    /* Invisible wider click target over the stem area to restore collapse-on-click */
    .thread-stem-click {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 2.5rem;
      cursor: pointer;
      z-index: 1;
    }
    .thread-collapsed-indicator {
      font-size: 0.7rem;
      cursor: pointer;
      opacity: 0.5;
    }
    .msg-header {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      font-size: 0.8rem;
      margin-bottom: 0.125rem;
    }
    .msg-author {
      font-weight: 600;
      cursor: pointer;
    }
    .msg-author.self {
      opacity: 0.7;
    }
    .msg-body {
      padding: 0.25rem 0 0.25rem 0;
      line-height: 1.45;
    }
    .msg-actions {
      display: flex;
      gap: 0.5rem;
      font-size: 0.75rem;
      opacity: 0;
      transition: opacity 0.15s;
      padding-bottom: 0.25rem;
    }
    .thread-node:hover .msg-actions,
    .msg-actions:hover {
      opacity: 1;
    }
    @media (hover: none) {
      .msg-actions { opacity: 0.4; }
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
      _resolvedRecipients: { type: Array, state: true },
      _recipientInput: { type: String, state: true },
      _resolvingRecipient: { type: Boolean, state: true },
      loading: { type: Boolean, state: true },
      error: { type: String, state: true },
      replyToId: { type: String, state: true },
      replyToSnippet: { type: String, state: true },
      currentThreadName: { type: String, state: true },
      editingThreadName: { type: Boolean, state: true },
      currentGroupMembers: { type: Array, state: true },
      threadNameIsAutoGenerated: { type: Boolean, state: true },
      currentActorId: { type: String, state: true },
      groupEncryptionLost: { type: Boolean, state: true },
      userLeft: { type: Boolean, state: true },
      sidebarOpen: { type: Boolean, state: true },
      _isWide: { type: Boolean, state: true },
      showCW: { type: Boolean, state: true },
      showMembersPanel: { type: Boolean, state: true },
      _membersData: { type: Array, state: true },
      _membersLoading: { type: Boolean, state: true },
      _highlightedMember: { type: String, state: true },
      _actorProfiles: { type: Object, state: true },
      _deliveryPanel: { type: Object, state: true },
      _reactionPanel: { type: Object, state: true },
      _sendReadReceipts: { type: Boolean, state: true },
      _groupReadReceiptsOverride: { type: Object, state: true }, // null | true | false
      _editingId: { type: String, state: true },
      _editingContent: { type: String, state: true },
      _addMemberInput: { type: String, state: true },
      _addMemberLoading: { type: Boolean, state: true },
      _addMemberError: { type: String, state: true },
      _boostPanel: { type: Object, state: true }, // { msg } | null
      _boostComment: { type: String, state: true },
      _boostTargetGroupId: { type: String, state: true },
      _boostCrossGroup: { type: Boolean, state: true },
    }
  }

  constructor() {
    super()
    this.groups = []
    this.selectedGroupId = null
    this._lgQuery = window.matchMedia('(min-width: 768px)')
    this._isWide = this._lgQuery.matches
    this.sidebarOpen = this._isWide
    this._onResize = (e) => { this._isWide = e.matches; this.sidebarOpen = e.matches }
    this._lgQuery.addEventListener('change', this._onResize)
    this.showCW = false
    this.showMembersPanel = false
    this._membersData = []
    this._membersLoading = false
    this._highlightedMember = null
    this._actorProfiles = new Map()
    this._deliveryPanel = null
    this._reactionPanel = null
    this._sendReadReceipts = false
    this._groupReadReceiptsOverride = null
    this._editingId = null
    this._editingContent = ''
    this._addMemberInput = ''
    this._addMemberLoading = false
    this._boostPanel = null
    this._boostComment = ''
    this._boostTargetGroupId = null
    this._boostCrossGroup = false
    this._addMemberError = null
    this._profileLoadPending = new Set()
    this.messages = []
    this.input = ''
    this.name = ''
    this.summary = ''
    this._resolvedRecipients = []
    this._recipientInput = ''
    this._resolvingRecipient = false
    this.creatingNewGroup = false
    this.loading = false
    this.error = ''
    this.replyToId = null
    this.replyToSnippet = ''
    this.currentThreadName = ''
    this.editingThreadName = false
    this.currentGroupMembers = []
    this.threadNameIsAutoGenerated = false
    this.currentActorId = null
    this.groupEncryptionLost = false
    this.userLeft = false

    this._collapsedThreads = new Set();

    // Colors for thread lines at each depth, cycling
    this._threadColors = [
      'var(--color-primary)',
      'var(--color-secondary)',
      'var(--color-accent)',
      'var(--color-success)',
      'var(--color-warning)',
      'var(--color-info)',
      'var(--color-error)',
      'var(--color-neutral)',
    ];

    // Backend wired up in connectedCallback (async import)
    this.controller = null;
  }

  async connectedCallback() {
    super.connectedCallback();
    adoptDaisyUI(this);
    try {
      // Dynamic backend selection: Tauri native Rust or WASM
      const wasmPath = localStorage.getItem('wasmBasePath');
      const useTauri = wasmPath === 'false' && window.__TAURI__;
      console.log('[ChatView] Using backend:', useTauri ? 'Tauri Rust plugin' : 'OpenMLS WASM');
      const backend = useTauri
        ? await import('../mls/openmls-tauri/tauri-backend.js')
        : await import('../mls/openmls-wasm/openmls-backend.js');
      // Isolate storage per actor so switching accounts doesn't leak data
      const actorId = localStorage.getItem('actor_id');
      if (actorId) storage.initForActor(actorId);

      const mlsService = new MLSService(backend, storage);
      // console.log('[ChatView] MLSService initialized with backend:', mlsService);
      this.controller = new ChatController(mlsService, storage);
      console.log('[ChatView] ChatController initialized:', this.controller);

      const actor = await this.controller.init();
      console.log('[ChatView] Actor initialized:', actor);
      this.currentActorId = actor.id;
      this._sendReadReceipts = await this.controller.storage.loadUserSetting(actor.id, 'sendReadReceipts', false);
      this._ensureActorProfile(actor.id);

      // Set window title with username so multiple instances are distinguishable
      const nickname = this.getActorNickname(actor.id);
      if (window.__TAURI__) {
        window.__TAURI__.window.getCurrentWindow().setTitle(`Secure Chat - ${nickname}`);
      }

      await this.loadGroups();
      this.pollInbox();

      // Deep-link navigation: Rust calls this via eval() when a deep link targets the chat tab
      // mls://g/{ulid} or mls://m/{ulid} = internal IDs (direct IndexedDB lookup)
      // ap-mls://{instance.tld}/path = shareable links (convert to https:// apId for lookup)
      window.navigateToGroup = async (groupId, rawUrl) => {
        const { groupId: resolved, scrollToMsgId } = await this.controller.resolveDeepLink(rawUrl || groupId);

        await this.loadGroups();
        await this.loadMessages(resolved);
        if (scrollToMsgId) this.scrollToMessage(scrollToMsgId);
      };

      // Listen for SSE push via Tauri — debounce, poll once, notify grouped by sender
      if (window.__TAURI__?.event) {
        const invoke = window.__TAURI__.core?.invoke;
        this._sseDebounce = null;
        this._unlistenNewMessage = await window.__TAURI__.event.listen('new-message', () => {
          clearTimeout(this._sseDebounce);
          this._sseDebounce = setTimeout(async () => {
            const results = await this.pollInbox();
            console.log('[SSE] Poll results:', results?.length, results);
            if (!results?.length) return;
            const counts = {};
            for (const r of results) {
              if (r.type === 'message' && r.from) {
                const name = this.getActorNickname(r.from);
                counts[name] = (counts[name] || 0) + 1;
              }
            }
            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            for (const [sender, n] of Object.entries(counts)) {
              const body = n > 1 ? `${n} messages from ${sender}` : `From ${sender} at ${time}`;
              console.log('[SSE] Sending notification:', body);
              invoke?.('show_notification', { title: 'New secure message', body })
                .catch(e => console.warn('[SSE] Notification failed:', e));
            }
          }, 500);
        });

        // When SSE reconnects after a drop, poll inbox to catch any missed messages
        this._unlistenSseReconnected = await window.__TAURI__.event.listen('sse-reconnected', () => {
          console.log('[SSE] Reconnected — polling inbox for missed messages');
          this.pollInbox();
        });
      }
    } catch (e) {
      this.error = e.message;
    }
  }

  updated() {
    // Observe unread message elements and mark them read when they scroll into view
    if (!this._readObserver) {
      this._pendingReadEntries = new Map(); // msgId → element, for entries seen while unfocused

      const markRead = (msgId, groupId) => {
        // group override (null = use global, true/false = override)
        const effective = this._groupReadReceiptsOverride !== null ? this._groupReadReceiptsOverride : this._sendReadReceipts;
        if (!effective) return;
        this.controller.markMessageRead(msgId, groupId).then(() => {
          this.messages = this.messages.map(m => m.id === msgId ? { ...m, isRead: true } : m);
          this.loadGroups();
        });
      };

      const flushPending = () => {
        if (!document.hasFocus() || !this._pendingReadEntries) return;
        for (const [msgId, { groupId }] of this._pendingReadEntries) {
          if (groupId && this.controller) markRead(msgId, groupId);
        }
        this._pendingReadEntries.clear();
      };

      this._onWindowFocus = flushPending;
      window.addEventListener('focus', this._onWindowFocus);

      this._readObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target;
          const { msgId, groupId } = el.dataset;
          if (!msgId || !groupId || !this.controller) continue;
          if (document.hasFocus()) {
            this._readObserver.unobserve(el);
            markRead(msgId, groupId);
          } else {
            this._pendingReadEntries.set(msgId, { groupId });
          }
        }
      }, { threshold: 0.5 });
    }
    this.shadowRoot.querySelectorAll('[data-unread]').forEach(el => this._readObserver.observe(el));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._onWindowFocus) { window.removeEventListener('focus', this._onWindowFocus); this._onWindowFocus = null; }
    if (this._readObserver) { this._readObserver.disconnect(); this._readObserver = null; }
    delete window.navigateToGroup;
    if (this._unlistenNewMessage) {
      this._unlistenNewMessage();
    }
    if (this._unlistenSseReconnected) {
      this._unlistenSseReconnected();
    }
    if (this.inboxPollingInterval) {
      clearInterval(this.inboxPollingInterval);
    }
    if (this._lgQuery && this._onResize) {
      this._lgQuery.removeEventListener('change', this._onResize);
    }
  }

  // ── Data loading (delegates to controller) ─────────────

  async loadGroups() {
    this.loading = true;
    try {
      this.groups = await this.controller.loadGroupList();
      if (this.groups.length > 0 && !this.selectedGroupId) {
        this.selectedGroupId = this.groups[0].id;
        await this.loadMessages(this.selectedGroupId);
      }
    } catch (e) {
      this.error = e.message;
    }
    this.loading = false;
  }

  async loadMessages(groupId) {
    const isNewGroup = groupId !== this.selectedGroupId;
    const wasAtBottom = isNewGroup || !this.messages.length || this._isScrolledToBottom();

    this.error = '';
    this.loading = true;
    this.selectedGroupId = groupId;
    this.replyToId = null;
    this.groupEncryptionLost = false;
    try {
      const result = await this.controller.loadMessages(groupId);
      this.messages = result.messages;
      this.currentGroupMembers = result.members;
      this.currentThreadName = result.threadName;
      this.threadNameIsAutoGenerated = result.threadNameIsAutoGenerated;
      this.userLeft = result.userLeft || false;
      this.groupEncryptionLost = !result.encryptionAvailable && !result.userLeft;
    } catch (e) {
      this.error = e.message;
    }
    this.loading = false;

    if (wasAtBottom) {
      await this.updateComplete;
      requestAnimationFrame(() => this._scrollToBottom(false));
    }
  }

  async pollInbox() {
    try {
      const results = await this.controller.pollInbox();
      if (results.length > 0) {
        // Reload groups and current messages if something changed
        await this.loadGroups();
        if (this.selectedGroupId) {
          const affected = results.find(r => r.groupId === this.selectedGroupId);
          if (affected) {
            await this.loadMessages(this.selectedGroupId);
            if (affected.type === 'membershipChange') {
              await this._loadMembersData();
            }
          }
        }
      }
      return results;
    } catch (e) {
      console.error('[Inbox] Error:', e);
      return [];
    }
  }

  // ── Actions (delegates to controller) ──────────────────

  createNewGroup() {
    this.error = '';
    this.selectedGroupId = null;
    this.messages = [];
    this.name = '';
    this._resolvedRecipients = [];
    this._recipientInput = '';
    this.summary = '';
    this.input = '';
    this.replyToId = null;
    this.replyToSnippet = '';
    this.currentThreadName = '';
    this.currentGroupMembers = [];
    this.threadNameIsAutoGenerated = false;
    this.groupEncryptionLost = false;
    this.creatingNewGroup = true;
  }

  async sendMessage() {
    if (!this.input.trim() || (!this.selectedGroupId && !this.creatingNewGroup)) return;
    if (this._recipientInput.trim()) await this._addRecipient();

    const recipients = this._resolvedRecipients.filter(r => r.resolved).map(r => r.actorUri);
    if (this.creatingNewGroup && recipients.length === 0) {
      this.error = 'Add at least one valid recipient';
      return;
    }

    this.error = '';
    this.loading = true;

    // Capture input state before clearing
    const fields = {
      name: this.name.trim(),
      summary: this.summary.trim(),
      content: this.input.trim(),
      inReplyTo: this.replyToId || undefined,
    };

    // Clear input immediately for responsiveness
    this.input = '';
    this.name = '';
    this.summary = '';
    this._resolvedRecipients = [];
    this._recipientInput = '';
    this.replyToId = null;
    this.replyToSnippet = '';
    this.creatingNewGroup = false;

    try {
      const { groupId, errors } = await this.controller.sendMessage(
        this.selectedGroupId, fields, recipients
      );
      this.selectedGroupId = groupId;
      if (errors?.length > 0) this.error = errors.join('; ');
      await this.loadMessages(groupId);
      await this.loadGroups();
    } catch (e) {
      if (e instanceof EncryptionLostError) {
        this.groupEncryptionLost = true;
      }
      await this.loadMessages(this.selectedGroupId);
    }
    this.loading = false;
  }

  async handleResetEncryption() {
    if (!this.selectedGroupId) return;
    this.loading = true;
    this.error = '';
    try {
      await this.controller.resetGroup(this.selectedGroupId);
      this.groupEncryptionLost = false;
      await this.loadMessages(this.selectedGroupId);
    } catch (e) {
      this.error = 'Reset failed: ' + (typeof e === 'string' ? e : (e.message || String(e)));
    }
    this.loading = false;
  }

  _renderArchiveButton() {
    return html`
      <button class="btn btn-error btn-outline btn-sm btn-block"
        @click=${() => this._handleArchiveThread()}
        ?disabled=${this.loading}>
        ${icon('archive-box')}
        Archive thread
      </button>
      <p class="text-xs opacity-50 mt-1">Removes this thread and its messages from your device.</p>
    `;
  }

  async _handleArchiveThread() {
    if (!this.selectedGroupId) return;
    this.loading = true;
    try {
      await this.controller.archiveThread(this.selectedGroupId);
      this.selectedGroupId = null;
      this.messages = [];
      this.showMembersPanel = false;
      await this.loadGroups();
    } catch (e) {
      this.error = 'Archive failed: ' + (e.message || e);
    }
    this.loading = false;
  }

  async handleRetryForRecipient(messageId, _actorId) {
    // Resend to all — recipients who already acknowledged will re-send Acknowledge (idempotent)
    return this.handleRetry(messageId);
  }

  async handleRetry(messageId) {
    try {
      await this.controller.retrySendMessage(messageId);
      await this.loadMessages(this.selectedGroupId);
      await this.loadGroups();
    } catch (e) {
      // retrySendMessage already saves as failed again, just refresh
      await this.loadMessages(this.selectedGroupId);
    }
  }

  // ── Thread name editing ────────────────────────────────

  startEditingThreadName() {
    this.editingThreadName = true;
    this.requestUpdate();
  }

  async saveThreadName() {
    if (this.selectedGroupId && this.currentThreadName) {
      await this.controller.setGroupName(this.selectedGroupId, this.currentThreadName);
      this.threadNameIsAutoGenerated = false;
      await this.loadGroups();
    }
    this.editingThreadName = false;
    this.requestUpdate();
  }

  cancelEditThreadName() {
    if (this.selectedGroupId) {
      this.controller._getGroupName(this.selectedGroupId).then(savedName => {
        this.currentThreadName = savedName || '';
        this.editingThreadName = false;
        this.requestUpdate();
      });
    } else {
      this.editingThreadName = false;
      this.requestUpdate();
    }
  }

  // ── Reply handling ─────────────────────────────────────

  handleReply(messageId) {
    this.replyToId = messageId;
    const msg = this.messages.find(m => m.id === messageId);
    if (msg) {
      const snippet = msg.content || msg.summary || msg.name || 'message';
      this.replyToSnippet = snippet.length > 60 ? snippet.substring(0, 60) + '...' : snippet;
    } else {
      this.replyToSnippet = 'message';
    }
    this.requestUpdate();
  }

  cancelReply() {
    this.replyToId = null;
    this.replyToSnippet = '';
    this.requestUpdate();
  }

  // ── Menu actions ─────────────────────────────────────

  async _menuAction(value) {
    if (value === 'logout') {
      await logout();
      if (window.__TAURI__) {
        window.__TAURI__.event.emit('app-logout');
      } else {
        window.location = this.getAttribute('redirect-uri') || '/';
      }
    } else {
      window.location.hash = value;
    }
  }

  // ── Display helpers ────────────────────────────────────

  _groupMemberNames(group) {
    const others = (group.members || []).filter(id => id !== this.currentActorId);
    if (others.length === 0) return null;
    others.forEach(id => this._ensureActorProfile(id));
    return others.map(id => this._getDisplayName(id)).join(', ');
  }

  getActorNickname(actorId) {
    return this.controller.getActorNickname(actorId, this._actorProfiles.get(actorId));
  }

  /** Load an actor's profile from Dexie into the reactive map. */
  _ensureActorProfile(actorId) {
    if (!actorId || !this.controller || this._actorProfiles.has(actorId) || this._profileLoadPending.has(actorId)) return;
    this._profileLoadPending.add(actorId);
    this.controller.getActorProfile(actorId).then(profile => {
      this._profileLoadPending.delete(actorId);
      if (profile) {
        const next = new Map(this._actorProfiles);
        next.set(actorId, profile);
        this._actorProfiles = next;
      }
    });
  }

  /** Get display name for an actor (falls back to URI-derived nickname). */
  _getDisplayName(actorId) {
    const profile = this._actorProfiles.get(actorId);
    return profile?.name || this.getActorNickname(actorId, profile) || 'Unknown';
  }

  /** Get avatar URL for an actor, or null. */
  _getAvatarUrl(actorId) {
    const profile = this._actorProfiles.get(actorId);
    return profile?.icon || null;
  }

  /** Render an avatar image or letter-initial fallback. */
  _renderAvatar(actorId, { size = 16 } = {}) {
    this._ensureActorProfile(actorId);
    const url = this._getAvatarUrl(actorId);
    const px = `${size / 16}rem`;
    if (url) {
      return html`<img src="${url}" class="rounded-full object-cover" style="width:${px};height:${px}" alt="" />`;
    }
    const initial = (this._getDisplayName(actorId) || '?')[0];
    return html`<div class="rounded-full bg-base-300 flex items-center justify-center" style="width:${px};height:${px};font-size:${size * 0.55 / 16}rem">${initial}</div>`;
  }

  /** Resolve and add a recipient from the input field. */
  async _addRecipient() {
    const input = this._recipientInput.replace(/[,\s]+$/, '').trim();
    if (!input) return;
    if (this._resolvedRecipients.some(r => r.input === input || r.actorUri === input)) return;

    this._resolvingRecipient = true;
    this._recipientInput = '';
    try {
      const result = await this.controller.resolveRecipient(input);

      if (result.resolved && this._resolvedRecipients.some(r => r.actorUri === result.actorUri)) {
        return;
      }

      this._resolvedRecipients = [...this._resolvedRecipients, result];
      this.error = '';
    } catch (e) {
      console.warn('[_addRecipient] Lookup failed:', e.message || e);
      this._resolvedRecipients = [...this._resolvedRecipients, { input, resolved: false, error: e.message || 'Lookup failed' }];
    } finally {
      this._resolvingRecipient = false;
    }
  }

  _removeRecipient(index) {
    this._resolvedRecipients = this._resolvedRecipients.filter((_, i) => i !== index);
  }

  /** Open the members panel and highlight a specific actor. */
  async _showMember(actorId) {
    if (!this.selectedGroupId) return;
    this._highlightedMember = actorId;
    this.showMembersPanel = true;
    await this._loadMembersData();
    // Scroll to the highlighted member card after render
    await this.updateComplete;
    const card = this.shadowRoot.querySelector(`[data-member-id="${CSS.escape(actorId)}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /** Render a username badge with avatar — tap to open members panel. */
  _renderUsername(actorId, { classes = '', style = '', size = 16 } = {}) {
    this._ensureActorProfile(actorId);
    const name = actorId ? this._getDisplayName(actorId) : 'Unknown';
    const nickname = actorId ? this.getActorNickname(actorId) : '';
    return html`<span
      class="badge badge-sm gap-1 ${classes}"
      style="${style}"
      title="${nickname}"
      @click=${(e) => { e.stopPropagation(); this._showMember(actorId); }}
    >${this._renderAvatar(actorId, { size })}${name}</span>`;
  }

  decryptedSummary(msg) {
    return typeof msg === 'string' ? msg : msg && (msg.summary || msg.content);
  }

  _getMessagesList() {
    return this.shadowRoot?.querySelector('.messages-list');
  }

  _isScrolledToBottom() {
    const el = this._getMessagesList();
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  _scrollToBottom(smooth = false) {
    const el = this._getMessagesList();
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
  }

  scrollToMessage(messageId) {
    const element = this.shadowRoot.getElementById(`msg-${messageId}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.style.transition = 'background-color 0.3s';
      const originalBg = element.style.backgroundColor;
      element.style.backgroundColor = 'rgba(37, 99, 235, 0.2)';
      setTimeout(() => {
        element.style.backgroundColor = originalBg;
      }, 1000);
    }
  }

  _toggleCollapse(msgId) {
    if (this._collapsedThreads.has(msgId)) {
      this._collapsedThreads.delete(msgId);
    } else {
      this._collapsedThreads.add(msgId);
    }
    this.requestUpdate();
  }

  _countDescendants(msg) {
    if (!msg.replies || msg.replies.length === 0) return 0;
    return msg.replies.reduce((sum, r) => sum + 1 + this._countDescendants(r), 0);
  }

  _actorColor(actorId) {
    // Option A: unlimited OKLCH hues derived from fingerprint hash (active when fingerprint is loaded)
    if (this._fingerprintColors?.has(actorId)) return this._fingerprintColors.get(actorId);
    // Option B: cycle through DaisyUI semantic palette (fallback / no-fingerprint)
    const idx = this.controller.getActorColorIndex(actorId, this._threadColors.length);
    return this._threadColors[idx];
  }

  // ── Members panel ──────────────────────────────────────

  async toggleMembersPanel() {
    if (this.showMembersPanel) {
      this.showMembersPanel = false;
      this._highlightedMember = null;
      return;
    }
    this._highlightedMember = null;
    this.showMembersPanel = true;
    await this._loadMembersData();
  }

  async _loadMembersData() {
    if (!this.selectedGroupId || !this.currentActorId) return;
    this._membersLoading = true;
    this._groupReadReceiptsOverride = await this.controller.storage.getGroupField(this.selectedGroupId, 'readReceiptsOverride', null);
    try {
      const members = await this.controller.getGroupMembersData(this.selectedGroupId);
      members.forEach(m => {
        this._ensureActorProfile(m.identity);
        // Derive color from fingerprint emoji — changes whenever any client key changes
        const allEmoji = m.clients.flatMap(c => (c.fingerprint || []).map(f => f.emoji)).filter(Boolean);
        if (allEmoji.length) {
          // djb2 hash over client count + full emoji string — order-sensitive, collision-resistant
          let hash = 5381;
          for (const ch of `${m.clients.length}:${allEmoji.join('')}`) hash = (Math.imul(hash, 33) ^ ch.codePointAt(0)) | 0;
          // Option A: map hash to unlimited OKLCH hue (0–360°), fixed lightness+chroma for readable, harmonious colors
          const hue = Math.abs(hash) % 360;
          const color = `oklch(60% 0.15 ${hue})`;
          // Option B (palette): Math.abs(hash) % this._threadColors.length
          this._fingerprintColors = this._fingerprintColors || new Map();
          this._fingerprintColors.set(m.identity, color);
        }
      });
      this._membersData = members;
    } catch (e) {
      console.error('[MembersPanel] Failed to load:', e);
      this._membersData = [];
    }
    this._membersLoading = false;
  }

  async _handleRemoveClient(groupId, leafIndex) {
    try {
      const result = await this.controller.removeGroupMemberClient(groupId, leafIndex);
      if (result?.cancelled) return;
      await this._loadMembersData();
    } catch (e) {
      this.error = 'Failed to remove client: ' + (e.message || e);
    }
  }

  async _handleRemoveMember(groupId, actorIdentity) {
    try {
      const result = await this.controller.removeGroupMember(groupId, actorIdentity);
      if (result?.cancelled) return;
      await this._loadMembersData();
      await this.loadMessages(this.selectedGroupId);
    } catch (e) {
      this.error = 'Failed to remove member: ' + (e.message || e);
    }
  }

  async _handleLeaveGroup(groupId) {
    try {
      const result = await this.controller.leaveGroup(groupId);
      if (result?.cancelled) return;
      this.showMembersPanel = false;
      this.selectedGroupId = null;
      await this.loadGroups();
    } catch (e) {
      this.error = 'Failed to leave group: ' + (e.message || e);
      this.requestUpdate();
    }
  }

  async _saveEdit(msg) {
    const newContent = this._editingContent.trim();
    if (!newContent || newContent === msg.content) {
      this._editingId = null;
      this.requestUpdate();
      return;
    }
    try {
      await this.controller.editMessage(this.selectedGroupId, msg.id, newContent);
      this._editingId = null;
      await this.loadMessages(this.selectedGroupId);
    } catch (e) {
      this.error = 'Failed to edit message: ' + (e.message || e);
      this.requestUpdate();
    }
  }

  async _handleDeleteMessage(msg) {
    if (!confirm('Delete this message for everyone?')) return;
    try {
      await this.controller.deleteMessage(this.selectedGroupId, msg.id);
      await this.loadMessages(this.selectedGroupId);
    } catch (e) {
      this.error = 'Failed to delete message: ' + (e.message || e);
      this.requestUpdate();
    }
  }

  async _handleDeleteLocalMessage(msg) {
    if (!confirm('Remove this message from your device only?\n\nThis will not affect other members.')) return;
    try {
      await this.controller.storage.deleteMessage(msg.id);
      await this.loadMessages(this.selectedGroupId);
    } catch (e) {
      this.error = 'Failed to remove message: ' + (e.message || e);
      this.requestUpdate();
    }
  }

  _openMyDevicesPanel() {
    const panel = document.createElement('my-devices-panel');
    panel.controller = this.controller;
    panel.currentActorId = this.currentActorId;
    panel.addEventListener('close', () => panel.remove());
    panel.addEventListener('settings-changed', (e) => { this[`_${e.detail.key}`] = e.detail.value; });
    this.shadowRoot.appendChild(panel);
  }

  /**
   * Shared member card used by both the members panel and the delivery panel.
   * @param {object} member - entry from _membersData
   * @param {object} opts
   * @param {function} [opts.clientAction] - (client) => html — right slot per client row
   * @param {unknown} [opts.badge] - html shown in header row after name (replaces/alongside You badge)
   * @param {unknown} [opts.footer] - html shown below all client rows
   * @param {boolean} [opts.highlight] - whether to apply highlight border
   */
  _renderMemberCard(member, { clientAction, badge, footer, highlight = false } = {}) {
    return html`
      <div class="card card-bordered mb-3 ${highlight ? 'bg-primary/10 border-primary' : 'bg-base-200'}"
        data-member-id="${member.identity}">
        <div class="card-body p-3 gap-2">
          <div class="flex items-center gap-2">
            ${this._renderAvatar(member.identity, { size: 24 })}
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-sm truncate">${this._getDisplayName(member.identity)}</div>
              <div class="text-xs opacity-60 truncate">${this.getActorNickname(member.identity)}</div>
            </div>
            ${badge ?? (member.isOwn ? html`<span class="badge badge-sm badge-primary">You</span>` : '')}
          </div>
          ${member.clients.map(client => html`
            <div class="flex items-center gap-2 pl-2 py-1 border-l-2 ${client.isCurrentClient ? 'border-primary' : 'border-base-300'}">
              <span class="text-lg flex-1" title="Emoji fingerprint">
                ${client.fingerprint.map(e => e.emoji).join(' ')}
              </span>
              ${clientAction ? clientAction(client) : ''}
            </div>
          `)}
          ${footer ?? ''}
        </div>
      </div>
    `;
  }

  _renderReactions(msg) {
    const entries = Object.entries(msg.reactions || {});
    if (!entries.length) return '';
    return html`
      <div class="flex flex-wrap gap-1 mt-1.5">
        ${entries.map(([emoji, actors]) => {
          const isMine = actors.includes(this.currentActorId);
          const names = actors.map(id => this._getDisplayName(id)).join(', ');
          return html`<button
            class="btn btn-xs ${isMine ? 'btn-primary' : 'btn-ghost border border-base-300'} gap-0.5 h-6 min-h-0 px-1.5"
            title=${names}
            @click=${(e) => { e.stopPropagation(); this._reactionPanel = { emoji, actors }; this.requestUpdate(); }}>
            ${emoji}<span class="opacity-70 text-xs">${actors.length}</span>
          </button>`;
        })}
      </div>`;
  }

  _deliveryStatusEmoji(status) {
    switch (status) {
      case 'acknowledged': return { emoji: '✅', label: 'Received & decrypted' };
      case 'failed':       return { emoji: '🟠', label: 'Delivery failed' };
      case 'keys_broken':  return { emoji: '🔴', label: 'Encryption keys out of sync' };
      case 'sent':         return { emoji: '📮', label: 'Sent' };
      case 'read':         return { emoji: '👁️', label: 'Read' };
      default:             return { emoji: '🛫', label: 'Sending…' };
    }
  }

  _renderDeliveryTicks(deliveryStatus) {
    const s = (status) => { const { emoji, label } = this._deliveryStatusEmoji(status); return html`<span title="${label}">${emoji}</span>`; };
    if (!deliveryStatus) return s();
    const entries = Object.values(deliveryStatus);
    if (entries.length === 0) return s();
    const anyKeysBroken = entries.some(e => e.status === 'keys_broken');
    const anyFailed = entries.some(e => e.status === 'failed');
    const allAcked = entries.every(e => e.status === 'acknowledged');
    const allSent = entries.every(e => e.status === 'sent');
    if (anyKeysBroken) return s('keys_broken');
    if (anyFailed) return s('failed');
    if (allAcked) return s('acknowledged');
    if (allSent) return s('sent');
    // Mixed: some acked, some not yet
    const { emoji: ackEmoji } = this._deliveryStatusEmoji('acknowledged');
    const { emoji: sentEmoji, label } = this._deliveryStatusEmoji('sent');
    return html`<span title="Partially received — ${label}">${ackEmoji}${sentEmoji}</span>`;
  }

  _renderReactionPanel() {
    if (!this._reactionPanel) return '';
    const { emoji, actors } = this._reactionPanel;
    return html`
      <div class="absolute inset-0 z-50 flex flex-col bg-base-100 text-base-content">
        <div class="flex items-center gap-2 p-3 border-b border-base-300 bg-base-200">
          <button class="btn btn-ghost btn-sm btn-square" @click=${() => { this._reactionPanel = null; this.requestUpdate(); }}>
            ${icon('arrow-left', { size: 20 })}
          </button>
          <span class="font-semibold flex-1">${emoji} ${actors.length} ${actors.length === 1 ? 'reaction' : 'reactions'}</span>
        </div>
        <div class="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          ${actors.map(actorId => html`
            <div class="flex items-center gap-2 cursor-pointer hover:bg-base-200 rounded p-1"
              @click=${() => { this._reactionPanel = null; this._showMember(actorId); }}>
              <div class="w-8 rounded-full overflow-hidden flex-shrink-0">${this._renderAvatar(actorId, { size: 32 })}</div>
              <span class="text-sm">${this._getDisplayName(actorId)}</span>
            </div>`)}
        </div>
      </div>`;
  }

  _renderSharePanel() {
    if (!this._boostPanel) return '';
    const { msg } = this._boostPanel;
    const isCrossGroup = this._boostCrossGroup;
    const author = msg.attributedTo;
    const authorName = author ? this._getDisplayName(author) : '';
    const close = () => { this._boostPanel = null; };
    return html`
      <div class="absolute inset-0 z-50 flex flex-col bg-base-100 text-base-content">
        <div class="flex items-center gap-2 p-3 border-b border-base-300 bg-base-200">
          <button class="btn btn-ghost btn-sm btn-square" @click=${close}>
            ${icon('arrow-left', { size: 20 })}
          </button>
          <span class="font-semibold flex-1">Share message</span>
        </div>
        <div class="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
          <div class="rounded border border-base-300 bg-base-200 p-2 text-sm">
            ${authorName ? html`<div class="text-xs font-medium opacity-60 mb-1">${authorName}</div>` : ''}
            <div class="opacity-70 line-clamp-3">${msg.content?.content || msg.content || ''}</div>
          </div>
          <div class="text-xs opacity-60">
            This will boost the message in this group so everyone here can see it highlighted.
          </div>
          <div>
            <label class="label label-text text-xs pb-1">Add a comment (optional)</label>
            <textarea class="textarea textarea-bordered w-full textarea-sm" rows="3"
              placeholder="Say something…"
              .value=${this._boostComment}
              @input=${(e) => { this._boostComment = e.target.value; }}></textarea>
          </div>
          <div>
            <button class="btn btn-ghost btn-sm btn-block justify-start gap-2 border border-base-300"
              @click=${() => { this._boostCrossGroup = !this._boostCrossGroup; }}>
              ${icon(isCrossGroup ? 'caret-down' : 'caret-right', { size: 14 })}
              Share in a different group instead
            </button>
            ${isCrossGroup ? html`
              <div class="mt-2 flex flex-col gap-2">
                <div class="alert alert-warning text-xs py-2 px-3 flex gap-2 items-start">
                  ${icon('warning', { size: 16 })}
                  <span>Make sure you have consent from ${authorName || 'the author'} before sharing their message with another group.</span>
                </div>
                <select class="select select-bordered select-sm w-full"
                  .value=${this._boostTargetGroupId}
                  @change=${(e) => { this._boostTargetGroupId = e.target.value; }}>
                  ${this.groups.filter(g => g.id !== this.selectedGroupId).map(g => html`
                    <option value=${g.id} ?selected=${g.id === this._boostTargetGroupId}>${g.name || (g.members || []).filter(id => id !== this.currentActorId).map(id => this.getActorNickname(id)).filter(Boolean).join(', ') || g.id}</option>`)}
                </select>
              </div>
            ` : ''}
          </div>
          <button class="btn btn-primary btn-sm btn-block" @click=${async () => {
            const sourceGroupId = this.selectedGroupId;
            const resolvedTarget = isCrossGroup ? this._boostTargetGroupId : sourceGroupId;
            const comment = this._boostComment;
            const inlineContent = isCrossGroup ? msg.content : undefined;
            close();
            await this.controller.announceMessage(resolvedTarget, msg.id, comment, sourceGroupId, inlineContent);
            this.loadMessages(sourceGroupId);
          }}>
            ${icon('megaphone', { size: 16 })} ${isCrossGroup ? 'Share in other group' : 'Boost in this group'}
          </button>
        </div>
      </div>`;
  }

  _renderDeliveryPanel() {
    if (!this._deliveryPanel) return '';
    const { msg } = this._deliveryPanel;
    const ds = msg.deliveryStatus || {};
    const entries = Object.values(ds);
    const anyKeysBroken = entries.some(e => e.status === 'keys_broken');
    const allFailed = entries.length > 0 && entries.every(e => e.status === 'failed');
    return html`
      <div class="absolute inset-0 z-50 flex flex-col bg-base-100 text-base-content">
        <div class="flex items-center gap-2 p-3 border-b border-base-300 bg-base-200">
          <button class="btn btn-ghost btn-sm btn-square" @click=${() => { this._deliveryPanel = null; }}>
            ${icon('arrow-left', { size: 20 })}
          </button>
          <span class="font-semibold flex-1">Delivery Status</span>
        </div>
        <div class="flex-1 overflow-y-auto p-3">
          ${Object.entries(ds).map(([actorId, entry]) => {
            const { emoji, label } = this._deliveryStatusEmoji(entry.status);
            const statusBadge = html`
              <span class="badge badge-sm ${entry.status === 'acknowledged' ? 'badge-success' : entry.status === 'keys_broken' ? 'badge-error' : entry.status === 'failed' ? 'badge-warning' : 'badge-ghost'}"
                title="${label}">${emoji} ${label}</span>`;
            const actionFooter = entry.status === 'failed' ? html`
              <button class="btn btn-xs btn-outline btn-warning btn-block mt-1"
                @click=${() => this.handleRetryForRecipient(msg.id, actorId)}>Retry</button>
            ` : entry.status === 'keys_broken' ? html`
              <button class="btn btn-xs btn-error btn-block mt-1" @click=${() => this.handleResetEncryption()}>Reset encryption</button>
            ` : '';
            const memberData = this._membersData.find(m => m.identity === actorId);
            if (memberData) {
              return this._renderMemberCard(memberData, { badge: statusBadge, footer: actionFooter });
            }
            // Fallback if members panel hasn't been opened yet
            return html`
              <div class="card card-bordered mb-3 bg-base-200">
                <div class="card-body p-3 gap-2">
                  <div class="flex items-center gap-2">
                    ${this._renderAvatar(actorId, { size: 24 })}
                    <div class="flex-1 min-w-0">
                      <div class="font-semibold text-sm truncate">${this._getDisplayName(actorId)}</div>
                      <div class="text-xs opacity-60 truncate">${this.getActorNickname(actorId)}</div>
                    </div>
                    ${statusBadge}
                  </div>
                  ${actionFooter}
                </div>
              </div>`;
          })}
        </div>
        ${anyKeysBroken ? html`
          <div class="p-3 border-t border-base-300">
            <button class="btn btn-error btn-sm btn-block" @click=${() => this.handleResetEncryption()}>Reset encryption for group</button>
          </div>
        ` : allFailed ? html`
          <div class="p-3 border-t border-base-300">
            <button class="btn btn-warning btn-sm btn-block" @click=${() => this.handleRetry(msg.id)}>Retry for all</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  _renderMembersPanel() {
    if (!this.showMembersPanel) return '';
    const groupId = this.selectedGroupId;

    return html`
      <div class="absolute inset-0 z-50 flex flex-col bg-base-100 text-base-content">
        <div class="flex items-center gap-2 p-3 border-b border-base-300 bg-base-200">
          <button class="btn btn-ghost btn-sm btn-square" @click=${() => { this.showMembersPanel = false; this._highlightedMember = null; }}>
            ${icon('arrow-left', { size: 20 })}
          </button>
          <span class="font-semibold flex-1">Group Settings</span>
          <button class="btn btn-ghost btn-xs" @click=${() => this._loadMembersData()}>
            ${icon('arrows-clockwise')}
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-3">
          <div class="mb-4 border-b border-base-300 pb-4">
            <h3 class="text-sm font-semibold opacity-60 mb-2 uppercase tracking-wide">Privacy</h3>
            <label class="flex items-center gap-3 cursor-pointer">
              <div class="flex-1">
                <div class="text-sm font-medium">Read receipts</div>
                <div class="text-xs opacity-50">Override global setting for this group</div>
              </div>
              <select class="select select-xs select-bordered"
                .value=${this._groupReadReceiptsOverride === null ? 'default' : String(this._groupReadReceiptsOverride)}
                @change=${async (e) => {
                  const val = e.target.value === 'default' ? null : e.target.value === 'true';
                  this._groupReadReceiptsOverride = val;
                  await this.controller.storage.setGroupField(groupId, 'readReceiptsOverride', val);
                }}>
                <option value="default">Default (${this._sendReadReceipts ? 'on' : 'off'})</option>
                <option value="true">Always on</option>
                <option value="false">Always off</option>
              </select>
            </label>
          </div>
          <h3 class="text-sm font-semibold opacity-60 mb-2 uppercase tracking-wide">Members</h3>
          <form class="flex gap-2 mb-4" @submit=${async (e) => {
            e.preventDefault();
            const val = this._addMemberInput.trim();
            if (!val) return;
            this._addMemberLoading = true;
            this._addMemberError = null;
            try {
              await this.controller.addMemberToGroup(groupId, val);
              this._addMemberInput = '';
              await Promise.all([this._loadMembersData(), this.loadMessages(groupId)]);
            } catch (err) {
              this._addMemberError = err.message || 'Failed to add member';
            } finally {
              this._addMemberLoading = false;
            }
          }}>
            <input type="text" class="input input-bordered input-sm flex-1"
              placeholder="@user@domain"
              .value=${this._addMemberInput}
              @input=${e => { this._addMemberInput = e.target.value; this._addMemberError = null; }} />
            <button type="submit" class="btn btn-primary btn-sm" ?disabled=${this._addMemberLoading}>
              ${this._addMemberLoading ? html`<span class="loading loading-spinner loading-xs"></span>` : icon('user-plus', { size: 16 })}
            </button>
          </form>
          ${this._addMemberError ? html`<div class="alert alert-error text-xs py-1 px-2 mb-3">${this._addMemberError}</div>` : ''}
          ${this._membersLoading ? html`
            <div class="flex justify-center py-8"><span class="loading loading-spinner"></span></div>
          ` : this._membersData.length === 0 ? html`
            <div class="text-center opacity-60 py-8">No members found</div>
          ` : this._membersData.map(member => this._renderMemberCard(member, {
            highlight: this._highlightedMember === member.identity,
            clientAction: client => client.isCurrentClient ? html`
              <span class="badge badge-xs badge-primary gap-1">
                ${icon('check', { size: 12 })}
                this device
              </span>
            ` : (!member.isOwn && member.clients.length > 1) ? html`
              <button class="btn btn-error btn-outline btn-xs"
                @click=${() => this._handleRemoveClient(groupId, client.index)}>
                Remove device
              </button>
            ` : '',
            footer: member.isOwn ? html`
              <button class="btn btn-ghost btn-xs btn-block mt-1" @click=${() => this._openMyDevicesPanel()}>
                Manage my devices ${icon('caret-right')}
              </button>
              <button class="btn btn-warning btn-outline btn-xs btn-block mt-1"
                @click=${() => this._handleLeaveGroup(groupId)}>
                Leave group
              </button>
            ` : html`
              <button class="btn btn-error btn-outline btn-xs btn-block mt-1"
                @click=${() => this._handleRemoveMember(groupId, member.identity)}>
                Remove member
              </button>
            `
          }))}
          <details class="mt-4 border-t border-base-300 pt-3">
            <summary class="text-sm cursor-pointer select-none">Advanced</summary>
            <div class="mt-2">
              <button class="btn btn-warning btn-outline btn-sm btn-block"
                @click=${() => this.handleResetEncryption()}
                ?disabled=${this.loading}>
                ${icon('lock-key')}
                ${this.loading ? 'Resetting...' : 'Reset encryption'}
              </button>
              <p class="text-xs opacity-50 mt-1">Re-creates the group and re-invites all members.</p>
              <div class="mt-3">${this._renderArchiveButton()}</div>
            </div>
          </details>
        </div>
      </div>
    `;
  }

  // ── Render ─────────────────────────────────────────────

  /** Shared chat-bubble shell: avatar + slot for bubble content + optional replies. */
  _renderChatRow(msg, { bubbleContent, footerContent = null, persistentFooter = null, replies = null, extraClasses = '' } = {}) {
    const color = this._actorColor(msg.attributedTo);
    const isUnread = !msg.isRead;
    const largeGroup = (this.currentGroupMembers?.length || 0) > 5;
    return html`
      <div class="thread-root w-full" style="${replies ? `--thread-color:${color}` : ''}">
        ${replies ? html`<div class="thread-stem-click" @click=${() => this._toggleCollapse(msg.id)} title="Collapse thread"></div>` : ''}
        <div class="thread-msg-wrap ${isUnread ? 'indicator w-full' : ''}">
          ${isUnread ? html`<span class="indicator-item indicator-start badge badge-primary badge-xs" style="top:1rem"></span>` : ''}
          <div id="msg-${msg.id}" class="chat chat-start w-full py-0 ${extraClasses}"
            data-msg-id="${msg.id}" data-group-id="${this.selectedGroupId}"
            ?data-unread=${isUnread}>

            <div class="chat-image avatar cursor-pointer" @click=${(e) => { e.stopPropagation(); this._showMember(msg.attributedTo); }}>
              <div class="w-9 rounded-full">${this._renderAvatar(msg.attributedTo, { size: 36 })}</div>
            </div>

            <div class="chat-header text-xs flex items-baseline gap-1">
              <span class="${largeGroup ? '' : 'hover-visible'} font-semibold cursor-pointer" style="color:${color}"
                @click=${(e) => { e.stopPropagation(); this._showMember(msg.attributedTo); }}>
                ${this._getDisplayName(msg.attributedTo)}
              </span>
              <span class="hover-visible flex items-baseline gap-1">
                ${msg.timestamp ? html`<time class="opacity-50" title=${new Date(msg.timestamp).toLocaleString()}>${relativeTime(msg.timestamp)}</time>` : ''}
                ${msg.editedAt ? html`<span class="opacity-40">(edited)</span>` : ''}
              </span>
            </div>

            ${bubbleContent}

            ${(persistentFooter || footerContent) ? html`<div class="chat-footer flex items-center gap-2 text-xs mt-0.5">
              ${persistentFooter}
              ${footerContent ? html`<span class="hover-visible flex items-center gap-2">${footerContent}</span>` : ''}
            </div>` : ''}
          </div>
        </div>

        ${replies ? html`<div class="thread-children">${replies}</div>` : ''}
      </div>
    `;
  }

  renderMessage(msg, depth = 0) {
    if (!msg) return '';

    if (msg && msg.type === 'system') {
      return html`
        <div class="alert alert-warning text-xs my-1 py-1 px-2 opacity-80">${msg.content}</div>
      `;
    }

    if (msg && msg.status === 'failed') {
      return html`
        <div class="flex items-center gap-2 my-1 py-1 px-2 bg-error/10 rounded">
          <div class="flex-1 text-sm">
            <span class="opacity-60">${msg.content}</span>
            <div class="text-xs text-error">${msg.error || 'Failed to send'}</div>
          </div>
          <button class="btn btn-error btn-xs" @click=${() => this.handleRetry(msg.id)}>Retry</button>
        </div>
      `;
    }

    if (msg && msg.status === 'sending') {
      return html`
        <div class="my-1 py-1 px-2 opacity-50 text-sm italic">
          ${msg.content}<span class="loading loading-dots loading-xs ml-1"></span>
        </div>
      `;
    }

    if (msg && msg.type === 'Tombstone') {
      const isOwnTombstone = msg.isLocal || msg.attributedTo === this.currentActorId;
      const tombstoneFooter = !isOwnTombstone ? html`
        <a class="link link-hover text-error" @click=${() => this._handleDeleteLocalMessage(msg)}>delete locally</a>
      ` : null;
      return this._renderChatRow(msg, {
        bubbleContent: html`<div class="chat-bubble chat-bubble-ghost text-xs italic py-1 px-2 opacity-40">[message deleted]</div>`,
        footerContent: tombstoneFooter,
        extraClasses: 'opacity-60',
      });
    }

    if (msg && msg.type === 'Announce') {
      const referenced = msg.object && this.messages.find(m => m.id === msg.object || m.content?.id === msg.object);
      const mlsHref = msg.object ? `mls://m/${msg.object}` : null;
      const handleMlsClick = mlsHref ? (e) => { e.preventDefault(); window.navigateToGroup?.(mlsHref, mlsHref); } : null;
      const snippet = referenced
        ? html`<a class="block border-l-2 border-primary/40 pl-2 mt-1 text-xs opacity-70 hover:opacity-100 truncate cursor-pointer no-underline"
              href=${mlsHref} @click=${handleMlsClick} title="Jump to original">
            <span class="font-semibold">${this._getDisplayName(referenced.attributedTo || referenced.content?.attributedTo)}</span>:
            ${referenced.content?.content || referenced.content || ''}
          </a>`
        : mlsHref
          ? html`<a class="block text-xs opacity-50 mt-1 italic hover:opacity-80 cursor-pointer"
                href=${mlsHref} @click=${handleMlsClick}>[view original]</a>`
          : html`<div class="text-xs opacity-50 mt-1 italic">[shared message]</div>`;
      const hasReplies = msg.replies?.length > 0;
      const announceCollapsed = this._collapsedThreads.has(msg.id);
      const replies = hasReplies && !announceCollapsed
        ? msg.replies.map(reply => this.renderMessage(reply, depth + 1))
        : null;
      const isOwnAnnounce = msg.isLocal || msg.attributedTo === this.currentActorId;
      const announceAlreadyLiked = (msg.reactions?.['👍'] || []).includes(this.currentActorId);
      const announceLikeCount = (msg.reactions?.['👍'] || []).length;
      const announcePersistentFooter = (announceCollapsed || announceLikeCount > 0) ? html`
        ${announceCollapsed ? html`<span class="text-xs opacity-60 cursor-pointer hover:opacity-100" @click=${() => this._toggleCollapse(msg.id)}>+${this._countDescendants(msg)} collapsed</span>` : ''}
        ${announceLikeCount > 0 ? html`<a class="link link-hover ${announceAlreadyLiked ? 'opacity-100' : 'opacity-60'}" @click=${() => announceAlreadyLiked
          ? this.controller.undoLike(this.selectedGroupId, msg.id).then(() => this.loadMessages(this.selectedGroupId))
          : this.controller.likeMessage(this.selectedGroupId, msg.id).then(() => this.loadMessages(this.selectedGroupId))}>👍 ${announceLikeCount}</a>` : ''}
      ` : null;
      const announceFooter = html`
        ${msg.id ? html`<a class="link link-hover" @click=${() => this.handleReply(msg.id)}>reply</a>` : ''}
        ${announceLikeCount === 0 ? html`<a class="link link-hover" @click=${() => this.controller.likeMessage(this.selectedGroupId, msg.id).then(() => this.loadMessages(this.selectedGroupId))}>👍</a>` : ''}
        <a class="link link-hover" @click=${() => { const orig = msg.object && this.messages.find(m => m.id === msg.object || m.content?.id === msg.object); this._boostPanel = { msg: orig || msg }; this._boostComment = ''; this._boostTargetGroupId = this.selectedGroupId; this._boostCrossGroup = false; }}>share</a>
        ${isOwnAnnounce ? html`
          <a class="link link-hover text-error" @click=${() => this._handleDeleteMessage(msg)}>delete</a>
        ` : html`
          <a class="link link-hover text-error" @click=${() => this._handleDeleteLocalMessage(msg)}>delete</a>
        `}
      `;
      return this._renderChatRow(msg, {
        bubbleContent: html`<div class="chat-bubble text-sm py-2 px-3" style="--bubble-bg:color-mix(in srgb,${this._actorColor(msg.attributedTo)} 15%,var(--color-base-200,#f0f0f0))">
          <span class="text-xs opacity-60">shared a message</span>${snippet}
        </div>`,
        footerContent: announceFooter,
        persistentFooter: announcePersistentFooter,
        replies,
      });
    }

    if (msg && msg.error) {
      return this._renderChatRow(msg, {
        bubbleContent: html`<div class="chat-bubble chat-bubble-error text-xs py-1 px-2">${msg.error}</div>`,
        footerContent: html`<a class="link link-hover text-error" @click=${() => this._handleDeleteLocalMessage(msg)}>delete</a>`,
      });
    }

    const color = this._actorColor(msg.attributedTo);
    const hasSummary = msg && msg.summary;
    const msgIndex = this.messages.findIndex(m => m.id === msg.id);
    const showContent = this[`showContent${msgIndex}`] || false;
    const isCollapsed = this._collapsedThreads.has(msg.id);
    const hasReplies = msg.replies && msg.replies.length > 0;
    const isOwnMsg = msg.isLocal || msg.attributedTo === this.currentActorId;
    const isEditing = this._editingId === msg.id;

    const bubble = html`
      <div class="chat-bubble text-sm py-2 px-3" style="--bubble-bg:color-mix(in srgb,${color} 15%,var(--color-base-200,#f0f0f0))">
        ${hasSummary ? html`
          <div class="italic text-xs opacity-80 mb-1">${msg.summary}</div>
          <button class="btn btn-ghost btn-xs mb-1" @click=${() => { this[`showContent${msgIndex}`] = !showContent; this.requestUpdate(); }}>
            ${showContent ? 'Hide' : 'Show'} content
          </button>
        ` : ''}
        ${isEditing ? html`
          <textarea id="edit-input-${msg.id}" class="textarea textarea-bordered textarea-sm w-full"
            .value=${this._editingContent}
            @input=${(e) => { this._editingContent = e.target.value; }}></textarea>
          <div class="flex gap-1 mt-1">
            <button class="btn btn-primary btn-xs" @click=${() => this._saveEdit(msg)}>Save</button>
            <button class="btn btn-ghost btn-xs" @click=${() => { this._editingId = null; this.requestUpdate(); }}>Cancel</button>
          </div>
        ` : (!hasSummary || showContent ? html`<span>${msg.content}</span>` : '')}
      </div>
    `;

    const alreadyLiked = (msg.reactions?.['👍'] || []).includes(this.currentActorId);
    const likeCount = (msg.reactions?.['👍'] || []).length;

    const persistentFooter = (isCollapsed || likeCount > 0) ? html`
      ${isCollapsed ? html`
        <span class="text-xs opacity-60 cursor-pointer hover:opacity-100" @click=${() => this._toggleCollapse(msg.id)}>
          +${this._countDescendants(msg)} collapsed
        </span>
      ` : ''}
      ${likeCount > 0 ? html`
        <a class="link link-hover ${alreadyLiked ? 'opacity-100' : 'opacity-60'}" @click=${() => alreadyLiked
            ? this.controller.undoLike(this.selectedGroupId, msg.id).then(() => this.loadMessages(this.selectedGroupId))
            : this.controller.likeMessage(this.selectedGroupId, msg.id).then(() => this.loadMessages(this.selectedGroupId))}>
          👍 ${likeCount}
        </a>
      ` : ''}
    ` : null;

    const footer = html`
      ${msg.id ? html`<a class="link link-hover" @click=${() => this.handleReply(msg.id)}>reply</a>` : ''}
      ${likeCount === 0 ? html`<a class="link link-hover" @click=${() =>
          this.controller.likeMessage(this.selectedGroupId, msg.id).then(() => this.loadMessages(this.selectedGroupId))}>👍</a>` : ''}
      <a class="link link-hover" @click=${() => { this._boostPanel = { msg }; this._boostComment = ''; this._boostTargetGroupId = this.selectedGroupId; this._boostCrossGroup = false; }}>share</a>
      ${isOwnMsg ? html`
        <a class="link link-hover" @click=${() => { this._editingId = msg.id; this._editingContent = msg.content || ''; this.requestUpdate(); }}>edit</a>
        <a class="link link-hover text-error" @click=${() => this._handleDeleteMessage(msg)}>delete</a>
        <button class="btn btn-ghost btn-xs p-0 h-auto min-h-0"
          @click=${(e) => { e.stopPropagation(); this._deliveryPanel = { msg }; this._loadMembersData(); }}>
          ${this._renderDeliveryTicks(msg.deliveryStatus)}
        </button>
      ` : html`
        <a class="link link-hover text-error" @click=${() => this._handleDeleteLocalMessage(msg)}>delete</a>
      `}
    `;

    const replies = hasReplies && !isCollapsed
      ? msg.replies.map(reply => this.renderMessage(reply, depth + 1))
      : null;

    return this._renderChatRow(msg, { bubbleContent: bubble, footerContent: footer, persistentFooter, replies });
  }

  _selectGroup(groupId) {
    this.error = '';
    this.creatingNewGroup = false;
    this.showMembersPanel = false;
    this._deliveryPanel = null;
    this.loadMessages(groupId);
    if (!this._isWide) this.sidebarOpen = false;
  }

  render() {
    const creatingNewGroup = this.creatingNewGroup;
    return html`
      <header class="flex items-center gap-1 relative z-40 p-2">
        <button class="btn btn-ghost btn-sm btn-square" @click=${() => { this.sidebarOpen = !this.sidebarOpen; }} aria-label="Toggle threads">
          ${icon('list', { size: 20 })}
        </button>
        <button class="btn btn-primary btn-sm btn-square" @click=${() => this.createNewGroup()} aria-label="New thread" title="New thread">
          ${icon('plus', { size: 20, style: '' })}
        </button>
        <button class="btn btn-ghost btn-sm btn-square" @click=${() => this.pollInbox()} aria-label="Check for messages" title="Check for messages">
          ${icon('arrows-clockwise', { size: 20 })}
        </button>
        <div class="flex-1"></div>
        <div class="dropdown dropdown-end">
          <div tabindex="0" role="button" class="btn btn-ghost btn-sm gap-1" title="${this.currentActorId ? this.getActorNickname(this.currentActorId) : ''}">
            ${this.currentActorId ? html`
              ${this._renderAvatar(this.currentActorId, { size: 20 })}
              <span class="max-w-[8rem] truncate">${this._getDisplayName(this.currentActorId)}</span>
            ` : 'User'}
            ${icon('caret-down')}
          </div>
          <ul tabindex="0" class="dropdown-content menu menu-sm bg-base-200 rounded-box shadow-lg w-52 z-50 mt-1">
            ${this.currentActorId ? html`
              <li class="menu-title text-xs opacity-60 truncate">${this.getActorNickname(this.currentActorId)}</li>
            ` : ''}
            <li><theme-picker></theme-picker></li>
            <li><a @click=${() => this._openMyDevicesPanel()}>
              ${icon('gear')}
              Settings
            </a></li>
            <li class="border-t border-base-300 mt-1 pt-1"><a @click=${() => this._menuAction('logout')} class="text-warning">
              ${icon('sign-out')}
              Log out
            </a></li>
          </ul>
        </div>
      </header>

      <div class="chat-container drawer ${this.sidebarOpen && this._isWide ? 'drawer-open' : ''}">
        <input id="thread-drawer" type="checkbox" class="drawer-toggle"
          .checked=${this.sidebarOpen && !this._isWide}
          @change=${(e) => { this.sidebarOpen = e.target.checked; }} />

        <div class="drawer-content flex">
          <div class="messages-pane bg-base-100">
            ${this._renderDeliveryPanel()}
            ${this._renderReactionPanel()}
            ${this._renderSharePanel()}
            ${this._renderMembersPanel()}
            ${this.selectedGroupId && !this.creatingNewGroup ? html`
              <div class="px-3 py-2 border-b border-base-300 bg-base-200 flex items-center gap-2">
                ${this.currentThreadName && !this.threadNameIsAutoGenerated ? html`
                  ${this.editingThreadName ? html`
                    <input type="text" class="input input-bordered input-sm flex-1 font-semibold"
                      .value=${this.currentThreadName}
                      @input=${e => this.currentThreadName = e.target.value}
                      placeholder="Thread name" />
                    <button class="btn btn-primary btn-sm" @click=${() => this.saveThreadName()}>Save</button>
                    <button class="btn btn-ghost btn-sm" @click=${() => this.cancelEditThreadName()}>Cancel</button>
                  ` : html`
                    <div class="flex-1 font-semibold truncate">${this.currentThreadName}</div>
                    <button class="btn btn-ghost btn-xs" @click=${() => this.startEditingThreadName()}>Edit</button>
                  `}
                ` : html`<div class="flex-1"></div>`}
                <button class="btn btn-ghost btn-sm btn-square ${this.showMembersPanel ? 'btn-active' : ''}" @click=${() => this.toggleMembersPanel()} aria-label="Group members" title="Group members">
                  ${icon('users-three', { size: 20 })}
                </button>
              </div>
            ` : ''}
            <div class="messages-list">
              ${this.controller ? this.controller.buildThreadTree(this.messages).map(msg => html`<div class="thread-root">${this.renderMessage(msg, 0)}</div>`) : ''}
            </div>
            ${this.selectedGroupId && this.userLeft ? html`
              <div class="p-4 text-center text-sm opacity-60">You are no longer a member of this group.</div>
            ` : ''}
            ${this.selectedGroupId && this.groupEncryptionLost ? (() => {
              const reinviteMembers = this.currentGroupMembers.filter(id => id !== this.currentActorId);
              if (reinviteMembers.length === 0) return '';
              return html`
                <div class="card card-bordered border-warning bg-warning/10 m-4">
                  <div class="card-body p-4 gap-2">
                    <h3 class="card-title text-warning text-sm">Encryption keys lost for this thread</h3>
                    <p class="text-sm opacity-80">The local encryption state is no longer available. Reset encryption to re-create the group and re-invite members.</p>
                    <div class="flex flex-wrap gap-1">
                      <span class="text-xs opacity-80">Will re-invite:</span>
                      ${reinviteMembers.map(actorId => this._renderUsername(actorId, { classes: 'badge-warning badge-outline' }))}
                    </div>
                    <div class="card-actions flex-col">
                      <button class="btn btn-warning btn-sm btn-block" @click=${() => this.handleResetEncryption()} ?disabled=${this.loading}>
                        ${this.loading ? 'Resetting...' : 'Reset encryption'}
                      </button>
                      ${this._renderArchiveButton()}
                    </div>
                  </div>
                </div>
              `;
            })() : ''}
            ${(this.selectedGroupId || this.creatingNewGroup) && !this.groupEncryptionLost && !this.userLeft ? html`
              <form class="flex flex-col gap-3 p-4 border-t border-base-300 bg-base-200" @submit=${e => { e.preventDefault(); this.sendMessage(); }}>
                ${(() => {
                  const displayMembers = this.currentGroupMembers.filter(actorId => actorId !== this.currentActorId);
                  const shouldShowReplyIndicator = !creatingNewGroup && (displayMembers.length > 0 || this.replyToId);
                  return shouldShowReplyIndicator ? html`
                    <div class="alert alert-info py-2 flex justify-between">
                      <div class="flex-1">
                        <div class="text-xs opacity-80 mb-1">Replying to:</div>
                        ${displayMembers.length > 0 ? html`
                          <div class="flex flex-wrap gap-1 ${this.replyToId ? 'mb-2' : ''}">
                            ${displayMembers.map(actorId => this._renderUsername(actorId))}
                          </div>
                        ` : ''}
                        ${this.replyToId ? html`
                          <div class="badge badge-sm badge-ghost italic truncate line-clamp-1">${this.replyToSnippet || this.replyToId}</div>
                        ` : ''}
                      </div> 
                      ${this.replyToId ? html`
                        <button class="btn btn-error btn-xs" type="button" @click=${() => this.cancelReply()}>Cancel</button>
                      ` : ''}
                    </div>
                  ` : '';
                })()}
                ${creatingNewGroup ? html`
                  <input class="input input-bordered" type="text" .value=${this.name} @input=${e => this.name = e.target.value} placeholder="Thread name (optional)" />
                  <div class="flex flex-col gap-2">
                    ${this._resolvedRecipients.length > 0 ? html`
                      <div class="flex flex-wrap gap-1">
                        ${this._resolvedRecipients.map((r, i) => html`
                          <span class="badge gap-1 ${r.resolved && r.hasKey ? 'badge-success' : r.resolved ? 'badge-warning' : 'badge-error'}"
                            title="${r.fingerprint ? r.fingerprint.map(e => `${e.emoji} ${e.description}`).join(', ') : r.error || ''}">
                            ${r.resolved && r.actorUri ? this._renderAvatar(r.actorUri, { size: 16 }) : ''}
                            ${r.error ? html`<span class="text-xs opacity-80">${r.error}</span>` : icon('check', { size: 12 })}
                            ${r.displayName || r.input}
                            ${r.fingerprint ? html`<span class="text-xs">${r.fingerprint.map(e => e.emoji).join('')}</span>` : ''}
                            <button type="button" class="cursor-pointer ml-1 opacity-60 hover:opacity-100" @click=${() => this._removeRecipient(i)}>&times;</button>
                          </span>
                        `)}
                      </div>
                    ` : ''}
                    <div class="flex gap-1">
                      <input class="input input-bordered input-sm flex-1" type="text"
                        .value=${this._recipientInput}
                        @input=${e => this._recipientInput = e.target.value}
                        @keydown=${e => { if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); this._addRecipient(); } }}
                        @blur=${() => { if (this._recipientInput.trim()) this._addRecipient(); }}
                        placeholder="Add recipient (@user@domain)" />
                      <button type="button" class="btn btn-sm btn-ghost"
                        @click=${() => this._addRecipient()}
                        ?disabled=${!this._recipientInput.trim() || this._resolvingRecipient}>
                        ${this._resolvingRecipient
                          ? html`<span class="loading loading-spinner loading-xs"></span>`
                          : icon('plus', { size: 16 })}
                      </button>
                    </div>
                  </div>
                ` : ''}
                ${this.showCW ? html`
                  <input class="input input-bordered input-sm w-full" type="text" .value=${this.summary} @input=${e => this.summary = e.target.value} placeholder="CW / Summary" />
                ` : ''}
                <div class="flex gap-2 items-end">
                  <div class="flex flex-col gap-1 flex-1">
                    <textarea class="textarea textarea-bordered w-full"
                      .value=${this.input}
                      @input=${e => { this.input = e.target.value; e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
                      placeholder="Type a message..."
                      style="resize: none; overflow-y: hidden; min-height: 2.5rem; max-height: 20rem;"
                    ></textarea>
                  </div>
                  <div class="flex flex-col gap-1">
                    <button class="btn btn-ghost btn-xs btn-square ${this.showCW ? 'btn-active' : ''}" type="button"
                      @click=${() => { this.showCW = !this.showCW; }} title="Content warning / Summary" aria-label="Toggle CW">
                      ${icon('warning')}
                    </button>
                    <button class="btn btn-primary btn-sm btn-square" type="submit" title="Send" aria-label="Send message">
                      ${icon('paper-plane-right', { size: 20 })}
                    </button>
                  </div>
                </div>
              </form>
            ` : ''}
            ${this.error ? html`<div class="alert alert-error mt-2">${this.error}</div>` : ''}
          </div>
        </div>

        <div class="drawer-side">
          <label for="thread-drawer" aria-label="close sidebar" class="drawer-overlay"></label>
          <div class="group-list bg-base-200 w-72 max-w-[80vw] overflow-x-hidden border-r border-base-300">
            ${!this.groups || this.groups.length == 0 ? html`
              <div class="flex flex-col items-center justify-center gap-2 p-6 opacity-50">
                ${icon('chat-circle-dots', { size: 40 })}
                <p class="text-sm text-center">No threads yet</p>
              </div>
            ` : html`
              <ul class="menu menu-sm">
                ${this.groups.map(g => html`
                  <li>
                    <div class="${g.hasUnread ? 'indicator w-full' : ''}">
                      ${g.hasUnread ? html`<span class="indicator-item badge badge-primary badge-xs"></span>` : ''}
                      <a class="w-full ${this.selectedGroupId === g.id ? 'active' : ''}"
                         @click=${() => this._selectGroup(g.id)}>
                        <div class="overflow-hidden flex-1 min-w-0">
                          <div class="font-medium truncate ${g.hasUnread ? 'font-bold' : ''}">${g.name || this._groupMemberNames(g) || g.id}</div>
                          <div class="text-xs opacity-60 truncate">${this.decryptedSummary(g.decryptedContent) || this.decryptedSummary(g.lastMessage && g.lastMessage.content) || ''}</div>
                        </div>
                      </a>
                    </div>
                  </li>
                `)}
              </ul>
            `}
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('e2ee-chat-view', E2EEChatView)
