// Utility functions for OpenMLS integration

import * as ulidx from "https://cdn.jsdelivr.net/npm/ulidx@2.4.1/+esm"

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

export function hasKeyPackage(keyPackages) {
  return keyPackages && (
    (typeof keyPackages === 'string') ||
    (Array.isArray(keyPackages) && keyPackages.length > 0) ||
    (keyPackages.items && Array.isArray(keyPackages.items) && keyPackages.items.length > 0)
  );
}

export function ulid() {
  return ulidx.ulid ? ulidx.ulid() : (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))
  // Process recent items (last 10)
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

