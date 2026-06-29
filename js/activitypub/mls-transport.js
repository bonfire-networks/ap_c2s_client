/**
 * ActivityPub + MLS transport layer.
 *
 * Formats and sends MLS-related ActivityPub activities:
 * - Encrypted messages (PrivateMessage)
 * - MLS control messages (Welcome, GroupInfo)
 * - Key package publication (Add/Update)
 *
 * No MLS crypto here — just constructs AP activities that carry MLS data.
 */

import { bytesToBase64, bytesFromInput, hasType } from '../utils.js';
import { apFetch } from './auth.js';
import { postToOutbox, fetchActorKeyPackage, resolveCollectionItems, resolveKeyPackageList, findKeyPackageUrl, extractApIdFromResponse } from './client.js';

const MLS_CONTEXTS = [
  'https://www.w3.org/ns/activitystreams',
  'https://purl.archive.org/socialweb/mls',
  // Extension terms for KP endorsement (not yet in the MLS AP spec)
  {
    'mlsSignature': 'https://purl.archive.org/socialweb/mls#Signature',
    'mlsSignerKeyId': 'https://purl.archive.org/socialweb/mls#SignerKeyId',
  }
];

// /**
//  * Send a pre-built PrivateMessage body to the actor's outbox.
//  * NOTE: sending is now done in Rust via mlsService.sendMessage — this is kept for reference/fallback.
//  * Build the body with buildPrivateMessageBody (in chat-controller.js).
//  *
//  * @param {object} actor - current actor
//  * @param {object} body - result of buildPrivateMessageBody
//  * @returns {object} response from outbox
//  */
// export async function sendEncryptedMessage(actor, body, storage) {
//   const res = await postToOutbox(actor, body, storage);
//   if (res && (res.ok === false || res.status >= 400)) {
//     throw new Error('Failed to send encrypted message: ' + (res.status || 'unknown status'));
//   }
//   return res;
// }

/**
 * Send an MLS control message (Welcome or GroupInfo).
 *
 * @param {object} actor - current actor
 * @param {string} type - 'Welcome' or 'GroupInfo'
 * @param {string} contentB64 - base64-encoded content
 * @param {string[]} recipients - recipient actor URIs
 * @param {string} contextId - AP thread/group context ID
 * @returns {object} response from outbox
 */
export async function sendMLSControl(actor, type, contentB64, recipients, contextId, storage = null, { usePrefix = false } = {}) {
  // Always include own actor so other devices receive MLS messages via own inbox
  const to = recipients.includes(actor.id) ? recipients : [...recipients, actor.id];
  const prefixedType = usePrefix ? `mls:${type}` : type;
  const controlObj = {
    '@context': MLS_CONTEXTS,
    type: prefixedType,
    attributedTo: actor.id,
    to,
    mediaType: 'message/mls',
    ...(usePrefix ? { 'mls:encoding': 'base64', 'mls:content': contentB64 } : { encoding: 'base64', content: contentB64 }),
    summary: `MLS ${type} for group ${contextId}`,
    context: contextId
  };

  const res = await postToOutbox(actor, controlObj, storage);
  if (res && (res.ok === false || res.status >= 400)) {
    throw new Error(`Failed to send MLS ${type}: ` + (res.status || 'unknown status'));
  }
  console.log(`MLS ${type} sent to`, recipients);
  return res;
}

/**
 * Publish a key package for the current actor.
 *
 * Sends Create + Add when the actor has a keyPackages collection URI (spec §2.2).
 * Falls back to Create + Update with an inline anonymous Collection when the server
 * doesn't expose a collection endpoint.
 *
 * @param {object} actor - current actor
 * @param {Uint8Array} keyPackageBytes - raw key package bytes
 * @param {string|null} mlsSignature - optional base64 MLS signature
 * @returns {boolean} true if published successfully
 */
