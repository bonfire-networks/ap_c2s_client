import { html, css, LitElement } from 'lit'
import { relativeTime, formatFileSize } from '../utils.js'
import { ChatController, EncryptionLostError, groupDeliveryByActor } from '../chat-controller.js'
import { MLSService } from '../mls/mls-service.js'
import * as storage from '../storage/indexeddb-storage.js'
import { logout } from '../activitypub/auth.js'
import { adoptDaisyUI, icon } from './shared-styles.js'
import './theme-picker.js'
import './my-devices-panel.js'

// Grouped mime type definitions — source of truth for both _guessMime and file picker filters
const MIME_GROUPS = {
  Images:    { 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp', 'heic': 'image/heic', 'avif': 'image/avif', 'svg': 'image/svg+xml' },
  Video:     { 'mp4': 'video/mp4', 'mov': 'video/quicktime', 'webm': 'video/webm', 'mkv': 'video/x-matroska', 'avi': 'video/x-msvideo', 'm4v': 'video/mp4' },
  Audio:     { 'mp3': 'audio/mpeg', 'ogg': 'audio/ogg', 'wav': 'audio/wav', 'flac': 'audio/flac', 'aiff': 'audio/aiff', 'aif': 'audio/aiff', 'm4a': 'audio/mp4', 'opus': 'audio/opus', 'aac': 'audio/aac' },
  Documents: { 'pdf': 'application/pdf', 'epub': 'application/epub+zip', 'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'ppt': 'application/vnd.ms-powerpoint', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'odt': 'application/vnd.oasis.opendocument.text', 'ods': 'application/vnd.oasis.opendocument.spreadsheet', 'odp': 'application/vnd.oasis.opendocument.presentation', 'txt': 'text/plain', 'md': 'text/markdown', 'csv': 'text/csv', 'json': 'application/json' },
  Archives:  { 'zip': 'application/zip', 'gz': 'application/gzip', '7z': 'application/x-7z-compressed', 'rar': 'application/vnd.rar', 'tar': 'application/x-tar', 'bz2': 'application/x-bzip2', 'xz': 'application/x-xz' },
};
const _MIME_FLAT = Object.assign({}, ...Object.values(MIME_GROUPS));
function _guessMime(ext) { return _MIME_FLAT[ext] || 'application/octet-stream'; }

// File picker filters: one per group + "All supported" merging all known extensions
const FILE_PICKER_FILTERS = [
  { name: 'Common file types', extensions: Object.keys(_MIME_FLAT) },
  ...Object.entries(MIME_GROUPS).map(([name, map]) => ({ name, extensions: Object.keys(map) })),
  { name: 'All files', extensions: ['*'] },
];

// Extensions blocked from sending (executables, scripts, etc.)
const BLOCKED_EXTENSIONS = new Set([
  'exe','msi','bat','cmd','com','ps1','sh','bash','zsh','fish',
  'app','dmg','pkg','deb','rpm',
  'js','ts','jsx','tsx','py','rb','pl','php','lua','r',
  'dll','so','dylib','sys','ko',
  'vbs','wsf','hta','scr','pif',
]);

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
      z-index: 2;
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
    /* Stem: drawn on the click overlay. Starts at parent avatar center and fades at bottom. */
    .thread-stem-click::before {
      content: '';
      position: absolute;
      left: calc(1.125rem - 1px);
      top: 2.725rem;
      bottom: 0;
      width: 2px;
      background: linear-gradient(to bottom, var(--thread-color, var(--color-base-300)) 70%, transparent 100%);
      opacity: 0.5;
      pointer-events: none;
    }
    /* Angled connector from stem to child avatar center (12° drop) */
    .thread-children > .thread-root::after {
      content: '';
      position: absolute;
      left: -1.125rem;
      top: 2.247rem;
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
      noLongerMember: { type: Boolean, state: true },
      sidebarOpen: { type: Boolean, state: true },
      _isWide: { type: Boolean, state: true },
      showCW: { type: Boolean, state: true },
      showMembersPanel: { type: Boolean, state: true },
      _membersData: { type: Array, state: true },
      _membersLoading: { type: Boolean, state: true },
      _highlightedMember: { type: String, state: true },
      _highlightedClientKey: { type: String, state: true },
      _actorProfiles: { type: Object, state: true },
      _deliveryPanel: { type: Object, state: true },

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
      _emojiPickerMsgId: { type: String, state: true },
      _reactionsPanel: { type: Object, state: true }, // { msg } | null
      _pendingAttachments: { type: Array, state: true },
      _attachmentError: { type: String, state: true },
      _attachmentLoading: { type: Boolean, state: true },
      _lightbox: { type: Object, state: true },
      _attachmentsReady: { type: Boolean, state: true },
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
    this._highlightedClientKey = null
    this._actorProfiles = new Map()
    this._deliveryPanel = null

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
    this._emojiPickerMsgId = null
    this._reactionsPanel = null
    this._addMemberError = null
    this._profileLoadPending = new Set()
    this._pendingAttachments = []
    this._attachmentError = ''
    this._attachmentLoading = false
    this._mediaUrlCache = new Map() // localPath → { src, tempPath }
    this._audioActivated = new Set() // localPaths where user clicked play
    this._lightbox = null // { src, type, name } — shown in overlay when set
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
    this.noLongerMember = false

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
    this._closeEmojiPicker = () => { if (this._emojiPickerMsgId) this._emojiPickerMsgId = null; };
    document.addEventListener('click', this._closeEmojiPicker);
    try {
      // Dynamic backend selection: Tauri native Rust or WASM
      const wasmPath = localStorage.getItem('wasmBasePath');
      const useTauri = wasmPath === 'false' && window.__TAURI__;
      console.log('[ChatView] Using backend:', useTauri ? 'Tauri Rust plugin' : 'OpenMLS WASM');
      const backend = useTauri
        ? await import('../mls/openmls-tauri/tauri-backend.js')
        : await import('../mls/openmls-wasm/openmls-backend.js');
      // Debug: skip storage if flagged by the recovery dialog (via file flag or sessionStorage)
      const skipFromSession = sessionStorage.getItem('skipStorage');
      const skipFromRust = window.__TAURI__?.core?.invoke
        ? await window.__TAURI__.core.invoke('check_skip_storage').catch(() => null)
        : null;
      const skipStorage = skipFromRust || skipFromSession;
      if (skipStorage) {
        sessionStorage.removeItem('skipStorage');
        console.warn('[ChatView] Storage noop:', skipStorage);
        if (skipStorage === 'previews') {
          this._skipPreviews = true; // serve files but skip thumbnail generation
        } else {
          storage.setNoop(skipStorage);
        }
      } else {
        // Isolate storage per actor so switching accounts doesn't leak dataat
        const actorId = localStorage.getItem('actor_id');
        if (actorId) storage.initForActor(actorId);
      }

      // Verify the DB is readable before proceeding — catches corruption from interrupted writes
      try {
        if (!skipStorage) await storage.verifyDb();
      } catch (dbErr) {
        const msg = `Local chat database is corrupted and cannot be opened.\n\n${dbErr}\n\nYour account and encryption keys are not affected.`;
        if (window.__TAURI__?.core?.invoke) {
          await window.__TAURI__.core.invoke('show_crash_dialog', { message: msg });
        } else {
          alert(msg);
        }
        return; // stop init — dialog handled reload/clear
      }

      const mlsService = new MLSService(backend, storage);
      // console.log('[ChatView] MLSService initialized with backend:', mlsService);
      this.controller = new ChatController(mlsService, storage);
      this.controller.onAsyncResult = (r) => {
        if (r.type === 'coDeviceLeaving') this._showDeviceConfirmation({ ...r, isLeaving: true });
        if (r.type === 'coDeviceLeaveResolved') {
          // Another device committed the leave — dismiss open leaving-confirmation dialog only
          this.shadowRoot.querySelector('dialog[data-nd-leaving]')?.remove();
        }
      };
      console.log('[ChatView] ChatController initialized:', this.controller);

      const { actor, kpResult, pendingLeaves } = await this.controller.init();
      console.log('[ChatView] Actor initialized:', actor);
      if (kpResult?.type === 'newDevicePending') this._showDeviceConfirmation(kpResult);
      for (const leave of (pendingLeaves || [])) {
        this._showDeviceConfirmation({ ...leave, isLeaving: true });
      }
      this.currentActorId = actor.id;
      this._sendReadReceipts = await this.controller.storage.loadUserSetting(actor.id, 'sendReadReceipts', false);
      this._ensureActorProfile(actor.id);

      // Set window title with username so multiple instances are distinguishable
      const nickname = this.getActorNickname(actor.id);
      if (window.__TAURI__) {
        window.__TAURI__.window.getCurrentWindow().setTitle(`Secure Chat - ${nickname}`);
      }

      // Signal successful init so the crash dialog dedup flag is reset
      window.__TAURI__?.core?.invoke?.('signal_app_ready').catch(() => {});

      this._initAttachmentEvents();
      await this.loadGroups();
      this.pollInbox();

      // Fallback periodic poll when awaiting co-device approval (no SSE in that state).
      // Clears itself once approval is received (dialog removed = no longer awaiting).
      if (this.controller._awaitingApproval) {
        const approvalPoll = setInterval(() => {
          if (!this.controller._awaitingApproval) { clearInterval(approvalPoll); return; }
          this.pollInbox().catch(() => {});
        }, 5000);
      }

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
          this._sseDebounce = setTimeout(() => {
            this.pollInbox().then(results => {
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
            }).catch(e => console.warn('[SSE] Poll failed:', e));
          }, 500);
        });

        // When SSE reconnects after a drop, poll inbox to catch any missed messages
        this._unlistenSseReconnected = await window.__TAURI__.event.listen('sse-reconnected', () => {
          console.log('[SSE] Reconnected — polling inbox for missed messages');
          this.pollInbox().catch(e => console.warn('[SSE] Reconnect poll failed:', e));
        });

        // Drain in-flight DB writes before the window closes to prevent corruption
        this._unlistenCloseRequested = await window.__TAURI__.event.listen('tauri://close-requested', async () => {
          await storage.drainWrites();
          const appWindow = window.__TAURI__.window.getCurrentWindow();
          await appWindow.destroy();
        });
      }
    } catch (e) {
      this.error = e.message;
      // Re-throw so the global handler in tauri-init.js shows the recovery overlay
      throw e;
    }
  }

  updated() {
    console.log('[updated] start');
    // Observe unread message elements and mark them read when they scroll into view
    if (!this._readObserver) {
      console.log('[updated] initializing observers');
      this._pendingReadEntries = new Map(); // msgId → element, for entries seen while unfocused

      const markRead = (msgId, groupId) => {
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

      this._thumbObjMap = new Map(); // localPath → { obj, msg, groupId }
      this._serveInFlight = 0; // concurrency counter for serveAttachment calls
      const MAX_SERVE_CONCURRENT = 2;

      this._readObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target;

          // Thumbnail generation
          if (el.dataset.needsThumb) {
            this._readObserver.unobserve(el);
            const key = el.dataset.needsThumb;
            const item = this._thumbObjMap.get(key);
            if (item) {
              const { obj, msg, groupId } = item;
              // In previews debug mode: skip serveAttachment entirely (just show spinner)
              if (this._skipPreviews) continue;
              // Throttle concurrent decompression — re-observe if at limit and retry later
              if (this._serveInFlight >= MAX_SERVE_CONCURRENT) {
                setTimeout(() => this._readObserver.observe(el), 500);
                continue;
              }
              this._serveInFlight++;
              this._mediaObjectUrl(obj, { eager: true });
              // Poll until src is ready, then load via <img> element and draw to canvas —
              // avoids fetch(blob) which loads the full file into JS memory and freezes WebKit
              const waitForSrc = () => {
                const urls = this._mediaUrlCache.get(key);
                if (!urls) { setTimeout(waitForSrc, 100); return; }
                const imgEl = new Image();
                imgEl.onload = () => {
                  this._generateThumbnail(imgEl)
                    .then(dataUrl => {
                      obj._thumbDataUrl = dataUrl;
                      this._thumbObjMap.delete(key);
                      if (msg) {
                        this.controller.storage.getMessage(msg.id).then(stored => {
                          if (stored) this.controller.storage.saveMessage(
                            groupId || this.selectedGroupId, stored.content || stored,
                            msg.id, msg.isLocal, undefined, undefined, stored.timestamp);
                        });
                      }
                      this.requestUpdate();
                    }).catch(e => {
                      console.warn('[chat] thumbnail generation failed, skipping:', e);
                      obj._thumbFailed = true;
                      this._thumbObjMap.delete(key);
                      this.requestUpdate();
                    }).finally(() => { this._serveInFlight = Math.max(0, this._serveInFlight - 1); });
                };
                imgEl.onerror = () => {
                  console.warn('[chat] image load failed, skipping:', urls.src);
                  obj._thumbFailed = true;
                  this._thumbObjMap.delete(key);
                  this._serveInFlight = Math.max(0, this._serveInFlight - 1);
                  this.requestUpdate();
                };
                imgEl.src = urls.src;
              };
              waitForSrc();
            }
            continue;
          }

          // Read receipt
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
    const unread = this.shadowRoot.querySelectorAll('[data-unread]');
    const thumbs = this.shadowRoot.querySelectorAll('[data-needs-thumb]');
    console.log(`[updated] observing ${unread.length} unread, ${thumbs.length} needs-thumb`);
    unread.forEach(el => this._readObserver.observe(el));
    thumbs.forEach(el => this._readObserver.observe(el));
    // Defer attachment rendering and img src assignment to avoid WebKit synchronously blocking the DOM commit
    requestAnimationFrame(() => {
      this.shadowRoot.querySelectorAll('img[data-lazy-src]').forEach(img => {
        img.src = img.dataset.lazySrc;
      });
      this.shadowRoot.querySelectorAll('audio[data-autoplay]').forEach(el => {
        el.removeAttribute('data-autoplay');
        el.play().catch(() => {});
      });
      if (!this._attachmentsReady) {
        this._attachmentsReady = true;
      }
    });
    console.log('[updated] done');
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._closeEmojiPicker) { document.removeEventListener('click', this._closeEmojiPicker); this._closeEmojiPicker = null; }
    if (this._onWindowFocus) { window.removeEventListener('focus', this._onWindowFocus); this._onWindowFocus = null; }
    if (this._readObserver) { this._readObserver.disconnect(); this._readObserver = null; }
    if (this._thumbObjMap) { this._thumbObjMap.clear(); this._thumbObjMap = null; }
    delete window.navigateToGroup;
    if (this._unlistenNewMessage) {
      this._unlistenNewMessage();
    }
    if (this._unlistenSseReconnected) {
      this._unlistenSseReconnected();
    }
    if (this._unlistenCloseRequested) {
      this._unlistenCloseRequested();
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
      console.log('[loadGroups] calling loadGroupList');
      this.groups = await this.controller.loadGroupList();
      console.log('[loadGroups] got', this.groups.length, 'groups');
      if (this.groups.length > 0 && !this.selectedGroupId) {
        this.selectedGroupId = this.groups[0].id;
        console.log('[loadGroups] calling loadMessages for first group', this.selectedGroupId);
        await this.loadMessages(this.selectedGroupId);
        console.log('[loadGroups] loadMessages done');
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
      console.log(`[loadMessages] assigning ${result.messages.length} msgs to state`);
      this._attachmentsReady = false;
      this.messages = result.messages;
      console.log('[loadMessages] state assigned, waiting for updateComplete');
      this.currentGroupMembers = result.members;
      this.currentThreadName = result.threadName;
      this.threadNameIsAutoGenerated = result.threadNameIsAutoGenerated;
      this.noLongerMember = result.noLongerMember || false;
      this.groupEncryptionLost = !result.encryptionAvailable && !result.noLongerMember;
      // Load fingerprint colors eagerly so bubble colors are consistent for all clients
      console.log('[loadMessages] calling _loadFingerprintColors');
      this._loadFingerprintColors();
      console.log('[loadMessages] done');
    } catch (e) {
      this.error = e.message;
    }
    this.loading = false;

    if (wasAtBottom) {
      console.log('[loadMessages] awaiting updateComplete for scroll');
      setTimeout(() => console.log('[loadMessages] 500ms timeout fired (event loop alive)'), 500);
      await this.updateComplete;
      console.log('[loadMessages] updateComplete resolved, scheduling scroll');
      requestAnimationFrame(() => this._scrollToBottom(false));
    }
  }

  async pollInbox() {
    if (this._pollingInbox) return [];
    this._pollingInbox = true;
    try {
      const results = await this.controller.pollInbox();
      if (results.length > 0) {
        // Handle new device requests before reloading (non-MLS result, no groupId)
        for (const r of results) {
          if (r.type === 'coDeviceLeaving') {
            this._showDeviceConfirmation({ ...r, isLeaving: true });
          } else if (r.type === 'coDeviceLeaveResolved') {
            this.shadowRoot.querySelector('dialog[data-nd-leaving]')?.remove();
          } else if (r.type === 'newDeviceRequest' || r.type === 'newDevicePending') {
            this._showDeviceConfirmation(r);
          } else if (r.type === 'newDeviceApproved' || r.type === 'welcome' || r.type === 'groupinfo') {
            // Approved (no-groups case) or joined a group — close pending dialog only if
            // approval actually completed (not a Welcome for a different co-device's KP)
            if (!this.controller._awaitingApproval) {
              this.shadowRoot.querySelector('#nd-pending-dialog')?.remove();
            }
          }
        }

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
    } finally {
      this._pollingInbox = false;
    }
  }

  _showDeviceConfirmation({ fingerprint, kpB64, isLeaving = false, groupId = null, proposalActivityId = null }) {
    const isPending = !kpB64 && !isLeaving;
    if (isPending && this.shadowRoot.querySelector('#nd-pending-dialog')) return; // already showing
    if (isLeaving && this.shadowRoot.querySelector('dialog[data-nd-leaving]')) return; // already showing
    const emojiStr = Array.isArray(fingerprint) ? fingerprint.map(e => e.emoji).join(' ') : (fingerprint || '');

    const title = isLeaving
      ? 'A device is leaving'
      : (isPending ? 'Waiting for approval' : 'New device wants to join your account');
    const description = isLeaving
      ? 'Confirm removal of this device from your encrypted conversations:'
      : (isPending
          ? 'Show this fingerprint to your other device and ask it to approve:'
          : 'Verify that the fingerprint shown on your new device matches exactly:');
    const hint = isLeaving
      ? 'Confirm only if this is the device you intended to remove. The device will lose access to all encrypted conversations.'
      : (isPending
          ? 'This dialog will close automatically once approved.'
          : "Only approve if you recognise this device. If the emoji don't match, reject.");
    const buttons = isLeaving
      ? '<button class="btn btn-ghost btn-sm" id="nd-cancel">Dismiss</button><button class="btn btn-error btn-sm" id="nd-approve">Confirm removal</button>'
      : (isPending
          ? '<button class="btn btn-ghost btn-sm" id="nd-cancel">Cancel</button>'
          : '<button class="btn btn-error btn-sm" id="nd-reject">Reject</button><button class="btn btn-primary btn-sm" id="nd-approve">Approve</button>');

    const dialog = document.createElement('dialog');
    if (isPending) dialog.id = 'nd-pending-dialog';
    if (isLeaving) dialog.dataset.ndLeaving = 'true';
    dialog.className = 'modal modal-open';
    dialog.innerHTML = `
      <div class="modal-box max-w-sm">
        <h3 class="font-bold text-lg mb-2">${title}</h3>
        <p class="text-sm opacity-70 mb-4">${description}</p>
        ${emojiStr ? `<div data-role="nd-fingerprint" class="text-3xl text-center tracking-widest py-3 px-4 bg-base-200 rounded-lg mb-4 select-all">${emojiStr}</div>` : ''}
        <p class="text-xs opacity-50 mb-4">${hint}</p>
        <div id="nd-error" class="alert alert-error text-sm mb-2 hidden"></div>
        <div class="modal-action gap-2">${buttons}</div>
      </div>
    `;

    const close = () => { dialog.remove(); };

    dialog.querySelector('#nd-cancel')?.addEventListener('click', close);
    dialog.querySelector('#nd-reject')?.addEventListener('click', close);

    if (isLeaving) {
      dialog.querySelector('#nd-approve').addEventListener('click', async () => {
        try {
          dialog.querySelector('#nd-approve').disabled = true;
          await this.controller.commitCoDeviceLeaving(groupId, proposalActivityId);
          close();
        } catch (e) {
          console.error('[NewDevice] Commit leaving failed:', e);
          const errEl = dialog.querySelector('#nd-error');
          errEl.textContent = 'Failed to confirm removal: ' + (e.message || e);
          errEl.classList.remove('hidden');
          dialog.querySelector('#nd-approve').disabled = false;
        }
      });
    } else if (!isPending) {
      dialog.querySelector('#nd-approve').addEventListener('click', async () => {
        try {
          dialog.querySelector('#nd-approve').disabled = true;
          await this.controller.approveNewDevice(kpB64);
          close();
        } catch (e) {
          console.error('[NewDevice] Approval failed:', e);
          const errEl = dialog.querySelector('#nd-error');
          errEl.textContent = 'Approval failed: ' + (e.message || e);
          errEl.classList.remove('hidden');
          dialog.querySelector('#nd-approve').disabled = false;
        }
      });
    }

    this.shadowRoot.appendChild(dialog);
    console.log('[_showDeviceConfirmation] dialog appended, #nd-approve text:', this.shadowRoot.querySelector('#nd-approve')?.textContent?.trim());
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

  // ──────────────────────────────────────────────
  // Attachments — file picking + Rust-side processing
  // ──────────────────────────────────────────────

  /** Register Rust attachment event listeners. Called once from connectedCallback. */
  async _initAttachmentEvents() {
    const backend = this.controller?.mlsService?.backend;
    if (!backend?.onAttachmentReady) return;
    this._unlistenAttachmentReady = await backend.onAttachmentReady(({ id, size, compressedSize, localPath }) => {
      this._pendingAttachments = this._pendingAttachments.map(a =>
        a.id === id ? { ...a, status: 'ready', size, compressedSize, localPath } : a);
    });
    this._unlistenAttachmentFailed = await backend.onAttachmentFailed(({ id, error }) => {
      this._pendingAttachments = this._pendingAttachments.map(a =>
        a.id === id ? { ...a, status: 'failed', error } : a);
    });
  }

  /** Open the native OS file picker via tauri-plugin-dialog. */
  async _openFilePicker() {
    const { open } = window.__TAURI__?.dialog || {};
    if (!open) { console.warn('[attachments] tauri-plugin-dialog not available'); return; }
    const result = await open({ multiple: true, filters: FILE_PICKER_FILTERS });
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    for (const filePath of paths) {
      this._addAttachment(filePath); // fire-and-forget; Rust emits events when ready
    }
  }

  /** Start processing one file. For images (except GIF): Canvas→WebP→Rust bytes. For others: Rust reads from disk. */
  async _addAttachment(filePath) {
    const id = crypto.randomUUID();
    const fileName = filePath.split(/[/\\]/).pop();
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      this._attachmentError = `File type .${ext} is not allowed`;
      return;
    }
    const isAnimated = ext === 'gif'; // preserve animation — skip WebP conversion
    const isRasterImage = ['jpg','jpeg','png','webp','bmp','heic'].includes(ext);
    const isImage = isRasterImage || isAnimated;
    const mediaType = isRasterImage ? 'image/webp' : _guessMime(ext);
    const apType = isImage ? 'Image' : (mediaType.startsWith('audio/') ? 'Audio' : mediaType.startsWith('video/') ? 'Video' : 'Document');

    // Show the entry immediately with 'processing' status
    // Preview: use convertFileSrc to show original file while WebP is being prepared
    const { convertFileSrc } = window.__TAURI__?.core || {};
    const rawPreviewUrl = convertFileSrc ? convertFileSrc(filePath) : null;

    this._pendingAttachments = [...this._pendingAttachments, {
      id, name: isRasterImage ? fileName.replace(/\.[^.]+$/, '.webp') : fileName,
      apType, mediaType, size: 0,
      previewUrl: isImage ? rawPreviewUrl : null, // show original while converting
      status: 'processing', filePath,
      _attachmentId: id,
    }];

    const backend = this.controller.mlsService.backend;

    if (isRasterImage) {
      try {
        // Fetch original image, compress to WebP via Canvas, pass bytes to Rust once
        const res = await fetch(rawPreviewUrl || filePath);
        const blob = await res.blob();
        if (blob.size > 50 * 1024 * 1024) { 
          this._pendingAttachments = this._pendingAttachments.map(a =>
            a.id === id ? { ...a, status: 'failed', error: 'Image too large (max 50 MB)' } : a);
          return;
        }
        // Generate thumbnail immediately from raw blob — fastest possible preview
        const thumbDataUrl = await this._generateThumbnail(blob);
        this._pendingAttachments = this._pendingAttachments.map(a =>
          a.id === id ? { ...a, previewUrl: thumbDataUrl, thumbDataUrl, _rawPreviewUrl: rawPreviewUrl } : a);
        const webpBlob = await this._compressToWebP(blob);
        this._pendingAttachments = this._pendingAttachments.map(a =>
          a.id === id ? { ...a, size: webpBlob.size } : a);
        // Pass WebP bytes to Rust (one-time transfer; Rust emits attachment-ready when done)
        const bytes = new Uint8Array(await webpBlob.arrayBuffer());
        await backend.prepareAttachmentBytes(id, bytes);
      } catch (e) {
        this._pendingAttachments = this._pendingAttachments.map(a =>
          a.id === id ? { ...a, status: 'failed', error: e.message } : a);
      }
    } else {
      // GIFs, audio, video, documents: Rust reads from disk directly; emits attachment-ready/failed
      backend.prepareAttachmentFile(id, filePath).catch(e => {
        this._pendingAttachments = this._pendingAttachments.map(a =>
          a.id === id ? { ...a, status: 'failed', error: e?.message || String(e) } : a);
      });
    }
  }

  /** Remove a pending attachment and clean up Rust state. */
  async _removeAttachment(id) {
    const att = this._pendingAttachments.find(a => a.id === id);
    if (att?.previewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(att.previewUrl); // only revoke blob URLs, not data: or convertFileSrc URLs
    }
    await this.controller.mlsService.backend.removeAttachment?.({ attachmentId: id }).catch(() => {});
    this._pendingAttachments = this._pendingAttachments.filter(a => a.id !== id);
  }

  /**
   * Resize an image source (Blob or ImageBitmap) to WebP, constraining the longer
   * dimension to maxDim while preserving aspect ratio (no cropping).
   * Returns a Blob when asDataUrl=false, or a data URL string when asDataUrl=true.
   */
  async _resizeToWebP(source, { maxDim = 2048, quality = 0.85, asDataUrl = false } = {}) {
    const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    // Use 9-arg form to explicitly draw full source — prevents any accidental cropping
    canvas.getContext('2d').drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, w, h);
    if (asDataUrl) return canvas.toDataURL('image/webp', quality);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/webp', quality));
    if (!blob) throw new Error('WebP conversion failed');
    return blob;
  }

  /** Compress a Blob to WebP (max 2048px). Returns a Blob. */
  async _compressToWebP(blob, maxDim = 2048, quality = 0.85) {
    return this._resizeToWebP(blob, { maxDim, quality, asDataUrl: false });
  }

  /** Generate a WebP thumbnail capped at 192px. Returns a data URL. */
  async _generateThumbnail(source) {
    return this._resizeToWebP(source, { maxDim: 192, quality: 0.85, asDataUrl: true });
  }

  /** Resolve a received AP media object. Returns { src, tempPath } or null while loading.
   *  src: asset:// URL usable in <img>/<audio>/<video>/<a href>.
   *  tempPath: raw filesystem path, used for saveAttachmentAs on document types. */
  _mediaObjectUrl(obj, { eager = false, autoOpen = false } = {}) {
    if (obj?._localPath) {
      const cacheKey = obj._localPath;
      if (this._mediaUrlCache.has(cacheKey)) return this._mediaUrlCache.get(cacheKey);
      if (!eager) return null; // defer decompression until explicitly requested
      const backend = this.controller?.mlsService?.backend;
      if (backend?.serveAttachment) {
        backend.serveAttachment(obj._localPath).then(tempPath => {
          const { convertFileSrc } = window.__TAURI__?.core || {};
          const src = convertFileSrc ? convertFileSrc(tempPath) : `file://${tempPath}`;
          this._mediaUrlCache.set(cacheKey, { src, tempPath });
          if (autoOpen) this._lightbox = { src, type: obj.type, name: obj.name };
          this.requestUpdate();
        }).catch(e => console.error('[chat] serveAttachment failed:', e));
      }
      return null;
    }
    if (!obj?.content) return null;
    const dataUrl = `data:${obj.mediaType};base64,${obj.content}`;
    return { src: dataUrl, tempPath: null };
  }

  /** Render a received AP media object (Image/Audio/Video/Document). */
  /** Shared file chip: icon + name + secondary line. Pass `href` for a link, `onClick` for a button action. */
  _renderFileChip({ name, size, previewUrl, secondary, href, onClick, onRemove } = {}) {
    const inner = html`
      ${previewUrl
        ? html`<img src=${previewUrl} loading="lazy" decoding="async" class="w-10 h-10 object-cover rounded">`
        : icon('paperclip', { size: 14 })}
      <div class="flex flex-col min-w-0">
        <span class="max-w-[8rem] truncate">${name || 'file'}</span>
        ${secondary ?? (size ? html`<span class="opacity-50">${formatFileSize(size)}</span>` : '')}
      </div>`;
    return html`
      <div class="relative flex items-center gap-1 rounded px-2 py-1 text-xs bg-base-300">
        ${href
          ? html`<a href=${href} target="_blank" class="flex items-center gap-1 hover:underline">${inner}</a>`
          : html`<button type="button" class="flex items-center gap-1 hover:opacity-80" @click=${onClick}>${inner}</button>`}
        ${onRemove ? html`<button type="button" class="btn btn-ghost btn-xs btn-square p-0 ml-1"
          @click=${onRemove}>✕</button>` : ''}
      </div>`;
  }

  _renderMediaObject(obj, { msg, isOwn, isTopLevel = false } = {}) {
    console.log(`[renderMediaObject] type=${obj?.type} _localPath=${!!obj?._localPath} _thumbDataUrl=${!!obj?._thumbDataUrl} content=${obj?.content ? (obj.content.length + 'b') : 'none'}`);
    if (!obj?.content && !obj?._localPath && !obj?._thumbDataUrl) return '';
    // Only look up cached src — never trigger serveAttachment during render
    const urls = this._mediaObjectUrl(obj, { eager: false });
    const { src, tempPath } = urls || {};
    const onDelete = obj._localPath && msg
      ? () => this._handleDeleteStoredAttachment(obj, msg, isOwn && !isTopLevel)
      : null;
    const openLightbox = src ? () => { this._lightbox = { src, type: obj.type, name: obj.name }; } : null;
    if (obj.type === 'Image') {
      console.log(`[renderMediaObject] Image: thumbDataUrl=${!!obj._thumbDataUrl} thumbFailed=${!!obj._thumbFailed} localPath=${obj._localPath}`);
      const isGif = /\.gif$/i.test(obj.name || '') || obj.mediaType === 'image/gif';
      const GIF_INLINE_LIMIT = 2 * 1024 * 1024; // 2 MB
      if (isGif && (obj.size || 0) < GIF_INLINE_LIMIT) {
        if (src) {
          return html`
            <div class="relative inline-block mt-1 max-w-xs">
              <img src=${src} loading="lazy" class="max-w-full max-h-64 w-auto rounded-lg block cursor-zoom-in" @click=${openLightbox} alt=${obj.name || ''}>
              ${onDelete ? html`<button class="absolute top-1 right-1 btn btn-xs btn-error btn-circle opacity-70 hover:opacity-100"
                @click=${onDelete}>✕</button>` : ''}
            </div>`;
        }
        // Not served yet — placeholder that triggers serve on click
        if (obj._localPath && this._thumbObjMap) {
          this._thumbObjMap.set(obj._localPath, { obj, msg, groupId: msg?.groupId || this.selectedGroupId });
        }
        return html`
          <div class="relative inline-block mt-1">
            <div data-needs-thumb=${obj._localPath || ''} class="w-32 h-24 rounded-lg bg-base-300 flex items-center justify-center cursor-pointer"
              @click=${() => this._mediaObjectUrl(obj, { eager: true })}>
              <span class="loading loading-spinner loading-sm opacity-40"></span>
            </div>
            ${onDelete ? html`<button class="absolute top-1 right-1 btn btn-xs btn-error btn-circle opacity-70 hover:opacity-100"
              @click=${onDelete}>✕</button>` : ''}
          </div>`;
      }
      if (obj._thumbDataUrl) {
        // Thumbnail cached — show it immediately; full image only in lightbox
        return html`
          <div class="relative inline-block mt-1 max-w-[12rem]">
            <button type="button" class="block cursor-zoom-in" @click=${openLightbox || (() => this._mediaObjectUrl(obj, { eager: true, autoOpen: true }))}>
              <img data-lazy-src=${obj._thumbDataUrl} loading="lazy" decoding="async" class="max-w-full max-h-48 w-auto rounded-lg block object-contain" alt=${obj.name || ''}>
            </button>
            ${onDelete ? html`<button class="absolute top-1 right-1 btn btn-xs btn-error btn-circle opacity-70 hover:opacity-100"
              @click=${onDelete}>✕</button>` : ''}
          </div>`;
      }
      // Failed — show broken image chip instead of infinite spinner
      if (obj._thumbFailed) {
        return this._renderFileChip({ name: obj.name, size: obj.size, onClick: null, onRemove: onDelete });
      }
      // No thumbnail yet — show placeholder; IntersectionObserver will trigger serve+generate when visible
      if (obj._localPath && this._thumbObjMap) {
        this._thumbObjMap.set(obj._localPath, { obj, msg, groupId: msg?.groupId || this.selectedGroupId });
      }
      return html`
        <div class="relative inline-block mt-1">
          <div data-needs-thumb=${obj._localPath || ''} class="w-32 h-24 rounded-lg bg-base-300 flex items-center justify-center cursor-pointer"
            @click=${openLightbox || (() => this._mediaObjectUrl(obj, { eager: true, autoOpen: true }))}>
            <span class="loading loading-spinner loading-sm opacity-40"></span>
          </div>
          ${onDelete ? html`<button class="absolute top-1 right-1 btn btn-xs btn-error btn-circle opacity-70 hover:opacity-100"
            @click=${onDelete}>✕</button>` : ''}
        </div>`;
    }
    // Audio/Video: show a chip until src is ready, then show the player
    if (obj.type === 'Audio') {
      const key = obj._localPath || obj.content;
      const activated = this._audioActivated.has(key);
      if (activated && src)
        return html`<audio controls src=${src} data-autoplay class="mt-1 w-full max-w-xs block"></audio>`;
      if (activated)
        return html`<span class="loading loading-spinner loading-xs mt-1 opacity-50"></span>`;
      return html`<button type="button" class="btn btn-sm btn-circle btn-ghost mt-1" title=${obj.name || 'Play audio'}
        @click=${() => { this._audioActivated.add(key); this._mediaObjectUrl(obj, { eager: true }); this.requestUpdate(); }}>
        ${icon('play', { size: 16 })}
      </button>`;
    }
    if (obj.type === 'Video') {
      if (!src) {
        return html`<button type="button" class="btn btn-sm btn-ghost gap-1 mt-1"
          @click=${() => { this._mediaObjectUrl(obj, { eager: true, autoOpen: true }); }}>
          ${icon('film', { size: 14 })} ${obj.name || 'Video'}
        </button>`;
      }
      return html`<video controls preload="metadata" src=${src} class="mt-1 max-w-xs rounded-lg block"></video>`;
    }
    // Documents: decompress on click, then save/open
    const isPdf = /\.pdf$/i.test(obj.name || '');
    const onOpen = isPdf && src ? openLightbox : null;
    const onSave = tempPath
      ? () => this.controller?.mlsService?.saveAttachmentAs?.(tempPath, obj.name || 'file')
      : null;
    const onServeAndSave = !src && obj._localPath
      ? () => { this._mediaObjectUrl(obj, { eager: true, autoOpen: isPdf }); }
      : null;
    return this._renderFileChip({ name: obj.name, size: obj.size, onClick: onOpen || onSave || onServeAndSave, onRemove: onDelete });
  }

  _renderAttachmentPreview() {
    if (!this._pendingAttachments.length) return '';
    return html`
      <div class="flex flex-wrap gap-2 px-1 pb-1">
        ${this._pendingAttachments.map(att => {
          const secondary = att.status === 'processing'
            ? html`<span class="loading loading-dots loading-xs"></span>`
            : att.status === 'failed'
              ? html`<span class="text-error text-xs truncate max-w-[8rem]">${att.error}</span>`
              : null; // null → default size line in _renderFileChip
          return this._renderFileChip({
            name: att.name, size: att.size,
            previewUrl: att.previewUrl,
            secondary,
            onRemove: () => this._removeAttachment(att.id),
          });
        })}
      </div>
    `;
  }

  async sendMessage() {
    if (!this.input.trim() && !this._pendingAttachments.length) return;
    if (!this.selectedGroupId && !this.creatingNewGroup) return;
    if (this._recipientInput.trim()) await this._addRecipient();

    const recipients = this._resolvedRecipients.filter(r => r.resolved).map(r => r.actorUri);
    if (this.creatingNewGroup && recipients.length === 0) {
      this.error = 'Add at least one valid recipient';
      return;
    }

    this.error = '';
    this.loading = true;

    // Only send ready attachments; convert pending entries to AP attachment objects
    const readyAttachments = this._pendingAttachments.filter(a => a.status === 'ready');

    const attachments = readyAttachments.map(a => ({
      type: a.apType,
      name: a.name,
      mediaType: a.mediaType,
      encoding: 'gzip',
      content: `__pending_attachment_id:${a.id}__`,      // Rust substitutes with base64(gzip(bytes)) at encrypt time
      size: a.size,                     // uncompressed size — valid AP field, shown in UI
      _attachmentId: a.id,              // collected by chat-controller to pass to mlsService.encrypt
      _localPath: a.localPath,          // stored with message so sender can view locally via serve_attachment
      _thumbDataUrl: a.thumbDataUrl,    // thumbnail data URL stored in IndexedDB with message
    }));
    const fields = {
      name: this.name.trim(),
      summary: this.summary.trim(),
      content: this.input.trim(),
      inReplyTo: this.replyToId || undefined,
      attachments: attachments.length ? attachments : undefined,
    };

    // Clear input immediately for responsiveness
    this.input = '';
    this.name = '';
    this.summary = '';
    this._pendingAttachments = [];
    this._attachmentError = '';
    this._resolvedRecipients = [];
    this._recipientInput = '';
    this.replyToId = null;
    this.replyToSnippet = '';
    this.creatingNewGroup = false;

    // Optimistically show the message while sending
    const optimisticMsg = {
      id: `optimistic-${Date.now()}`,
      type: attachments.length ? (attachments[0].type || 'Note') : 'Note',
      content: fields.content,
      summary: fields.summary || undefined,
      attributedTo: this.currentActorId,
      timestamp: new Date().toISOString(),
      isLocal: true,
      status: 'sending',
      attachment: attachments.length ? attachments : undefined,
      groupId: this.selectedGroupId,
    };
    this.messages = [...this.messages, optimisticMsg];

    try {
      const { groupId, errors } = await this.controller.sendMessage(
        this.selectedGroupId, fields, recipients
      );
      this.selectedGroupId = groupId;
      if (errors?.length > 0) this.error = errors.join('; ');
      await this.loadMessages(groupId);
      await this.loadGroups();
    } catch (e) {
      if (e instanceof EncryptionLostError && !this.noLongerMember) {
        this.groupEncryptionLost = true;
      } else {
        this.error = typeof e === 'string' ? e : (e.message || String(e));
        console.error('[sendMessage] failed:', e);
      }
      if (this.selectedGroupId) await this.loadMessages(this.selectedGroupId);
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
      return html`<img data-lazy-src="${url}" loading="lazy" decoding="async" class="rounded-full object-cover" style="width:${px};height:${px}" alt="" />`;
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
  async _showMember(actorId, clientKey = null) {
    if (!this.selectedGroupId) return;
    this._highlightedMember = actorId;
    this._highlightedClientKey = clientKey;
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
      this._highlightedClientKey = null;
      return;
    }
    this._highlightedMember = null;
    this._highlightedClientKey = null;
    this.showMembersPanel = true;
    await this._loadMembersData();
  }

  async _loadFingerprintColors() {
    if (!this.selectedGroupId || !this.currentActorId) return;
    try {
      const members = await this.controller.getGroupMembersData(this.selectedGroupId);
      this._fingerprintColors = this._fingerprintColors || new Map();
      members.forEach(m => {
        const allEmoji = m.clients.flatMap(c => (c.fingerprint || []).map(f => f.emoji)).filter(Boolean);
        if (!allEmoji.length) return;
        let hash = 5381;
        for (const ch of `${m.clients.length}:${allEmoji.join('')}`) hash = (Math.imul(hash, 33) ^ ch.codePointAt(0)) | 0;
        this._fingerprintColors.set(m.identity, `oklch(60% 0.15 ${Math.abs(hash) % 360})`);
      });
    } catch (_) {}
  }

  async _loadMembersData() {
    if (!this.selectedGroupId || !this.currentActorId) return;
    this._membersLoading = true;
    this._groupReadReceiptsOverride = await this.controller.storage.getGroupField(this.selectedGroupId, 'readReceiptsOverride', null);
    this._loadFingerprintColors();
    try {
      const members = await this.controller.getGroupMembersData(this.selectedGroupId);
      members.forEach(m => {
        this._ensureActorProfile(m.identity);
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
    const ask = window.__TAURI__?.dialog?.ask || ((msg) => Promise.resolve(confirm(msg)));
    if (!await ask('Delete this message for everyone?', { title: 'Delete message', kind: 'warning' })) return;
    try {
      await this.controller.deleteMessage(this.selectedGroupId, msg.id);
      await this.loadMessages(this.selectedGroupId);
    } catch (e) {
      this.error = 'Failed to delete message: ' + (e.message || e);
      this.requestUpdate();
    }
  }

  /** Delete a stored attachment (array item) locally or for everyone via encrypted Update. */
  async _handleDeleteStoredAttachment(att, msg, isOwn) {
    const ask = window.__TAURI__?.dialog?.ask || ((m) => Promise.resolve(confirm(m)));
    if (!await ask('Remove this attachment from your device?', { title: 'Delete attachment', kind: 'warning' })) return;
    const forEveryone = isOwn && await ask('Also delete for everyone?', { title: 'Delete for everyone', kind: 'warning' });
    try {
      await this.controller.mlsService.backend.removeAttachment?.({ localPath: att._localPath }).catch(() => {});
      const stored = await this.controller.storage.getMessage(msg.id);
      if (stored) {
        const content = stored.content || stored;
        if (forEveryone) {
          // Remove attachment from array; send encrypted Update so peers remove it too
          content.attachment = (content.attachment || []).filter(a => a._localPath !== att._localPath);
          await this.controller.updateMessageObject(this.selectedGroupId, msg.id, content, stored.timestamp);
        } else {
          // Local only: clear _localPath/content so file is no longer referenced
          const clearLocal = (obj) => {
            if (obj?._localPath === att._localPath) { delete obj._localPath; delete obj.content; }
          };
          clearLocal(content);
          (content.attachment || []).forEach(clearLocal);
          await this.controller.storage.saveMessage(this.selectedGroupId, content, msg.id, msg.isLocal, undefined, undefined, stored.timestamp);
        }
      }
      await this.loadMessages(this.selectedGroupId);
    } catch (e) {
      this.error = 'Failed to delete attachment: ' + (e.message || e);
      this.requestUpdate();
    }
  }

  async _handleDeleteLocalMessage(msg) {
    const ask = window.__TAURI__?.dialog?.ask || ((msg) => Promise.resolve(confirm(msg)));
    if (!await ask('Remove this message from your device only? This will not affect other members.', { title: 'Remove message', kind: 'warning' })) return;
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
    // Append to document.body so position:fixed is relative to viewport, not
    // clipped by e2ee-chat-view's overflow:hidden shadow root.
    document.body.appendChild(panel);
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
          ${member.clients.map(client => {
            const isHighlighted = this._highlightedClientKey && client.signatureKey === this._highlightedClientKey;
            return html`
            <div class="flex items-center gap-2 pl-2 py-1 border-l-2 ${isHighlighted ? 'border-primary bg-primary/10 rounded' : client.isCurrentClient ? 'border-primary' : 'border-base-300'}">
              <span class="text-lg flex-1" title="Emoji fingerprint">
                ${client.fingerprint.map(e => e.emoji).join(' ')}
              </span>
              ${clientAction ? clientAction(client) : ''}
            </div>`;
          })}
          ${footer ?? ''}
        </div>
      </div>
    `;
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
    const { perActorBest } = groupDeliveryByActor(deliveryStatus);
    const entries = [...perActorBest.values()];
    if (entries.length === 0) return s();
    const anyKeysBroken = entries.some(e => e.status === 'keys_broken');
    const anyFailed = entries.some(e => e.status === 'failed');
    const allRead = entries.every(e => e.status === 'read');
    const anyRead = entries.some(e => e.status === 'read');
    const allAcked = entries.every(e => e.status === 'acknowledged' || e.status === 'read');
    const allSent = entries.every(e => e.status === 'sent');
    if (anyKeysBroken) return s('keys_broken');
    if (anyFailed) return s('failed');
    if (allRead) return s('read');
    if (anyRead) return html`<span title="Read by some">${this._deliveryStatusEmoji('read').emoji}${this._deliveryStatusEmoji('acknowledged').emoji}</span>`;
    if (allAcked) return s('acknowledged');
    if (allSent) return s('sent');
    // Mixed: some acked, some not yet
    const { emoji: ackEmoji } = this._deliveryStatusEmoji('acknowledged');
    const { emoji: sentEmoji, label } = this._deliveryStatusEmoji('sent');
    return html`<span title="Partially received — ${label}">${ackEmoji}${sentEmoji}</span>`;
  }

  _renderEmojiPicker(msgId, reactions = {}) {
    const EMOJI = ['👍', '❤️', '😂', '😮','🔥','🎉','✊','👀','👎','😢'];
    return html`
      <div class="absolute z-50 bottom-full mb-1 left-0 flex gap-0.5 p-1 rounded-xl bg-base-200 border border-base-300 shadow-lg"
        @click=${(e) => e.stopPropagation()}>
        ${EMOJI.map(e => {
          const alreadyReacted = (reactions[e] || []).includes(this.currentActorId);
          return html`<button
            class="btn btn-ghost btn-xs text-base px-1 h-7 min-h-0 hover:scale-125 transition-transform ${alreadyReacted ? 'btn-active ring-1 ring-primary' : ''}"
            title=${alreadyReacted ? 'Remove reaction' : 'React'}
            @click=${() => {
              this._emojiPickerMsgId = null;
              const action = alreadyReacted
                ? this.controller.undoLike(this.selectedGroupId, msgId, e)
                : this.controller.likeMessage(this.selectedGroupId, msgId, e);
              action.then(() => this.loadMessages(this.selectedGroupId));
            }}>${e}</button>`;
        })}
      </div>`;
  }

  _renderReactionsPanel() {
    if (!this._reactionsPanel) return '';
    const { msg } = this._reactionsPanel;
    const reactions = msg.reactions || {};
    return html`
      <div class="absolute inset-0 z-50 flex flex-col bg-base-100 text-base-content">
        <div class="flex items-center gap-2 p-3 border-b border-base-300 bg-base-200">
          <button class="btn btn-ghost btn-sm btn-square" @click=${() => { this._reactionsPanel = null; }}>
            ${icon('arrow-left', { size: 20 })}
          </button>
          <span class="font-semibold flex-1">Reactions</span>
        </div>
        <div class="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
          ${Object.entries(reactions).map(([emoji, actors]) => html`
            <div>
              <div class="text-lg mb-1">${emoji} <span class="text-sm opacity-60">${actors.length}</span></div>
              ${actors.map(actorId => html`
                <div class="flex items-center gap-2 py-1">
                  <div class="w-7 h-7 rounded-full overflow-hidden">${this._renderAvatar(actorId, { size: 28 })}</div>
                  <span class="text-sm">${this._getDisplayName(actorId)}</span>
                  ${actorId === this.currentActorId ? html`
                    <button class="btn btn-ghost btn-xs ml-auto text-error"
                      @click=${() => {
                        this._reactionsPanel = null;
                        this.controller.undoLike(this.selectedGroupId, msg.id, emoji)
                          .then(() => this.loadMessages(this.selectedGroupId));
                      }}>Remove</button>` : ''}
                </div>`)}
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
    const allEntries = Object.values(ds);
    const anyKeysBroken = allEntries.some(e => e.status === 'keys_broken');
    const allFailed = allEntries.length > 0 && allEntries.every(e => e.status === 'failed');

    const { byActor } = groupDeliveryByActor(ds);

    const statusBadge = (entry) => {
      const { emoji, label } = this._deliveryStatusEmoji(entry.status);
      const cls = entry.status === 'acknowledged' ? 'badge-success' : entry.status === 'keys_broken' ? 'badge-error' : entry.status === 'failed' ? 'badge-warning' : 'badge-ghost';
      return html`<span class="badge badge-sm ${cls}" title="${label}">${emoji} ${label}</span>`;
    };

    return html`
      <div class="absolute inset-0 z-50 flex flex-col bg-base-100 text-base-content">
        <div class="flex items-center gap-2 p-3 border-b border-base-300 bg-base-200">
          <button class="btn btn-ghost btn-sm btn-square" @click=${() => { this._deliveryPanel = null; }}>
            ${icon('arrow-left', { size: 20 })}
          </button>
          <span class="font-semibold flex-1">Delivery Status</span>
        </div>
        <div class="flex-1 overflow-y-auto p-3">
          ${[...byActor.entries()].map(([actorId, clients]) => {
            const isPerClient = clients.some(c => c.sigKey);
            return html`
              <div class="card card-bordered mb-3 bg-base-200">
                <div class="card-body p-3 gap-2">
                  <div class="flex items-center gap-2">
                    ${this._renderAvatar(actorId, { size: 24 })}
                    <div class="flex-1 min-w-0 font-semibold text-sm truncate">${this._getDisplayName(actorId)}</div>
                    ${!isPerClient ? statusBadge(clients[0].entry) : ''}
                  </div>
                  ${isPerClient ? html`
                    <div class="flex flex-col gap-1 pl-8">
                      ${clients.map(({ sigKey, entry }) => {
                        const memberClient = this._membersData
                          ?.flatMap(m => m.clients || [])
                          .find(c => c.signatureKey === sigKey);
                        const fp = memberClient?.fingerprint?.slice(0, 3).map(f => f.emoji).join('') || '?';
                        return html`
                          <div class="flex items-center gap-2 text-xs">
                            <span class="opacity-70 tracking-wide">${fp}</span>
                            ${statusBadge(entry)}
                            ${entry.status === 'failed' ? html`<button class="btn btn-xs btn-outline btn-warning" @click=${() => this.handleRetryForRecipient(msg.id, actorId)}>Retry</button>` : ''}
                            ${entry.status === 'keys_broken' ? html`<button class="btn btn-xs btn-error" @click=${() => this.handleResetEncryption()}>Reset</button>` : ''}
                          </div>`;
                      })}
                    </div>
                  ` : html`
                    ${clients[0].entry.status === 'failed' ? html`<button class="btn btn-xs btn-outline btn-warning btn-block" @click=${() => this.handleRetryForRecipient(msg.id, actorId)}>Retry</button>` : ''}
                    ${clients[0].entry.status === 'keys_broken' ? html`<button class="btn btn-xs btn-error btn-block" @click=${() => this.handleResetEncryption()}>Reset encryption</button>` : ''}
                  `}
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

            <div class="chat-image avatar cursor-pointer" @click=${(e) => { e.stopPropagation(); this._showMember(msg.attributedTo, msg._senderClientKey || null); }}>
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
    this._renderMsgCallCount = (this._renderMsgCallCount || 0) + 1;
    if (this._renderMsgCallCount > 500) {
      console.error('[renderMessage] call limit exceeded — possible infinite loop, id=', msg?.id);
      return html`<div class="alert alert-error text-xs py-1 px-2 my-1">Render loop detected</div>`;
    }

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

    if (msg && msg.status === 'sending' && !msg._sendingOverride) {
      return this.renderMessage({ ...msg, _sendingOverride: true });
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
      const announceReactions = msg.reactions || {};
      const announceReactionEntries = Object.entries(announceReactions);
      const announcePersistentFooter = (announceCollapsed || announceReactionEntries.length > 0) ? html`
        ${announceCollapsed ? html`<span class="text-xs opacity-60 cursor-pointer hover:opacity-100" @click=${() => this._toggleCollapse(msg.id)}>+${this._countDescendants(msg)} collapsed</span>` : ''}
        ${announceReactionEntries.map(([emoji, actors]) => {
          const isMine = actors.includes(this.currentActorId);
          return html`<a class="link link-hover text-sm ${isMine ? 'opacity-100' : 'opacity-60'}"
            @click=${() => { this._reactionsPanel = { msg }; }}
            title=${actors.map(id => this._getDisplayName(id)).join(', ')}
          >${emoji} ${actors.length}</a>`;
        })}
      ` : null;
      const announceFooter = html`
        ${msg.id ? html`<a class="link link-hover" @click=${() => this.handleReply(msg.id)}>reply</a>` : ''}
        <span class="relative">
          <a class="link link-hover" @click=${(e) => { e.stopPropagation(); this._emojiPickerMsgId = this._emojiPickerMsgId === msg.id ? null : msg.id; }}>😊</a>
          ${this._emojiPickerMsgId === msg.id ? this._renderEmojiPicker(msg.id, msg.reactions) : ''}
        </span>
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

    console.log(`[renderMessage] Note/default: id=${msg.id} contentLen=${msg.content?.length||0} attLen=${msg.attachment?.length||0} repliesLen=${msg.replies?.length||0}`);
    const color = this._actorColor(msg.attributedTo);
    const hasSummary = msg && msg.summary;
    const msgIndex = this.messages.findIndex(m => m.id === msg.id);
    const showContent = this[`showContent${msgIndex}`] || false;
    const isCollapsed = this._collapsedThreads.has(msg.id);
    const hasReplies = msg.replies && msg.replies.length > 0;
    const isOwnMsg = msg.isLocal || msg.attributedTo === this.currentActorId;
    const isEditing = this._editingId === msg.id;
    const isMediaType = ['Image', 'Audio', 'Video', 'Document'].includes(msg.type);

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
        ` : html`
          ${isMediaType ? (this._attachmentsReady ? this._renderMediaObject(msg, { msg, isOwn: isOwnMsg, isTopLevel: true }) : html`<div class="w-32 h-24 rounded-lg bg-base-300"></div>`) : (!hasSummary || showContent ? html`<span>${msg.content}</span>` : '')}
          ${(!isMediaType && msg.attachment?.length && this._attachmentsReady) ? html`<div class="flex flex-wrap gap-2 mt-1">${msg.attachment.map(att => this._renderMediaObject(att, { msg, isOwn: isOwnMsg }))}</div>` : ''}
        `}
      </div>
    `;

    const reactions = msg.reactions || {};
    const reactionEntries = Object.entries(reactions);
    const hasReactions = reactionEntries.length > 0;

    const persistentFooter = (isCollapsed || hasReactions) ? html`
      ${isCollapsed ? html`
        <span class="text-xs opacity-60 cursor-pointer hover:opacity-100" @click=${() => this._toggleCollapse(msg.id)}>
          +${this._countDescendants(msg)} collapsed
        </span>
      ` : ''}
      ${reactionEntries.map(([emoji, actors]) => {
        const isMine = actors.includes(this.currentActorId);
        return html`<a class="link link-hover text-sm ${isMine ? 'opacity-100' : 'opacity-60'}"
          @click=${() => { this._reactionsPanel = { msg }; }}
          title=${actors.map(id => this._getDisplayName(id)).join(', ')}
        >${emoji} ${actors.length}</a>`;
      })}
    ` : null;

    const footer = html`
      ${msg.id ? html`<a class="link link-hover" @click=${() => this.handleReply(msg.id)}>reply</a>` : ''}
      <span class="relative">
        <a class="link link-hover" @click=${(e) => { e.stopPropagation(); this._emojiPickerMsgId = this._emojiPickerMsgId === msg.id ? null : msg.id; }}>😊</a>
        ${this._emojiPickerMsgId === msg.id ? this._renderEmojiPicker(msg.id, msg.reactions) : ''}
      </span>
      <a class="link link-hover" @click=${() => { this._boostPanel = { msg }; this._boostComment = ''; this._boostTargetGroupId = this.selectedGroupId; this._boostCrossGroup = false; }}>share</a>
      ${isOwnMsg ? html`
        <a class="link link-hover" @click=${() => { this._editingId = msg.id; this._editingContent = msg.content || ''; this.requestUpdate(); }}>edit</a>
        <a class="link link-hover text-error" @click=${() => this._handleDeleteMessage(msg)}>delete</a>
        <button class="btn btn-ghost btn-xs p-0 h-auto min-h-0"
          @click=${(e) => { e.stopPropagation(); this._deliveryPanel = { msg }; this._loadMembersData(); }}>
          ${msg._sendingOverride
            ? html`<span class="loading loading-dots loading-xs opacity-50"></span>`
            : this._renderDeliveryTicks(msg.deliveryStatus)}
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
    console.log(`[render] start, ${this.messages?.length ?? 0} msgs`);
    this._renderMsgCallCount = 0;
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
            ${this._renderReactionsPanel()}
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
              ${this.controller ? (() => { const tree = this.controller.buildThreadTree(this.messages); console.log(`[render] buildThreadTree done: ${tree.length} roots`); return tree.map((msg) => { try { return html`<div class="thread-root">${this.renderMessage(msg, 0)}</div>`; } catch(e) { console.error(`[render] error rendering msg ${msg?.id}:`, e); return html`<div class="thread-root"><div class="alert alert-error text-xs py-1 px-2 my-1">Error rendering message: ${e.message}</div></div>`; } }); })() : ''}
            </div>
            ${this.selectedGroupId && this.noLongerMember ? html`
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
            ${(this.selectedGroupId || this.creatingNewGroup) && !this.groupEncryptionLost && !this.noLongerMember ? html`
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

                    ${this._resolvedRecipients.length > 0 ? html`
                      <div class="flex flex-wrap gap-1">
                        ${this._resolvedRecipients.map((r, i) => html`
                          <span class="badge gap-1 ${r.resolved && r.hasKey && !r.error ? 'badge-success' : r.resolved ? 'badge-warning' : 'badge-error'}"
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

                  </div>
                ` : ''}
                ${this.showCW ? html`
                  <input class="input input-bordered input-sm w-full" type="text" .value=${this.summary} @input=${e => this.summary = e.target.value} placeholder="CW / Summary" />
                ` : ''}
                ${this._renderAttachmentPreview()}
                <div class="flex gap-2 items-end"
                  @dragover=${e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
                  @drop=${e => { e.preventDefault(); const paths = e.dataTransfer.files; if (paths.length) Array.from(paths).forEach(f => this._addAttachment(f.path || f.name)); }}>
                  <div class="flex flex-col gap-1 flex-1">
                    <textarea class="textarea textarea-bordered w-full"
                      .value=${this.input}
                      @input=${e => { this.input = e.target.value; e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
                      placeholder="Type a message..."
                      style="resize: none; overflow-y: hidden; min-height: 2.5rem; max-height: 20rem;"
                    ></textarea>
                  </div>
                  <div class="flex flex-col gap-1">
                    <button class="btn btn-ghost btn-xs btn-square" type="button"
                      @click=${() => this._openFilePicker()}
                      title="Attach file" aria-label="Attach file">
                      ${icon('paperclip')}
                    </button>
                    <button class="btn btn-ghost btn-xs btn-square ${this.showCW ? 'btn-active' : ''}" type="button"
                      @click=${() => { this.showCW = !this.showCW; }} title="Content warning / Summary" aria-label="Toggle CW">
                      ${icon('warning')}
                    </button>
                    <button class="btn btn-primary btn-sm btn-square" type="submit" title="Send" aria-label="Send message"
                      ?disabled=${this.loading || this._pendingAttachments.some(a => a.status === 'processing' || a.status === 'failed')}>
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
                         data-role="group-item"
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
      ${this._renderLightbox()}
    ${console.log('[render] template fully built') || ''}`;
  }

  _renderLightbox() {
    if (!this._lightbox) return '';
    const { src, type, name } = this._lightbox;
    const close = () => { this._lightbox = null; };
    let media;
    if (type === 'Audio')
      media = html`<audio controls src=${src} class="w-full max-w-lg"></audio>`;
    else if (type === 'Video')
      media = html`<video controls src=${src} class="max-w-full max-h-[80vh] rounded-lg"></video>`;
    else if (type === 'Document' || (name && /\.pdf$/i.test(name)))
      media = html`<iframe src=${src} class="w-[80vw] h-[80vh] rounded-lg bg-white"></iframe>`;
    else
      media = html`<img src=${src} class="max-w-full max-h-[85vh] rounded-lg object-contain" alt=${name || ''}>`;
    return html`
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
        @click=${close}>
        <div @click=${e => e.stopPropagation()}>
          ${media}
        </div>
        <button class="absolute top-4 right-4 btn btn-circle btn-sm" @click=${close}>✕</button>
      </div>`;
  }
}

customElements.define('e2ee-chat-view', E2EEChatView)
