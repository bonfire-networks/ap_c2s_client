import {
  html,
  css,
  LitElement
} from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'

import * as oauth from 'https://cdn.jsdelivr.net/npm/oauth4webapi@3/+esm'
import {
  getActorId,
  getActor,
  // getCurrentActor,
  getAuthorizationEndpoint,
  getTokenEndpoint,
  getProxyUrl,
  buildAuthorizationUrl
} from './activitypub/auth.js'

export class CheckinLoginElement extends LitElement {


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

  connectedCallback () {
    super.connectedCallback()
  }

  render () {
    return html`
      <h1>Checkin</h1>
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
        ></sl-input>
        <sl-button
          variant="primary"
          ?disabled=${!this.isWebfinger(this._webfinger)}
          @click=${this._login}
        >
          Log In
        </sl-button>
        ${this._error ? html`<sl-alert>${this._error}</sl-alert>` : html``}
      </div>
    `
  }

  _input (e) {
    this._webfinger = e.target.value
    this._error = null
  }

  isWebfinger (str) {
    // Use the same regexp as in login.js
    return getActorId.WEBFINGER_REGEXP
      ? getActorId.WEBFINGER_REGEXP.test(str)
      : /^(?:acct:)?[^@]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/.test(str)
  }


  async _login () {
    const webfingerInput = this.shadowRoot.querySelector('#webfinger')
    const id = webfingerInput.value.trim()
    if (!id) {
      this._error = 'Please enter your Webfinger ID.'
      return
    }
    try {
      const actorId = await getActorId(id)
      localStorage.setItem('actor_id', actorId)
      const actor = await getActor(actorId)
      const tokenUrl = getTokenEndpoint(actor)
      if (!tokenUrl) throw new Error('No OAuth token endpoint.')
      localStorage.setItem('token_endpoint', tokenUrl)
      const proxyUrl = getProxyUrl(actor)
      if (!proxyUrl) throw new Error('No Proxy endpoint.')
      localStorage.setItem('proxy_url', proxyUrl)
      const authorizationUrl = getAuthorizationEndpoint(actor)
      if (!authorizationUrl) throw new Error('No OAuth authorization endpoint.')
      localStorage.setItem('authorization_endpoint', authorizationUrl)

      if (!window.crypto || !window.crypto.subtle) {
        throw new Error('Your browser does not support secure cryptography (crypto.subtle is missing).\n\nPlease use a modern browser, avoid private/incognito mode, and ensure you are on HTTPS or localhost.')
      }

      const code_verifier = oauth.generateRandomCodeVerifier()
      const code_challenge = await oauth.calculatePKCECodeChallenge(code_verifier)
      const state = crypto.randomUUID()

      sessionStorage.setItem('code_verifier', code_verifier)
      sessionStorage.setItem('state', state)

      const url = buildAuthorizationUrl({
        authorizationUrl,
        clientId: this.clientId,
        redirectUri: this.redirectUri,
        codeChallenge: code_challenge,
        state
      })
      console.log('[checkin-login] Redirecting to OAuth authorize:', {
        clientId: this.clientId,
        redirectUri: this.redirectUri,
        authorizationUrl,
        tokenUrl,
        proxyUrl,
        code_verifier,
        code_challenge,
        state,
        url
      });
      window.location.href = url
    } catch (error) {
      console.error('[checkin-login] Error during login:', error, error && error.stack ? '\n' + error.stack : '')
      if (error && error.message && error.message.includes('crypto.subtle')) {
        this._error = 'Your browser does not support secure cryptography required for login.\nPlease use a modern browser, avoid private/incognito mode, and ensure you are on HTTPS or localhost.'
      } else {
        this._error = error.message || 'Unknown error during login.'
      }
    }
  }
}

customElements.define('checkin-login', CheckinLoginElement)