export async function publishKeyPackage(actor, keyPackageBytes, mlsSig = null, storage = null, ciphersuite = null) {
  // mlsSig: null | string (bare signature, legacy) | { signature, signerKeyId }
  const mlsSignature = mlsSig?.signature ?? (typeof mlsSig === 'string' ? mlsSig : null);
  const mlsSignerKeyId = mlsSig?.signerKeyId ?? null;

  const kpB64 = bytesToBase64(keyPackageBytes);

  const keyPackageObj = {
    type: 'KeyPackage',
    attributedTo: actor.id,
    to: 'as:Public',
    summary: 'MLS KeyPackage',
    mediaType: 'message/mls',
    encoding: 'base64',
    content: kpB64,
    ...(ciphersuite != null ? { ciphersuite } : {}),
    generator: { type: 'Application', name: 'Bonfire MLS client' },
  };
  if (mlsSignature) keyPackageObj.mlsSignature = mlsSignature;
  if (mlsSignerKeyId) keyPackageObj.mlsSignerKeyId = mlsSignerKeyId;

  // Step 1: Create the KeyPackage object so the server assigns it an id URL
  const createRes = await postToOutbox(actor, {
    '@context': MLS_CONTEXTS,
    type: 'Create',
    actor: actor.id,
    to: 'as:Public',
    object: keyPackageObj,
  }, storage).catch(e => { console.error('[publishKeyPackage] Create failed:', e); return null; });
  if (!createRes?.ok) return false;

  const kpId = extractApIdFromResponse(createRes);
  const kpRef = kpId || keyPackageObj; // fall back to inline object if server didn't return an id

  // Step 2a: Add to collection if the actor exposes a collection URI
  const kpField = actor.keyPackages || actor["mls:keyPackages"];
  const collectionUrl = typeof kpField === 'string' ? kpField : kpField?.id;
  if (collectionUrl) {
    const addActivity = { type: 'Add', actor: actor.id, to: 'as:Public', object: kpRef, target: collectionUrl };
    if (mlsSignature) addActivity.mlsSignature = mlsSignature;
    if (mlsSignerKeyId) addActivity.mlsSignerKeyId = mlsSignerKeyId;
    const addRes = await postToOutbox(actor, addActivity, storage);
    if (addRes?.ok) return true;
    // Fall through to Update if Add failed
  }

  // Step 2b: Update the actor with an inline anonymous Collection of KP URLs
  const existingItems = kpField ? await resolveCollectionItems(kpField).catch(() => []) : [];
  const existingUrls = existingItems
    .map(item => (typeof item === 'string' ? item : item?.id))
    .filter(Boolean);
  const items = kpId ? [...existingUrls, kpId] : [...existingUrls, keyPackageObj];

  const updateRes = await postToOutbox(actor, {
    '@context': MLS_CONTEXTS,
    type: 'Update',
    actor: actor.id,
    to: 'as:Public',
    object: {
      id: actor.id,
      type: actor.type,
      keyPackages: { type: 'Collection', totalItems: items.length, items },
    }
  }, storage);

  return updateRes?.ok ?? false;
}

/**
 * Send a KeyPackage proposal to own actor inbox for approval by an existing device.
 *
 * NewDeviceB calls this to notify ExistingDeviceA about its KeyPackage.
 * The KP is sent privately (to own actor only) and NOT added to the public
 * keyPackages collection until ExistingDeviceA endorses it.
 *
 * @param {object} actor - current actor
 * @param {Uint8Array} keyPackageBytes - raw key package bytes
 * @returns {object} response from outbox
 */
export async function sendKeyPackageProposal(actor, keyPackageBytes, storage = null) {
  const kpB64 = bytesToBase64(keyPackageBytes);

  const res = await postToOutbox(actor, {
    '@context': MLS_CONTEXTS,
    type: 'Create',
    actor: actor.id,
    to: [actor.id],
    object: {
      type: 'KeyPackage',
      attributedTo: actor.id,
      mediaType: 'message/mls',
      encoding: 'base64',
      content: kpB64,
    }
  }, storage);

  if (res && (res.ok === false || res.status >= 400)) {
    throw new Error('Failed to send KeyPackage proposal: ' + (res.status || 'unknown status'));
  }
  return res;
}

/**
 * Delete (revoke) a key package from the actor's keyPackages collection.
 * Sends Remove when a collection URL exists, falls back to Update with an inline Collection.
 *
 * @param {object} actor - current actor
 * @param {Uint8Array} keyPackageBytes - raw key package bytes to remove
 * @returns {boolean} true if removed successfully
 */
