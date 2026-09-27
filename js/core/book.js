// The codebook: the object a level actually is.
//
//   book  = a set of codes (indices into the space, no repeats) the secret is drawn from
//   secret = one member of the book
//
// The player may guess ANY code in the space, not only book members — that is the standard
// Mastermind rule, and it is what the printed `value` is computed under (see DESIGN.md 2.2:
// change the rule, the number changes). What is *guaranteed* to contain the secret is the
// book, so "remaining candidates" always means candidates inside the book.
//
// Subset identity: a book of `s` codes has its subsets keyed by a BigInt bitmask over
// book-relative indices (bit i = the i-th book code is still possible). That is what
// js/core/minimax.js memoises on and what the baked per-level `policy` map is keyed by, and
// the browser computes the same key from the surviving candidates in O(|S|) — no search.
// `maskOf` / `indicesOf` are the only place that format is defined, and `maskToHex` /
// `hexToMask` the only place it is serialised for storage.

const BIT = [];
function bit(i) {
  return BIT[i] === undefined ? (BIT[i] = 1n << BigInt(i)) : BIT[i];
}

export function maskOf(list) {
  let m = 0n;
  for (let k = 0; k < list.length; k++) m |= bit(list[k]);
  return m;
}

// The other direction: mask -> ascending book-relative indices. Used by the tests to
// re-verify a baked policy entry without trusting the array that produced it.
export function indicesOf(mask) {
  const out = [];
  let m = mask;
  let i = 0;
  while (m > 0n) {
    if (m & 1n) out.push(i);
    m >>= 1n;
    i++;
  }
  return out;
}

// The storage form of a key: lowercase hex without the `0x`. Both directions live here because
// `BigInt('fff')` throws while `BigInt('0xfff')` does not, and a bake that wrote one prefix with
// a loader that read the other would fail on the first nibble above 9 — roughly half the levels.
export function maskToHex(mask) {
  return mask.toString(16);
}

export function hexToMask(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]+$/.test(hex)) throw new Error(`not a subset mask hex: ${hex}`);
  return BigInt(`0x${hex}`);
}

export function popCount(mask) {
  let m = mask;
  let n = 0;
  while (m > 0n) {
    if (m & 1n) n++;
    m >>= 1n;
  }
  return n;
}

// Structural validation of a level. Returns an error string or null. Every branch here is
// exercised by a negative fixture in test/book.test.mjs — a book with a duplicate, a code
// outside the space, an empty book, a secret not in the book, a size outside the contract.
export function validateBook(space, row) {
  if (!row || !Array.isArray(row.book) || row.book.length === 0) return 'empty book';
  if (row.book.length < 2) return 'book of one code is not a puzzle';
  const seen = new Set();
  for (const code of row.book) {
    if (!Number.isInteger(code) || code < 0 || code >= space.N) return 'book code outside the space';
    if (seen.has(code)) return 'duplicate code in book';
    seen.add(code);
  }
  if (!Number.isInteger(row.secret) || row.secret < 0 || row.secret >= space.N) return 'secret outside the space';
  if (!seen.has(row.secret)) return 'secret not in book';
  if (!Number.isInteger(row.value) || row.value < 1 || row.value > row.book.length) return 'value out of range for the book';
  if (Number.isInteger(row.par) && row.par !== row.value) return 'par and value disagree';
  return null;
}

// The only live computation the shipped game does: intersect the surviving candidates with
// one observed answer. O(|candidates|) with no allocation beyond the output array, which is
// why the "remaining candidates" tile can update on every submit without a spinner.
// It routes through `space.fbIndex` — the single implementation of the two-pass rule — so the
// panel's candidate count and the feedback pegs can never disagree with each other.
export function consistent(space, cands, guess, fbId) {
  const out = [];
  for (let k = 0; k < cands.length; k++) {
    if (space.fbIndex(guess, cands[k]) === fbId) out.push(cands[k]);
  }
  return out;
}
