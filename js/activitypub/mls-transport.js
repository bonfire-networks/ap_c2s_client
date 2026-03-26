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

import { bytesToBase64 } from '../utils.js';
import { postToOutbox, fetchActorKeyPackage } from './client.js';

const MLS_CONTEXTS = [
  'https://www.w3.org/ns/activitystreams',
  'https://purl.archive.org/socialweb/mls'
];

/**
 * Send a pre-built PrivateMessage body to the actor's outbox.
 * NOTE: sending is now done in Rust via mlsService.sendMessage — this is kept for reference/fallback.
 * Build the body with buildPrivateMessageBody (in chat-controller.js).
 *
 * @param {object} actor - current actor
 * @param {object} body - result of buildPrivateMessageBody
 * @returns {object} response from outbox
 */
export async function sendEncryptedMessage(actor, body) {
  const res = await postToOutbox(actor, body);
  if (res && (res.ok === false || res.status >= 400)) {
    throw new Error('Failed to send encrypted message: ' + (res.status || 'unknown status'));
  }
  return res;
}

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
export async function sendMLSControl(actor, type, contentB64, recipients, contextId) {
  const controlObj = {
    '@context': MLS_CONTEXTS,
    type,
    attributedTo: actor.id,
    to: recipients,
    mediaType: 'message/mls',
    encoding: 'base64',
    content: contentB64,
    summary: `MLS ${type} for group ${contextId}`,
    context: contextId
  };

  const res = await postToOutbox(actor, controlObj);
  if (res && (res.ok === false || res.status >= 400)) {
    throw new Error(`Failed to send MLS ${type}: ` + (res.status || 'unknown status'));
  }
  console.log(`MLS ${type} sent to`, recipients);
  return res;
}

/**
 * Publish a key package for the current actor.
 *
 * If the actor has an existing keyPackages collection, sends an Add activity.
 * Otherwise, sends an Update to the actor with the key package.
 *
 * @param {object} actor - current actor
 * @param {Uint8Array} keyPackageBytes - raw key package bytes
 * @returns {boolean} true if published successfully
 */
export async function publishKeyPackage(actor, keyPackageBytes) {
  const kpB64 = bytesToBase64(keyPackageBytes);

  const keyPackageObj = {
    '@context': MLS_CONTEXTS,
    type: 'KeyPackage',
    attributedTo: actor.id,
    to: 'as:Public',
    summary: 'MLS KeyPackage',
    mediaType: 'message/mls',
    encoding: 'base64',
    content: kpB64,
    generator: {
      type: 'Application',
      name: 'Bonfire MLS client'
    }
  };

  const keyPackages = actor.keyPackages;
  const target = keyPackages ? (typeof keyPackages === 'string' ? keyPackages : keyPackages.id) : null;

  let res;
  if (target) {
    res = await postToOutbox(actor, {
      type: 'Add',
      actor: actor.id,
      to: 'as:Public',
      object: keyPackageObj,
      target
    });
  } else {
    res = await postToOutbox(actor, {
      type: 'Update',
      actor: actor.id,
      to: 'as:Public',
      object: {
        id: actor.id,
        type: actor.type,
        keyPackages: [keyPackageObj]
      }
    });
  }

  return res && res.ok;
}

/**
 * Delete (revoke) a key package from the actor's keyPackages collection.
 * Sends an AP Remove activity when a collection exists, or an Update with empty keyPackages when it doesn't (like in publishKeyPackage).
 *
 * @param {object} actor - current actor
 * @param {Uint8Array} keyPackageBytes - raw key package bytes to remove
 * @returns {boolean} true if removed successfully
 */
export async function deleteKeyPackage(actor, keyPackageBytes) {
  const kpB64 = bytesToBase64(keyPackageBytes);

  const keyPackages = actor.keyPackages;
  const target = keyPackages ? (typeof keyPackages === 'string' ? keyPackages : keyPackages.id) : null;

  let res;
  if (target) {
    res = await postToOutbox(actor, {
      type: 'Remove',
      actor: actor.id,
      object: {
        type: 'KeyPackage',
        attributedTo: actor.id,
        mediaType: 'message/mls',
        encoding: 'base64',
        content: kpB64,
      },
      target,
    });
  } else {
    res = await postToOutbox(actor, {
      type: 'Update',
      actor: actor.id,
      to: 'as:Public',
      object: {
        id: actor.id,
        type: actor.type,
        keyPackages: []
      }
    });
  }

  return res && res.ok;
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

  const types = Array.isArray(obj.type) ? obj.type : [obj.type];

  if (!obj.content || !obj.encoding || obj.encoding !== 'base64') {
    console.log('[parseMLSActivity] Rejected: missing content/encoding', { types, hasContent: !!obj.content, encoding: obj.encoding, id: obj.id || activity?.id });
    return null;
  }

  const contextId = obj.context || activity.context || null;

  let type;
  if (types.includes('Welcome')) type = 'Welcome';
  else if (types.includes('GroupInfo')) type = 'GroupInfo';
  else if (types.includes('PrivateMessage')) type = 'PrivateMessage';
  else if (types.includes('PublicMessage')) type = 'PublicMessage';
  else {
    console.log('[parseMLSActivity] Rejected: unknown MLS type', { types, id: obj.id || activity?.id });
    return null;
  }

  return {
    type,
    originalTypes: types, // full original type array — preserved for receipt detection in catch blocks
    content: obj.content,
    context: contextId,
    encoding: obj.encoding,
    attributedTo: obj.attributedTo,
    id: obj.id || activity.id,
    to: obj.to,
    cc: obj.cc,
    inReplyTo: obj.inReplyTo,
    name: null  // will be set from decrypted content for PrivateMessages
  };
}

