import {
  html,
  css,
  LitElement
} from 'https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js'

import { adoptDaisyUI } from './shared-styles.js'

const THEMES = [
  'default', 'light', 'dark', 'cupcake', 'bumblebee', 'emerald', 'corporate',
  'synthwave', 'retro', 'cyberpunk', 'valentine', 'halloween', 'garden',
  'forest', 'aqua', 'lofi', 'pastel', 'fantasy', 'wireframe', 'black',
  'luxury', 'dracula', 'cmyk', 'autumn', 'business', 'acid', 'lemonade',
  'night', 'coffee', 'winter', 'dim', 'nord', 'sunset', 'caramellatte',
  'abyss', 'silk'
]

export class ThemePicker extends LitElement {
  static styles = css`
    :host { display: contents; }
  `

  static get properties () {
    return {
      _current: { type: String, state: true }
    }
  }

  constructor () {
    super()
    this._current = localStorage.getItem('theme') || 'default'
  }

  connectedCallback () {
    super.connectedCallback()
    adoptDaisyUI(this)
    this._applyTheme(this._current)
  }

  _applyTheme (theme) {
    this._current = theme
    const value = theme === 'default' ? '' : theme
    // Set on document root so all components (shadow DOM and light DOM) pick it up
    document.documentElement.setAttribute('data-theme', value)
    localStorage.setItem('theme', theme)
  }

  render () {
    return html`
      
        <details>
          <summary>Theme</summary>
          <ul>
            ${THEMES.map(t => html`
              <li><a class="${this._current === t ? 'active' : ''}" @click=${() => this._applyTheme(t)}>${t}</a></li>
            `)}
          </ul>
        </details>
      
    `
  }
}

customElements.define('theme-picker', ThemePicker)
