/**
 * My Devices panel — cross-group own client management.
 *
 * Shows all of the current actor's MLS clients (devices) across all groups.
 * Allows decommissioning non-current devices (removes from all groups + deletes key from server).
 *
 * Usage: created programmatically from e2ee-chat-view.js _openMyDevicesPanel().
 * Set .controller and .currentActorId before appending to DOM.
 * Dispatches 'close' event when dismissed.
 */

import { html, css, LitElement } from 'lit'
import { adoptDaisyUI, icon } from './shared-styles.js'

export class MyDevicesPanel extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 60;
      display: flex;
      flex-direction: column;
    }
  `

  static get properties() {
    return {
      controller: { type: Object },
      currentActorId: { type: String },
      _devices: { type: Array, state: true },
      _loading: { type: Boolean, state: true },
      _error: { type: String, state: true },
      _sendReadReceipts: { type: Boolean, state: true },
    }
  }

  constructor() {
    super()
    this.controller = null
    this.currentActorId = null
    this._devices = []
    this._loading = false
    this._error = ''
    this._sendReadReceipts = false
  }

  connectedCallback() {
    super.connectedCallback()
    adoptDaisyUI(this)
    this._loadDevices()
    this._loadSettings()
  }

  async _loadSettings() {
    if (!this.controller || !this.currentActorId) return
    this._sendReadReceipts = await this.controller.storage.loadUserSetting(this.currentActorId, 'sendReadReceipts', false)
  }

  _emitSetting(key, value) {
    this.dispatchEvent(new CustomEvent('settings-changed', { detail: { key, value }, bubbles: true }))
  }

  async _loadDevices() {
    if (!this.controller || !this.currentActorId) return
    this._loading = true
    this._error = ''
    try {
      const groups = await this.controller.loadGroupList()

      // Collect own clients across all groups, keyed by signatureKey
      const deviceMap = new Map() // signatureKey -> { fingerprint, isCurrentClient, groupCount, groups[] }
      for (const group of groups) {
        try {
          const { found } = await this.controller.mlsService.getGroup(this.currentActorId, group.id)
          if (!found) continue
          const fingerprints = await this.controller.mlsService.getGroupFingerprints(
            this.currentActorId, group.id)
          for (const fp of fingerprints) {
            if (!fp.isOwn) continue
            const key = fp.signatureKey
            if (!deviceMap.has(key)) {
              deviceMap.set(key, {
                signatureKey: key,
                fingerprint: fp.fingerprint,
                isCurrentClient: fp.isCurrentClient,
                groupCount: 0,
                groups: []
              })
            }
            const entry = deviceMap.get(key)
            entry.groupCount++
            entry.groups.push(group.id)
            // If any group says it's current, it's current
            if (fp.isCurrentClient) entry.isCurrentClient = true
          }
        } catch (e) {
          console.warn(`[MyDevices] Skipping group ${group.id}:`, e)
        }
      }

      // Ensure the current device always appears (even with no groups)
      const ownFp = await this.controller.mlsService.getOwnFingerprint(this.currentActorId)
      if (ownFp && !deviceMap.has(ownFp.signatureKey)) {
        deviceMap.set(ownFp.signatureKey, {
          signatureKey: ownFp.signatureKey,
          fingerprint: ownFp.fingerprint,
          isCurrentClient: true,
          groupCount: 0,
          groups: []
        })
      }

      this._devices = Array.from(deviceMap.values())
    } catch (e) {
      console.error('[MyDevices] Failed to load:', e)
      this._error = e.message || String(e)
    }
    this._loading = false
  }

  async _handleDecommission(device) {
    this._loading = true
    try {
      const result = await this.controller.removeOwnClient(device.signatureKey)
      if (!result?.cancelled) await this._loadDevices()
    } catch (e) {
      this._error = 'Failed to decommission: ' + (e.message || e)
    }
    this._loading = false
  }

  async _handleClearData() {
    this._loading = true
    try {
      const cleared = await this.controller.clearAllData()
      if (cleared) {
        window.location.reload()
      }
    } catch (e) {
      this._error = 'Failed to clear data: ' + (e.message || e)
    }
    this._loading = false
  }

  _close() {
    this.dispatchEvent(new Event('close'))
  }

  render() {
    return html`
      <div class="flex flex-col h-full bg-base-100 text-base-content">
      <div class="flex items-center gap-2 p-3 border-b border-base-300 bg-base-200">
        <button class="btn btn-ghost btn-sm btn-square" @click=${() => this._close()}>
          ${icon('arrow-left', { size: 20 })}
        </button>
        <span class="font-semibold flex-1">Settings</span>
        <button class="btn btn-ghost btn-xs" @click=${() => this._loadDevices()}>
          ${icon('arrows-clockwise')}
        </button>
      </div>
      <div class="flex-1 overflow-y-auto p-3">
        ${this._error ? html`<div class="alert alert-error mb-3 text-sm">${this._error}</div>` : ''}
        <div class="mb-4 border-b border-base-300 pb-4">
          <h3 class="text-sm font-semibold opacity-60 mb-2 uppercase tracking-wide">Privacy</h3>
          <label class="flex items-center gap-3 cursor-pointer">
            <div class="flex-1">
              <div class="text-sm font-medium">Send read receipts</div>
              <div class="text-xs opacity-50">Let others know when you've read their messages</div>
            </div>
            <input type="checkbox" class="toggle toggle-sm toggle-primary" .checked=${this._sendReadReceipts}
              @change=${async (e) => {
                this._sendReadReceipts = e.target.checked
                await this.controller.storage.saveUserSetting(this.currentActorId, 'sendReadReceipts', e.target.checked)
                this._emitSetting('sendReadReceipts', e.target.checked)
              }}>
          </label>
        </div>
        <h3 class="text-sm font-semibold opacity-60 mb-2 uppercase tracking-wide">My Devices</h3>
        ${this._loading ? html`
          <div class="flex justify-center py-8"><span class="loading loading-spinner"></span></div>
        ` : this._devices.length === 0 ? html`
          <div class="text-center opacity-60 py-8">No devices found</div>
        ` : this._devices.map(device => html`
          <div class="card card-bordered mb-3 ${device.isCurrentClient ? 'border-primary bg-primary/5' : 'bg-base-200'}">
            <div class="card-body p-3 gap-2">
              <div class="flex items-center gap-2">
                <span class="text-lg flex-1" title="Emoji fingerprint">
                  ${device.fingerprint.map(e => e.emoji).join(' ')}
                </span>
                ${device.isCurrentClient ? html`
                  <span class="badge badge-sm badge-primary gap-1">
                    ${icon('check', { size: 12 })}
                    this device
                  </span>
                ` : ''}
              </div>
              <div class="text-sm opacity-60">
                in ${device.groupCount} group${device.groupCount !== 1 ? 's' : ''}
              </div>
              ${!device.isCurrentClient ? html`
                <button class="btn btn-error btn-outline btn-sm btn-block mt-1"
                  @click=${() => this._handleDecommission(device)}
                  ?disabled=${this._loading}>
                  Remove device
                </button>
              ` : ''}
            </div>
          </div>
        `)}
        <details class="mt-4 border-t border-base-300 pt-3">
          <summary class="text-sm cursor-pointer select-none">Advanced</summary>
          <div class="mt-2">
            <button class="btn btn-error btn-outline btn-sm btn-block"
              @click=${() => this._handleClearData()}
              ?disabled=${this._loading}>
              ${icon('trash')}
              Delete this device and local data
            </button>
            <p class="text-xs opacity-50 mt-1">Deletes identity, keys, and message history. You will need to log in again.</p>
          </div>
        </details>
      </div>
      </div>
    `
  }
}

customElements.define('my-devices-panel', MyDevicesPanel)
