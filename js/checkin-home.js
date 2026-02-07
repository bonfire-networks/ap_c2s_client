import {
  html,
  css,
  LitElement
} from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'

import { CheckinElement } from './checkin-element.js'
import { E2EEChatView } from './e2ee-chat-view.js'
import { getCurrentActor } from './activitypub/auth.js'

export class CheckinHomeElement extends CheckinElement {
  static styles = css`
    :host {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 100vh;
    }

    header,
    main,
    footer {
      width: 100%;
      max-width: var(--max-width);
      margin: 0 auto;
      padding: var(--gap);
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
  `

  static get properties () {
    return {
      redirectUri: { type: String, attribute: 'redirect-uri' },
      clientId: { type: String, attribute: 'client-id' },
      _route: { type: String, state: true },
      _error: { type: String, state: true },
      _actor: { type: Object, state: true }
    }
  }

  constructor () {
    super()
    this._route = 'inbox'
  }

  connectedCallback () {
    super.connectedCallback()
    // Store clientId in localStorage so ensureFreshToken can use it for token refresh
    if (this.clientId) {
      localStorage.setItem('client_id', this.clientId)
    }
    // Listen for auth errors and prompt re-login
    window.addEventListener('auth-error', (e) => {
      console.warn('[Auth] Re-login required:', e.detail?.reason)
      this._error = e.detail?.reason || 'Session expired'
      this._logout()
    })
    getCurrentActor()
      .then((actor) => {
        this._actor = actor
      })
      .catch((err) => {
        this._error = err.message
      })
    window.addEventListener('popstate', () => {
      const route = (window.location.hash)
        ? window.location.hash.replace('#', '')
        : 'inbox'
      if (route === 'logout') {
        this._logout()
      } else {
        this._route = route
      }
    })
  }

  render () {
    return html`

    <header>

      <span class="brand"><a href="#">Messages</a></span>


      <!-- User menu dropdown -->
      <sl-dropdown>
        <sl-button slot="trigger" caret>${(this._actor) ? this._actor.name : 'User'}</sl-button>
        <sl-menu @sl-select=${this._menuSelect.bind(this)}>
          <sl-menu-item value="settings">
            <sl-icon slot="prefix" name="gear"></sl-icon>
            Settings
          </sl-menu-item>
          <sl-menu-item value="logout">
            <sl-icon slot="prefix" name="box-arrow-left"></sl-icon>
            Log out
          </sl-menu-item>
        </sl-menu>
      </sl-dropdown>
    </header>

    <main>
    <e2ee-chat-view redirect-uri=${this.redirectUri} client-id=${this.clientId} />
    </main>

    <footer>
      <a href="https://github.com/bonfire-networks/ap_c2s_client">Code</a>
    </footer>
    `
  }

  _menuSelect (event) {
    const value = event.detail.item.value
    window.location.hash = value
  }

  _logout () {
    localStorage.clear()
    window.location = this.redirectUri
  }
}

customElements.define(
  'checkin-home',
  CheckinHomeElement
)
