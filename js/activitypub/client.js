/**
 * ActivityPub C2S client operations.
 *
 * Generic AP helpers: fetch actors, iterate collections,
 * post to outbox, resolve webfinger mentions.
 */

import { apFetch, getActorId, getActor } from './auth.js';
import { mlsCiphersuiteIdFromName } from '../utils.js';

/**
 * Post an activity to the actor's outbox.
 * Wraps the object with @context and sends via authenticated fetch.
 *
 * @param {object} actor - current actor (must have .outbox)
 * @param {object} obj - activity/object to post
 * @returns {object} response data with status, ok, and parsed body
 */
export async function postToOutbox(actor, obj, storage = null) {
  const outbox = actor.outbox;
  const bodyObj = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    ...obj
  };
  console.log('[postToOutbox] URL:', outbox, 'type:', bodyObj.type, 'to:', bodyObj.to);

  const res = await apFetch(outbox, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/activity+json'
    },
    body: JSON.stringify(bodyObj)
  });

  let data = {
    status: res.status,
    ok: res.ok
  };

  const contentType = res.headers && res.headers.get ? res.headers.get('content-type') : '';
  try {
    if (contentType && contentType.includes('application/json')) {
      const json = await res.json();
      data = { ...data, ...json };
    } else {
      const text = await res.text();
      data.body = text;
      if (text.includes('<!DOCTYPE') || text.includes('<html')) {
        data.error = `Server returned HTML error (status ${res.status})`;
      } else {
        data.error = text;
      }
    }
  } catch (e) {
    data.error = `Failed to parse response: ${e.message}`;
  }

  console.log('[postToOutbox] Response:', data.status, data.ok ? 'OK' : 'FAIL', data.id || data.error || '');

  if (storage && data.id) {
    await storage.markProcessed(actor.id, data.id);
  }

  return data;
}

/**
 * Fetch an object by URL. If it's already a resolved object with the
 * required properties, returns it as-is. Supports caching via localStorage.
 *
 * @param {string|object} item - URL string or object reference
 * @param {object} [options]
 * @param {boolean} [options.noCache] - skip cache
 * @param {string[]} [options.required] - required properties (skip fetch if present)
 * @returns {object} the resolved object
 */
export async function fetchObject(item, options = {}) {
  const { noCache, required } = options;

  if (required && typeof item === 'object' && required.every(p => p in item)) {
    return item;
  }

  const id = resolveId(item);
  if (!id) return item;

  if (!noCache) {
    const cached = localStorage.getItem(`cache:${id}`);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        localStorage.removeItem(`cache:${id}`);
      }
    }
  }

  let json;
  try {
    json = await apFetchJson(id);
  } catch {
    json = typeof item === 'string'
      ? { id: item }
      : typeof item === 'object' && Array.isArray(item) && item.length > 0
        ? item[0]
        : typeof item === 'object'
          ? item
          : null;
  }

  if (!noCache && json) {
    localStorage.setItem(`cache:${id}`, JSON.stringify(json));
  }
  return json;
}

/**
 * Extract the ID string from an item (string URL or object with .id).
 */
export function resolveId(item) {
  if (typeof item === 'string') return item;
  if (typeof item === 'object' && item && item.id && typeof item.id === 'string') return item.id;
  return null;
}

/**
 * Async generator that iterates items in an AP collection (handles pagination).
 *
 * @param {string|object} coll - collection URL or object
 * @yields {object} each item in the collection (fully resolved)
 */
export async function* iterateCollection(coll) {
  const collection = await fetchObject(coll, { noCache: true });

  async function resolveAll(arr) {
    return Promise.all(
      arr.map(i => fetchObject(i, { required: ['id', 'type', 'published'] }))
    );
  }

  if (collection.items) {
    for (const obj of await resolveAll(collection.items)) yield obj;
  } else if (collection.orderedItems) {
    for (const obj of await resolveAll(collection.orderedItems)) yield obj;
  } else if (collection.first) {
    let pageId = resolveId(collection.first);
    do {
      const page = await fetchObject(pageId, { noCache: true });
      const items = page.items || page.orderedItems || [];
      for (const obj of await resolveAll(items)) yield obj;
      pageId = resolveId(page.next);
    } while (pageId);
  }
}

