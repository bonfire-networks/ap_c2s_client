import {
  html,
  css
} from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'

import { Element } from './element.js'
import './e2ee-chat-view.js'
import { getCurrentActor } from '../activitypub/auth.js'
import { adoptDaisyUI } from './shared-styles.js'

export class HomeElement extends Element {
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
      max-width: 75ch;
      margin: 0 auto;
      padding: 1rem;
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
    adoptDaisyUI(this)
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
    <main>
      <e2ee-chat-view redirect-uri=${this.redirectUri} client-id=${this.clientId}></e2ee-chat-view>
    </main>
    `
  }

  _menuAction(value) {
    window.location.hash = value
  }

  _logout () {
    localStorage.clear()
    if (window.__TAURI__) {
      window.__TAURI__.event.emit('app-logout')
    } else {
      window.location = this.redirectUri
    }
  }
}

customElements.define(
  'ap-home',
  HomeElement
)
