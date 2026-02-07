// ActivityPub base logic for C2S messaging, fetch, and helpers

import {
  html,
  css,
  LitElement,
  unsafeHTML
} from 'https://cdn.jsdelivr.net/gh/lit/dist@3/all/lit-all.min.js'

import * as oauth from 'https://cdn.jsdelivr.net/npm/oauth4webapi@3/+esm'

import { getCurrentActor, apFetch } from '../activitypub/auth.js'

export class Element extends LitElement {
  static get properties() {
    return {
      redirectUri: { type: String, attribute: 'redirect-uri' },
      clientId: { type: String, attribute: 'client-id' }
    }
  }

  constructor() {
    super()
  }




  async _getAllItems(arr) {
    return await Promise.all(
      arr.map((i) =>
        this.toObject(i, { required: ['id', 'type', 'published'] })
      )
    )
  }

  async * items(coll) {
    const collection = await this.toObject(coll, { noCache: true })
    if (collection.items) {
      const objects = await this._getAllItems(collection.items)
      for (const object of objects) {
        yield object
      }
    } else if (collection.orderedItems) {
      const objects = await this._getAllItems(collection.orderedItems)
      for (const object of objects) {
        yield object
      }
    } else if (collection.first) {
      let pageId = await this.toId(collection.first)
      do {
        const page = await this.toObject(pageId, { noCache: true })
        if (page.items) {
          const objects = await this._getAllItems(page.items)
          for (const object of objects) {
            yield object
          }
        } else if (page.orderedItems) {
          const objects = await this._getAllItems(page.orderedItems)
          for (const object of objects) {
            yield object
          }
        }
        pageId = await this.toId(page.next)
      } while (pageId)
    }
  }

  async toId(item) {
    return typeof item === 'string'
      ? item
      : typeof item === 'object' && item.id && typeof item.id === 'string'
        ? item.id
        : null
  }

  async toObject(item, options = { noCache: false, required: null }) {
    const { noCache, required } = options
    if (
      required &&
      typeof item === 'object' &&
      required.every((p) => p in item)
    ) {
      return item
    }
    const id = await this.toId(item)
    let json
    if (!noCache) {
      const cached = localStorage.getItem(`cache:${id}`)
      if (cached) {
        try {
          const json = JSON.parse(cached)
          return json
        } catch (err) {
          localStorage.removeItem(`cache:${id}`)
          console.error(err)
        }
      }
    }
    try {
      const res = await apFetch(id, {
        headers: {
          Accept:
            'application/activity+json,application/lrd+json,application/json'
        }
      })
      json = await res.json()
    } catch (err) {
      json =
        typeof item === 'string'
          ? { id: item }
          : typeof item === 'object' && Array.isArray(item) && item.length > 0
            ? item[0]
            : typeof item === 'object'
              ? item
              : null
    }
    if (!noCache) {
      localStorage.setItem(`cache:${id}`, JSON.stringify(json))
    }
    return json
  }

  getIcon(object) {
    return this.getUrl(object, {
      prop: 'icon',
      types: [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/svg+xml',
        'image/webp',
        'image/avif',
        'image/vnd.microsoft.icon'
      ]
    })
  }

  getUrl(object, options = { prop: 'url', types: ['text/html'] }) {
    const { prop, types } = options
    if (!object) return null
    if (!typeof object == 'object') return null
    if (!object[prop]) return null
    switch (typeof object[prop]) {
      case 'string':
        return object[prop]
      case 'object':
        if (Array.isArray(object[prop])) {
          const linkMatch = object[prop].find(
            (l) =>
              typeof l === 'object' &&
              l.type === 'Link' &&
              l.mediaType &&
              types.some((t) => l.mediaType.startsWith(t))
          )
          if (linkMatch) {
            return linkMatch.href
          } else if (object[prop].length > 0) {
            return object[prop][0].href
          } else {
            return null
          }
        } else {
          return object[prop].href
        }
        break
    }
  }

  attrEscape(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  contentEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  makeSummaryPart(object, def = '(something)') {
    const name = object ? (object.name ? object.name : def) : def
    const url = this.getUrl(object)
    return url
      ? `<a href="${this.attrEscape(url)}">${this.contentEscape(name)}</a>`
      : `${this.contentEscape(name)}`
  }

  makeSummary(activity) {
    const actorPart = this.makeSummaryPart(activity.actor, '(someone)')
    switch (activity.type) {
      case 'Arrive': {
        const placePart = this.makeSummaryPart(
          activity.location,
          '(somewhere)'
        )
        return `${actorPart} arrived at ${placePart}`
        break
      }
      case 'Leave': {
        const placePart = this.makeSummaryPart(activity.object, '(somewhere)')
        return `${actorPart} left ${placePart}`
        break
      }
      case 'Travel': {
        const targetPart = this.makeSummaryPart(activity.target, '(somewhere)')
        const originPart = this.makeSummaryPart(activity.origin, '(somewhere)')
        return `${actorPart} travelled from ${originPart} to ${targetPart}`
        break
      }
      case 'Note': {
        // Show the note content or name
        const content = activity.name || activity.summary || activity.content || '(no content)';
        return `${this.contentEscape(content)}`;
      }
      default: {
        console.log('Unknown activity type:', activity)
        return '(Unknown activity)'
      }
    }
  }
}
