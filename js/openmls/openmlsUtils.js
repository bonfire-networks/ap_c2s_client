// openmlsUtils.js
// Utility functions for OpenMLS integration

export function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  if (!hex) return new Uint8Array();
  const clean = hex.replace(/[^a-fA-F0-9]/g, "");
  if (clean.length === 0) return new Uint8Array();
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
