import {
  html,
  css,
  LitElement
} from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'

import * as oauth from 'https://cdn.jsdelivr.net/npm/oauth4webapi@3/+esm'
import { handleLogin } from '../activitypub/auth.js'

export class SaveElement extends LitElement {
  static get properties () {
    return {
      redirectUri: { type: String, attribute: 'redirect-uri' },
      clientId: { type: String, attribute: 'client-id' },
      successUri: { type: String, attribute: 'success-uri' },
      _error: { type: String, state: true }
    }
  }

  #authorizationServer
  #client
  #clientAuth
  #state
  #codeVerifier

  constructor () {
    super()
  }

  connectedCallback () {
    super.connectedCallback()
    handleLogin.call(this)
      .then(() => {
        window.location = this.redirectUri
      })
      .catch((err) => {
        this._error = err.message
      })
  }

  clearSession () {
    localStorage.removeItem('state')
    localStorage.removeItem('code_verifier')
  }


  render () {
    return (this._error)
      ? html`<sl-alert>${this._error}</sl-alert>`
      : html`<sl-spinner style='font-size: 2rem;'></sl-spinner>`
  }
}

customElements.define('ap-save', SaveElement)
