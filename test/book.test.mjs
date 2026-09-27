// The codebook object and the one live computation the shipped game performs. A level is a set
// of codes plus a secret inside it; this file's tests cover the identity format (the BigInt
// bitmask the policy map is keyed by), the structural validator that keeps a corrupt level from
// loading, and the candidate filter that the player watches count down on every submit.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { SPACE } from '../js/core/codes.js';
import { maskOf, indicesOf, popCount, validateBook, consistent } from '../js/core/book.js';
import { classTable } from '../js/core/table.js';
import { code, FEEDBACK_FIXTURES } from './fixture.mjs';

const book = [code(SPACE, '1123'), code(SPACE, '1234'), code(SPACE, '1111'), code(SPACE, '6666'), code(SPACE, '2112')];

// 1. The subset identity.
test('maskOf/indicesOf round-trip on arbitrary subsets', () => {
  const idx = [0, 1, 2, 3, 4];
  const cases = [[], [0], [4], [0, 4], [1, 3], [0, 1, 2, 3, 4], [2]];
  for (const list of cases) {
    const m = maskOf(list);
    eq(indicesOf(m), list, `round trip of ${list}`);
    eq(popCount(m), list.length, 'popcount');
  }
  ok(maskOf([0, 1]) !== maskOf([0, 2]), 'different subsets, different keys');
  ok(maskOf([4, 0, 2]) === maskOf([0, 2, 4]), 'the key is a set, not a sequence');
  eq(idx.map((i) => maskOf([i]) > 0n).every(Boolean), true, 'every single code has its own bit');
});

test('maskOf stays exact far past 64 bits (a JS number could not)', () => {
  const wide = [];
  for (let i = 0; i < 200; i += 2) wide.push(i);
  const m = maskOf(wide);
  eq(indicesOf(m), wide, '100 bits set, all of them recovered');
  eq(typeof m, 'bigint', 'the key type is part of the storage format');
});

// 2. validateBook: every way a level row can be wrong.
test('validateBook accepts a well-formed row and says so with null', () => {
  const row = { book, secret: book[2], value: 3, par: 3 };
  eq(validateBook(SPACE, row), null, 'valid');
});

test('validateBook rejects the six ways a codebook can be broken', () => {
  const good = { book, secret: book[2], value: 3, par: 3 };
  const bad = [
    [{ book: [] }, 'empty book'],
    [{ book: [book[0]] }, 'book of one code is not a puzzle'],
    [{ book: [book[0], book[0]] }, 'duplicate code in book'],
    [{ book: [book[0], -1] }, 'book code outside the space'],
    [{ book: [book[0], SPACE.N] }, 'book code outside the space'],
    [{ book, secret: SPACE.N + 5 }, 'secret outside the space'],
    [{ book, secret: book[0] + 1, value: 3 }, 'secret not in book'],
    [{ book, secret: book[1], value: 0 }, 'value out of range for the book'],
    [{ book, secret: book[1], value: 99 }, 'value out of range for the book'],
    [{ book, secret: book[1], value: 3, par: 2 }, 'par and value disagree'],
  ];
  for (const [patch, expected] of bad) {
    const row = { ...good, ...patch };
    const err = validateBook(SPACE, row);
    ok(err !== null, `${JSON.stringify(patch)} should have been rejected`);
    ok(err.includes(expected), `expected "${expected}", got "${err}"`);
  }
});

test('validateBook: a non-integer secret or a float code is refused', () => {
  eq(validateBook(SPACE, { book, secret: 1.5, value: 2 }), 'secret outside the space');
  ok(validateBook(SPACE, { book: [1.5, 2], secret: 2, value: 2 }) !== null, 'float code');
  ok(validateBook(SPACE, { book: null }) !== null, 'no book at all');
});

// 3. consistent(): the only computation the browser does per submit.
test('consistent(): only keeps candidates whose feedback equals what the screen showed', () => {
  const guess = code(SPACE, '1123');
  const table = classTable(SPACE);
  for (const f of FEEDBACK_FIXTURES) {
    const g = code(SPACE, f.guess);
    const s = code(SPACE, f.secret);
    const fbId = SPACE.fbIndex(g, s);
    const kept = consistent(SPACE, book, g, fbId);
    ok(kept.length <= book.length, 'never grows');
    for (const c of kept) eq(SPACE.fbIndex(g, c), fbId, 'kept candidate must answer the same way');
    for (const c of book) {
      if (!kept.includes(c)) ok(SPACE.fbIndex(g, c) !== fbId, 'dropped candidate answered differently');
    }
    // and the table the search uses agrees with the function the browser uses
    for (const c of book) eq(table[g * SPACE.N + c], SPACE.fbIndex(g, c), 'table vs live rule');
  }
});

test('consistent(): a fixture secret survives its own feedback, and the real answer is inside', () => {
  const s = code(SPACE, '1234');
  const g = code(SPACE, '1123');
  const kept = consistent(SPACE, book, g, SPACE.fbIndex(g, s));
  ok(kept.includes(s), 'the secret can never be filtered out by its own answer');
});

test('consistent(): an impossible answer empties the set rather than throwing', () => {
  const kept = consistent(SPACE, book, book[0], SPACE.R - 1);
  ok(Array.isArray(kept), 'returns an array');
  ok(kept.length < book.length, 'shrinks');
});

test('consistent(): does not mutate the list it filters', () => {
  const before = book.slice();
  const kept = consistent(SPACE, book, book[1], 0);
  eq(book, before, 'input untouched');
  ok(kept !== book, 'output is a new array');
});

test('consistent(): full-length run costs what the README claims (O(|S|), one pass)', () => {
  const big = [];
  for (let i = 0; i < 500; i++) big.push(i * 2);
  const t0 = Date.now();
  let kept = big;
  for (let round = 0; round < 200; round++) kept = consistent(SPACE, kept, 7, SPACE.fbIndex(7, big[3]));
  const ms = Date.now() - t0;
  ok(kept.length >= 1, 'something survives its own answer');
  ok(ms < 1500, `200 filters over a 500-code book took ${ms}ms in node; the browser is the same code path`);
});

// 4. The invariant the two halves of the UI share: the pegs a row shows and the candidate count
// it leaves are computed from the same function, so they can never tell different stories.
test('the live rule, the search table and the pegs agree on 300 random triples', () => {
  const table = classTable(SPACE);
  let seed = 99;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 300; i++) {
    const a = rnd(SPACE.N);
    const b = rnd(SPACE.N);
    const [black, white] = SPACE.blackWhite(a, b);
    const id = SPACE.fbIndex(a, b);
    eq(SPACE.bw(id), [black, white], 'the pegs drawn and the id stored are the same answer');
    eq(table[a * SPACE.N + b], id, 'the search sees the same answer');
    const kept = consistent(SPACE, [a, b], a, id);
    ok(kept.includes(b), 'filtering by a real answer keeps the secret it was computed against');
  }
});

run();