export async function deleteKeyPackage(actor, keyPackageBytes, storage = null) {
  const kpB64 = bytesToBase64(keyPackageBytes);
  const kpField = actor.keyPackages || actor["mls:keyPackages"];
  const collectionUrl = typeof kpField === 'string' ? kpField : kpField?.id;

  // Find the KP object's AP ID by matching content (lazy, early-exit)
  const kpObjectUrl = kpField ? await findKeyPackageUrl(kpField, kpB64) : null;

  // Try Remove + Delete if the actor exposes a collection URL
  if (collectionUrl) {
    const removeRes = await postToOutbox(actor, {
      '@context': MLS_CONTEXTS,
      type: 'Remove',
      actor: actor.id,
      to: 'as:Public',
      object: kpObjectUrl ?? { type: 'KeyPackage', attributedTo: actor.id, mediaType: 'message/mls', encoding: 'base64', content: kpB64 },
      target: collectionUrl,
    }, storage);
    if (removeRes?.ok) {
      // Delete the object itself (spec §2.2: Remove then Delete)
      if (kpObjectUrl) {
        await postToOutbox(actor, {
          '@context': MLS_CONTEXTS,
          type: 'Delete',
          actor: actor.id,
          to: 'as:Public',
          object: kpObjectUrl,
        }, storage);
      }
      return true;
    }
    // Fall through to Update if Remove failed
  }

  // Delete the object itself if we know its URL, then Update the inline Collection
  if (kpObjectUrl) {
    await postToOutbox(actor, {
      '@context': MLS_CONTEXTS,
      type: 'Delete',
      actor: actor.id,
      to: 'as:Public',
      object: kpObjectUrl,
    }, storage);
  }

  // Update: rebuild the inline Collection minus the removed KP
  const remaining = allItems.filter(item => {
    const content = typeof item === 'string' ? null : (item?.content ?? item?.["mls:content"]);
    const id = typeof item === 'string' ? item : item?.id;
    return content !== kpB64 && id !== kpObjectUrl;
  });
  const items = remaining.map(item => (typeof item === 'string' ? item : (item?.id || item)));

  const updateRes = await postToOutbox(actor, {
    '@context': MLS_CONTEXTS,
    type: 'Update',
    actor: actor.id,
    to: 'as:Public',
    object: {
      id: actor.id,
      type: actor.type,
      keyPackages: { type: 'Collection', totalItems: items.length, items },
    }
  }, storage);

  return updateRes?.ok ?? false;
}

/**
 * Find and delete the key package for a specific device (by signatureKey) from the actor profile.
 * Scans the actor's keyPackages collection for the matching entry and sends Remove+Delete or Update.
 *
 * @param {object} actor - actor object (should be freshly fetched)
 * @param {string} signatureKey - MLS signature key of the device to remove
 * @param {object} mlsService - MLS service with getKeyPackageFingerprint
 * @param {object} storage - optional storage adapter
 */
export async function deleteKeyPackageForDevice(actor, signatureKey, mlsService, storage = null) {
  const kps = actor.keyPackages || actor["mls:keyPackages"];
  if (!kps) return;
  for (const { content } of await resolveKeyPackageList(kps).catch(() => [])) {
    try {
      const fp = await mlsService.getKeyPackageFingerprint(content);
      if (fp?.signatureKey === signatureKey) {
        await deleteKeyPackage(actor, bytesFromInput(content), storage);
        return;
      }
    } catch (e) { /* unparseable KP — skip */ }
  }
}

/**
 * Fetch the latest key package for a remote actor.
 * Returns the content as bytes, or null if not found.
 *
 * @param {string} actorUri - actor URI
 * @returns {string|null} key package content string (hex or base64)
 */
export async function fetchKeyPackage(actorUri) {
  const result = await fetchActorKeyPackage(actorUri);
  return result ? result.content : null;
}

/**
 * Parse an incoming MLS activity from the inbox.
 * Extracts type, content, context, encoding, and sender.
 *
 * @param {object} activity - raw inbox activity
 * @returns {{ type: string, content: string, context: string, encoding: string, attributedTo: string, id: string }|null}
 */
export function parseMLSActivity(activity) {
  const obj = activity && activity.object ? activity.object : activity;
  if (!obj || !obj.type) {
    console.log('[parseMLSActivity] Rejected: no obj or type', { hasObj: !!obj, type: obj?.type, activityType: activity?.type });
    return null;
  }

  const content = obj.content ?? obj["mls:content"];
  const encoding = obj.encoding ?? obj["mls:encoding"];
  const types = Array.isArray(obj.type) ? obj.type : [obj.type];
  if (!content || !encoding || encoding !== 'base64') {
    console.log('[parseMLSActivity] Rejected: missing content/encoding', { types, hasContent: !!content, encoding, id: obj.id || activity?.id });
    return null;
  }

  const contextId = obj.context ?? obj["mls:context"] ?? activity.context ?? null;

  let type;
  if (hasType(obj, 'Welcome')) type = 'Welcome';
  else if (hasType(obj, 'GroupInfo')) type = 'GroupInfo';
  else if (hasType(obj, 'PrivateMessage')) type = 'PrivateMessage';
  else if (hasType(obj, 'PublicMessage')) type = 'PublicMessage';
  else {
    console.log('[parseMLSActivity] Rejected: unknown MLS type', { types, id: obj.id || activity?.id });
    return null;
  }

  return {
    type,
    originalTypes: types, // full original type array — preserved for receipt detection in catch blocks
    content,
    context: contextId,
    encoding,
    attributedTo: obj.attributedTo,
    id: obj.id || activity.id,
    to: obj.to,
    cc: obj.cc,
    inReplyTo: obj.inReplyTo,
    name: null  // will be set from decrypted content for PrivateMessages
  };
}

