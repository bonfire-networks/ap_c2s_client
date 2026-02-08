import {
  html,
  css,
  LitElement
} from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'

import {
  startLogin,
  WEBFINGER_REGEXP
} from '../activitypub/auth.js'

export class LoginElement extends LitElement {


  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      height: 100vh;
      padding: 1rem;
      box-sizing: border-box;
      background: var(--bg-main, #fafafa);
    }
    .intro {
      font-size: 1.25rem;
      text-align: center;
      margin-bottom: 1.5rem;
      max-width: 30ch;
    }
    .login-form {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    sl-input {
      flex: 1;
      --sl-input-width: 15rem;
    }
    sl-button {
      white-space: nowrap;
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

    const webfinger = this._webfinger_url();
    if (this.isWebfinger(webfinger)) {
      // login immediately if we already have a valid webfinger ID (e.g. from previous session)
      this._login(webfinger)
    }

    super.connectedCallback()
  }

  render() {

    return html`
      <h1></h1>
      <p class="intro">
        Welcome! This is an <a href="https://activitypub.rocks/">ActivityPub</a>
        geosocial Web application. To log in, you need to have an account on a
        compatible server.
      </p>
      <div class="login-form">
        <sl-input
          id="webfinger"
          placeholder="username@example.com"
          @input=${this._input}
          value=${ this._webfinger }
        ></sl-input>
        <sl-button
          variant="primary"
          ?disabled=${!this.isWebfinger(this._webfinger)}
          @click=${() => this._login()}
        >
          Log In
        </sl-button>
        ${this._error ? html`<sl-alert>${this._error}</sl-alert>` : html``}
      </div>
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
