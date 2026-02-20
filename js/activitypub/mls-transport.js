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
 * Send an encrypted message as a PrivateMessage activity.
 *
 * @param {object} actor - current actor
 * @param {string} ciphertextB64 - base64-encoded ciphertext
 * @param {string[]} recipients - recipient actor URIs
 * @param {string} contextId - AP thread/group context ID
 * @param {object} [options]
 * @param {boolean} [options.isNewThread] - whether this creates a new thread
 * @param {string} [options.inReplyTo] - ID to reply to (defaults to contextId)
 * @returns {object} response from outbox
 */
export async function sendEncryptedMessage(actor, ciphertextB64, recipients, contextId, options = {}) {
  const { isNewThread, inReplyTo } = options;

  let to;
  if (isNewThread) {
    to = recipients;
  } else {
    const otherRecipients = recipients.filter(r => r !== actor.id);
    to = otherRecipients.length > 0 ? otherRecipients : recipients;
  }

  const message = {
    '@context': MLS_CONTEXTS,
    type: 'PrivateMessage',
    attributedTo: actor.id,
    to,
    summary: 'This is an encrypted message. Please read it using a compatible MLS-capable app.',
    mediaType: 'message/mls',
    encoding: 'base64',
    content: ciphertextB64,
  };
  // Only include context/inReplyTo when they're actual AP URIs (not local ULIDs)
  if (contextId) message.context = contextId;
  if (inReplyTo) message.inReplyTo = inReplyTo;
  else if (contextId) message.inReplyTo = contextId;

  const res = await postToOutbox(actor, message);
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
  if (!obj || !obj.type) return null;

  const types = Array.isArray(obj.type) ? obj.type : [obj.type];

  if (!obj.content || !obj.encoding || obj.encoding !== 'base64') {
    return null;
  }

  const contextId = obj.context || activity.context || null;

  let type;
  if (types.includes('Welcome')) type = 'Welcome';
  else if (types.includes('GroupInfo')) type = 'GroupInfo';
  else if (types.includes('PrivateMessage')) type = 'PrivateMessage';
  else return null;

  return {
    type,
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

