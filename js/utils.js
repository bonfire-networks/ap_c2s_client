// Utility functions: encoding, ID generation, byte conversions

/** Check if an AP object's type field (string or array) includes a given type, ignoring mls: prefix. */
export function hasType(obj, type) {
  const t = obj?.type;
  if (Array.isArray(t)) return t.includes(type) || t.includes(`mls:${type}`);
  return t === type || t === `mls:${type}`;
}

import * as ulidx from 'ulidx'

export function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64(bytes) {
  if (!bytes) {
    console.warn('bytesToBase64: input is required', bytes);
    throw new Error('bytesToBase64: input is required');
  }
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr));
}

export function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

export function hexToBytes(hex) {
  if (!hex || typeof hex !== 'string') throw new Error('hexToBytes: input must be a hex string');
  const clean = hex.replace(/[^a-fA-F0-9]/g, "");
  if (clean.length === 0) {
    console.warn('hexToBytes: input string is empty or not valid hex', hex);
    throw new Error('hexToBytes: input string is empty or not valid hex');
  }
  return new Uint8Array(clean.match(/.{1,2}/g).map(h => parseInt(h, 16)));
}

export function safeAsync(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error(e);
      return null;
    }
  };
}

export function bytesFromInput(input) {
  if (input instanceof Uint8Array) return input;
  if (Array.isArray(input)) return new Uint8Array(input);
  if (typeof input === 'string') {
    return decodeKeyPackageString(input);
  }
  console.warn('bytesFromInput: Unsupported input type:', input);
  throw new Error('Unsupported byte-like input');
}

export function arrayToUint8Array(arr) {
  if (arr instanceof Uint8Array) return arr;
  if (Array.isArray(arr)) return Uint8Array.from(arr);
  return arr;
}

// MLS ciphersuite identifiers per RFC 9420
const MLS_CIPHERSUITES = {
  0x0001: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
  0x0002: 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256',
  0x0003: 'MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519',
  0x0004: 'MLS_256_DHKEMX448_AES256GCM_SHA512_Ed448',
  0x0005: 'MLS_256_DHKEMP521_AES256GCM_SHA512_P521',
  0x0006: 'MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448',
  0x0007: 'MLS_256_DHKEMP384_AES256GCM_SHA384_P384',
};


const MLS_CIPHERSUITE_IDS = Object.fromEntries(
  Object.entries(MLS_CIPHERSUITES).map(([id, name]) => [name, Number(id)])
);

/** Resolve a ciphersuite name string to its numeric identifier, or null if unknown. */
export function mlsCiphersuiteIdFromName(name) {
  if (!name) return null;
  return MLS_CIPHERSUITE_IDS[name] ?? null;
}

export function hasKeyPackage(keyPackages) {
  return keyPackages && (
    (typeof keyPackages === 'string') ||
    (Array.isArray(keyPackages) && keyPackages.length > 0) ||
    (keyPackages.items && Array.isArray(keyPackages.items) && keyPackages.items.length > 0)
  );
}

export function ulid() {
  return ulidx.ulid ? ulidx.ulid() : (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))
}

export function isHexString(str) {
  return typeof str === 'string' && /^[a-fA-F0-9]+$/.test(str) && str.length % 2 === 0;
}

export function isBase64String(str) {
  return typeof str === 'string' && /^[A-Za-z0-9+/=]+$/.test(str) && str.length % 4 === 0;
}

export function decodeKeyPackageString(str) {
  if (!str || typeof str !== 'string') throw new Error('decodeKeyPackageString: input must be a string');
  if (isHexString(str)) {
    return hexToBytes(str);
  }
  if (isBase64String(str)) {
    return Uint8Array.from(atob(str), c => c.charCodeAt(0));
  }
  throw new Error('decodeKeyPackageString: input is not valid hex or base64');
}

export function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── MLS URI helpers ──────────────────────────────────
// Internal IDs:  mls://g/{ulid}  mls://m/{ulid}
// Shareable:     ap-mls://{instance}/path  (maps to https:// apId)

export function groupUri(id = ulid())   { return `mls://g/${id}`; }
export function messageUri(id = ulid()) { return `mls://m/${id}`; }

export function formatFileSize(bytes) {
  return bytes ? (bytes / 1024).toFixed(1) + ' KB' : '';
}

export function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}
