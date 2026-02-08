import {
  html,
  LitElement
} from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'

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

  constructor () {
    super()
  }

  connectedCallback () {
    super.connectedCallback()
    handleLogin({
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      successUri: this.successUri
    })
      .then(() => {
        window.location = this.redirectUri
      })
      .catch((err) => {
        this._error = err.message
      })
  }


  render () {
    return (this._error)
      ? html`<sl-alert>${this._error}</sl-alert>`
      : html`<sl-spinner style='font-size: 2rem;'></sl-spinner>`
  }
}

customElements.define('ap-save', SaveElement)
