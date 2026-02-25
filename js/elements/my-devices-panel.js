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
import { adoptDaisyUI } from './shared-styles.js'

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
      _error: { type: String, state: true }
    }
  }

  constructor() {
    super()
    this.controller = null
    this.currentActorId = null
    this._devices = []
    this._loading = false
    this._error = ''
  }

  connectedCallback() {
    super.connectedCallback()
    adoptDaisyUI(this)
    this._loadDevices()
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
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" class="size-5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"/>
          </svg>
        </button>
        <span class="font-semibold flex-1">My Devices</span>
        <button class="btn btn-ghost btn-xs" @click=${() => this._loadDevices()}>
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" class="size-4">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182"/>
          </svg>
        </button>
      </div>
      <div class="flex-1 overflow-y-auto p-3">
        ${this._error ? html`<div class="alert alert-error mb-3 text-sm">${this._error}</div>` : ''}
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
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" class="size-3">
                      <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/>
                    </svg>
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
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" class="size-4">
                <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/>
              </svg>
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
