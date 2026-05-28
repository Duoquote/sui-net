/** Normalize a Sui address/object id to lowercase, 0x-prefixed, 64 hex chars. */
export function normalizeAddress(addr: string): string {
  let h = addr.trim().toLowerCase();
  if (h.startsWith('0x')) h = h.slice(2);
  h = h.replace(/[^0-9a-f]/g, '');
  if (h.length > 64) h = h.slice(-64);
  return '0x' + h.padStart(64, '0');
}

/** Bare 64-hex form (no 0x), used as map keys. */
export function bareAddress(addr: string): string {
  return normalizeAddress(addr).slice(2);
}

/** Shorten an address for display: 0x1234…abcd. */
export function shortAddress(addr: string, lead = 6, tail = 4): string {
  const n = normalizeAddress(addr);
  return `${n.slice(0, 2 + lead)}…${n.slice(-tail)}`;
}

/** A 32-byte tx digest is base58 (not hex); leave it mostly untouched. */
export function looksLikeDigest(s: string): boolean {
  return !s.startsWith('0x') && /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s.trim());
}
