import {
  html,
  css,
  LitElement
} from 'lit'

import { handleLogin } from '../activitypub/auth.js'
import { adoptDaisyUI } from './shared-styles.js'

export class SaveElement extends LitElement {
  static styles = css`
    :host {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
    }
  `

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
    adoptDaisyUI(this)
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
      ? html`<div class="alert alert-error max-w-sm">${this._error}</div>`
      : html`<span class="loading loading-spinner loading-lg text-primary"></span>`
  }
}

customElements.define('ap-save', SaveElement)
