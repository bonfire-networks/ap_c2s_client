import {
  html,
  css,
  LitElement
} from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'

import {
  startLogin,
  WEBFINGER_REGEXP
} from '../activitypub/auth.js'

import { adoptDaisyUI } from './shared-styles.js'

export class LoginElement extends LitElement {

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      height: 100vh;
      padding: 1rem;
    }
  `

  static get properties () {
    return {
      redirectUri: { type: String, attribute: 'redirect-uri' },
      clientId: { type: String, attribute: 'client-id' },
      _webfinger: { type: String, state: true },
      _error: { type: String, state: true }
    }
  }

  constructor () {
    super()
  }

  connectedCallback() {
    super.connectedCallback()
    adoptDaisyUI(this)

    const webfinger = this._webfinger_url();
    if (this.isWebfinger(webfinger)) {
      this._login(webfinger)
    }
  }

  render() {
    return html`
      <p style="max-width: 30ch; text-align: center; margin-bottom: 1.5rem; font-size: 1.1rem; opacity: 0.8;">
        Welcome! This is an <a class="link link-primary" href="https://activitypub.rocks/">ActivityPub</a>
        geosocial Web application. To log in, you need to have an account on a compatible server.
      </p>
      <div class="join">
        <input
          class="input input-bordered join-item"
          id="webfinger"
          placeholder="username@example.com"
          @input=${this._input}
          .value=${this._webfinger || ''}
        />
        <button
          class="btn btn-primary join-item"
          ?disabled=${!this.isWebfinger(this._webfinger)}
          @click=${() => this._login()}
        >Log In</button>
      </div>
      ${this._error ? html`<div class="alert alert-error mt-4" style="max-width: 24rem;">${this._error}</div>` : html``}
    `
  }

  _webfinger_url() {
    const actor_id = localStorage.getItem('actor_id')
    if (actor_id) {
      this._webfinger = actor_id
    }

    const previousUrl = localStorage.getItem('appUsername') || localStorage.getItem('appUrl')
    console.log('[login] Previous from localStorage:', previousUrl);
    if (previousUrl) {
      this._webfinger = previousUrl
    }

    return this._webfinger
  }

  _input (e) {
    this._webfinger = e.target.value
    this._error = null
  }

  isWebfinger (str) {
    return WEBFINGER_REGEXP.test(str)
  }

  async _login(webfinger = null) {
    let id = (webfinger || this._webfinger || '')
    if (typeof id !== 'string' || !id.trim()) {
      console.warn('[login] No webfinger ID provided', id);
      this._error = 'Please enter your instance domain or @user@domain.tld'
      return
    }
    try {
      const url = await startLogin(id, this.clientId, this.redirectUri)
      console.log('[login] Redirecting to OAuth authorize:', url);
      window.location.href = url
    } catch (error) {
      console.error('[login] Error during login:', error, error?.stack ? '\n' + error.stack : '')
      this._error = error.message || 'Unknown error during login.'
    }
  }
}

customElements.define('ap-login', LoginElement)