/**
 * Resolve a webfinger mention (user@domain or @user@domain) to an actor URI.
 * If the input is already a URL, returns it as-is.
 *
 * @param {string} input - webfinger mention or URL
 * @param {string} [defaultDomain] - domain to assume if none provided
 * @returns {string|null} actor URI, or null on failure
 */
export async function resolveActorId(input, defaultDomain) {
  if (/^https?:\/\//.test(input)) return input;

  let mention = input.replace(/^@/, '');
  if (!mention.includes('@') && defaultDomain) {
    mention = `${mention}@${defaultDomain}`;
  }

  try {
    return await getActorId(mention);
  } catch {
    return null;
  }
}

/**
 * Resolve an AP Collection/OrderedCollection (or URL, or inline array) to a flat item array.
 * Follows one level of pagination via `first` if no inline items are present.
 */
async function apFetchJson(url) {
  const origin_url = localStorage.getItem('actor_id') || localStorage.getItem('appUrl');
  const isSameOrigin = origin_url && new URL(url).origin === new URL(origin_url).origin;
  const res = isSameOrigin
    ? await apFetch(url, { headers: { Accept: 'application/activity+json' } })
    : await fetch(url, { cache: 'no-store', headers: { Accept: 'application/activity+json' } });
  return res.ok ? res.json() : null;
}

async function resolveCollectionItems(val) {
  if (typeof val === 'string') {
    val = await apFetchJson(val);
    if (!val) return [];
  }
  if (Array.isArray(val)) return val;
  if (Array.isArray(val?.orderedItems)) return val.orderedItems;
  if (Array.isArray(val?.items)) return val.items;
  // Collection with a `first` page link — follow it (first page only; keyPackages collections are small)
  const pageUrl = typeof val?.first === 'string' ? val.first : val?.first?.id;
  if (pageUrl) {
    const page = await apFetchJson(pageUrl);
    if (page) return page.orderedItems ?? page.items ?? [];
  }
  return [];
}

/**
 * Resolve an actor's keyPackages field to an array of KP objects (each with .content).
 */
async function resolveKeyPackageList(kp) {
  const items = await resolveCollectionItems(kp);
  const results = [];
  for (const item of items) {
    let obj = item;
    if (typeof obj === 'string') {
      obj = await apFetchJson(obj);
      if (!obj) continue;
    }
    const content = obj?.content ?? obj?.["mls:content"];
    if (content) results.push({ ...obj, content });
  }
  return results;
}

/**
 * Extract key package content from an actor's keyPackages field (first KP only).
 *
 * @param {*} kp - keyPackages field value from actor object
 * @returns {string|null}
 */
export async function extractKeyPackageContent(kp) {
  const items = await resolveKeyPackageList(kp);
  return items[0]?.content ?? null;
}

/**
 * Fetch the latest published key package for an actor.
 *
 * @param {string} actorUri
 * @returns {{ content: string, actor: object }|null}
 */
/**
 * Find a KP object's AP ID within a keyPackages collection field by matching content (base64).
 * Expands URL-string items lazily and exits on first match — avoids fetching all items.
 *
 * @param {*} kpField - keyPackages field value from actor object
 * @param {string} kpB64 - base64 content to match
 * @returns {string|null} AP ID of the matching KP object, or null if not found
 */
export async function findKeyPackageUrl(kpField, kpB64) {
  const items = await resolveCollectionItems(kpField).catch(() => []);
  for (const item of items) {
    if (typeof item === 'string') {
      const obj = await apFetchJson(item).catch(() => null);
      const content = obj?.content ?? obj?.['mls:content'];
      if (content === kpB64) return item;
    } else {
      const content = item?.content ?? item?.['mls:content'];
      if (content === kpB64) return item?.id ?? null;
    }
  }
  return null;
}

export { resolveCollectionItems, resolveKeyPackageList };

/**
 * Iterate an actor's published keyPackages, calling predicate(signatureKey) for each parseable entry.
 * Returns true on first match.
 *
 * @param {object} actor - actor object with keyPackages field
 * @param {object} mlsService - MLS service with getKeyPackageFingerprint
 * @param {function} predicate - (signatureKey: string) => boolean
 */
export async function forEachPublishedKeyPackage(actor, mlsService, predicate) {
  const kps = actor.keyPackages || actor["mls:keyPackages"];
  if (!kps) return false;
  for (const { content } of await resolveKeyPackageList(kps).catch(() => [])) {
    try {
      const fp = await mlsService.getKeyPackageFingerprint(content);
      if (fp?.signatureKey && predicate(fp.signatureKey)) return true;
    } catch (e) { /* unparseable KP — skip */ }
  }
  return false;
}

export async function fetchActorKeyPackage(actorUri) {
  const actor = await getActor(actorUri);
  const kp = actor.keyPackages || actor["mls:keyPackages"];
  console.log(`mls:keyPackages`, kp)
  if (!kp) return null;
  const content = await extractKeyPackageContent(kp);
  return content ? { content, actor } : null;
}

/**
 * Fetch ALL published key packages for an actor (one per device).
 *
 * @param {string} actorUri
 * @returns {{ content: string, actor: object }[]}
 */
export async function fetchAllActorKeyPackages(actorUri) {
  const actor = await getActor(actorUri);
  const kp = actor.keyPackages || actor["mls:keyPackages"];
  if (!kp) return [];
  const items = await resolveKeyPackageList(kp);
  return items.map(kp => {
    const cs = kp.ciphersuite;
    const ciphersuite = typeof cs === 'string'
      ? (() => { const id = mlsCiphersuiteIdFromName(cs); return id != null ? { identifier: id, name: cs } : null; })()
      : (cs ?? null);
    return { content: kp.content, ciphersuite, mlsSignature: kp.mlsSignature ?? null, mlsSignerKeyId: kp.mlsSignerKeyId ?? null, actor };
  });
}

/**
 * Fetch inbox items for an actor.
 * Returns the raw items array (orderedItems or items) from the inbox.
 *
 * @param {object} actor - actor object with .inbox
 * @returns {Array} inbox items
 */
export async function fetchInboxItems(actor) {
  const inboxUrl = typeof actor.inbox === 'string' ? actor.inbox : actor.inbox.id;
  const res = await apFetch(inboxUrl, { headers: { Accept: 'application/activity+json' } });
  if (!res.ok) {
    console.warn('[AP Client] Failed to fetch inbox, status:', res.status);
    return [];
  }

  const inbox = await res.json();
  console.log('[fetchInboxItems] Raw response keys:', Object.keys(inbox), 'totalItems:', inbox.totalItems, 'type:', inbox.type);
  let items = [];

  // Check for direct items in response
  if (inbox.orderedItems && Array.isArray(inbox.orderedItems)) {
    items = inbox.orderedItems;
  } else if (inbox.items && Array.isArray(inbox.items)) {
    items = inbox.items;
  }

  // If still no items and there's a first page
  if (items.length === 0 && inbox.first) {
    if (typeof inbox.first === 'object' && (inbox.first.orderedItems || inbox.first.items)) {
      items = inbox.first.orderedItems || inbox.first.items;
    } else {
      const firstPageUrl = typeof inbox.first === 'string' ? inbox.first : inbox.first.id;
      if (firstPageUrl) {
        try {
          const pageRes = await apFetch(firstPageUrl, { headers: { Accept: 'application/activity+json' } });
          if (pageRes.ok) {
            const page = await pageRes.json();
            items = page.orderedItems || page.items || [];
          }
        } catch (e) {
          console.error('[AP Client] Error fetching first page:', e);
        }
      }
    }
  }

  console.log('[fetchInboxItems] Total items:', items.length,
    items.length > 0 ? 'First item type:' : '',
    items.length > 0 ? (items[0]?.type || items[0]?.object?.type || 'unknown') : '');
  return items;
}

/**
 * Extract the AP ID from a postToOutbox response.
 * Handles various server response formats.
 *
 * @param {object} res - response from postToOutbox
 * @returns {string|null} AP object ID
 */
export function extractApIdFromResponse(res) {
  if (!res) return null;

  // Case 1: Full activity with embedded object
  if (res.object && typeof res.object === 'object' && res.object.id) {
    return res.object.id;
  }
  // Case 2: Activity with object URI string
  if (res.object && typeof res.object === 'string') {
    return res.object;
  }
  // Case 3: Activity ID (need to fetch to get object ID)
  if (res.id) {
    return res.id;
  }
  return null;
}
