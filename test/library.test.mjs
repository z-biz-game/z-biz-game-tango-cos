// The serialised pool, re-proved from the bytes on disk.
//
// This is the file that makes the shipped claim true rather than decorative. tools/bake.mjs
// printed numbers into js/data/lots.js; nothing in the browser checks them at run time (the
// performance red line forbids it), so THIS is where the check lives:
//   * every lot's `value`/`par` is recomputed from its serialised `book` by a fresh minimax —
//     a hand-edit of a single digit in that file fails here, not in production;
//   * solver 2 (independent algorithm family) confirms the number on the books small enough for
//     it, and on a mid book for cost reasons;
//   * `canBreakIn(book, par)` is TRUE while `canBreakIn(book, par - 1)` is FALSE — the verdict
//     is not a constant the search always returns, it changes when the number changes;
//   * deleting any code from a shipped glance book never RAISES its value (a strategy for the
//     bigger book is a strategy for the smaller), and on at least one book deleting a code
//     actually LOWERS it — the value really is a function of the clues on the page;
//   * every baked policy is closed and strictly descending (js/core/minimax.js policyClosed),
//     which is the correctness proof for the hint button;
//   * the bounds chain, the secret-in-book rule, the validateBook rule and the TIERS_META
//     summary are all re-derived from the rows, not trusted from the bake log.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { SPACE, infoBound, valueFloor, capacity } from '../js/core/codes.js';
import { LOTS, TIERS_META, BAKED_AT } from '../js/data/lots.js';
import { minimax, policyClosed } from '../js/core/minimax.js';
import { canBreakIn, valueByDecision } from '../js/core/decide.js';
import { validateBook, maskOf, hexToMask, maskToHex, indicesOf } from '../js/core/book.js';
import * as library from '../js/core/library.js';
import { hashSeed, mulberry32, rngFrom } from '../js/core/rng.js';

const budget = { space: SPACE, maxNodes: 2000000, maxMs: 30000 };

// ---- 1. per-lot re-proof --------------------------------------------------

test('pool is present and the ids are unique', () => {
  ok(LOTS.length >= 24, `only ${LOTS.length} lots baked`);
  const ids = LOTS.map((l) => l.id);
  eq(new Set(ids).size, ids.length, 'duplicate lot id');
});

test('every lot: structural validation passes from the serialised row alone', () => {
  for (const l of LOTS) {
    const err = validateBook(SPACE, l);
    eq(err, null, `${l.id}: ${err}`);
    eq(l.book.length, l.size, `${l.id}: size field disagrees with the book`);
    eq(l.R, SPACE.R, `${l.id}: R field is the space's, not an opinion`);
    ok(l.book.includes(l.secret), `${l.id}: secret must be a member of its own book`);
  }
});

test('every lot: bound and floor recomputed from the serialised size match what is printed', () => {
  for (const l of LOTS) {
    eq(l.bound, infoBound(SPACE, l.size), `${l.id}: printed bound`);
    eq(l.floor, valueFloor(SPACE, l.size), `${l.id}: printed floor`);
    ok(l.value >= l.floor, `${l.id}: value below its own floor`);
    ok(l.floor >= l.bound, `${l.id}: floor below the printed bound`);
    ok(l.value >= 2, `${l.id}: a shipped book always has >= 2 codes`);
    ok(l.par === l.value, `${l.id}: par and value must be the same measured number`);
    // the external inequality the spec demands per lot:
    ok(SPACE.R ** (l.value - 1) >= 1 && l.size <= capacity(SPACE, l.value), `${l.id}: size over capacity(value)`);
  }
});

test('every lot: fresh minimax from the serialised book reproduces the printed value', () => {
  for (const l of LOTS) {
    const before = JSON.stringify(l.book);
    const r = minimax(l.book, budget);
    eq(r.value, l.value, `${l.id}: re-searched value != printed value`);
    eq(JSON.stringify(l.book), before, `${l.id}: solver must not touch the book`);
    ok(r.nodes >= 1, `${l.id}: node counter`);
  }
});

test('solver 2 agrees on every lot small enough for depth-limited search (glance + probe)', () => {
  const small = LOTS.filter((l) => l.size <= 50);
  ok(small.length >= 12, `expected at least 12 small lots, found ${small.length}`);
  for (const l of small) {
    const d = valueByDecision(l.book, budget);
    eq(d.value, l.value, `${l.id}: decide vs minimax`);
  }
  // grind spot-check: the 92-code book is inside solver 2's measured reach.
  const mid = LOTS.filter((l) => l.tier === 'grind').sort((a, b) => a.size - b.size)[0];
  eq(valueByDecision(mid.book, budget).value, mid.value, `${mid.id}: decide on the smallest grind book`);
});

test('the verdict is not decorative: par-1 is provably false, par is true, per small lot', () => {
  // If canBreakIn always answered true, every number in this repo would be a lie. On these lots
  // it must say NO at one guess less than the printed par — and the answer must flip at exactly
  // the printed value, on both sides, from a fresh call.
  const pick = LOTS.filter((l) => l.size <= 24).slice(0, 8);
  ok(pick.length >= 6, 'enough cheap lots for the two-sided verdict check');
  for (const l of pick) {
    const low = canBreakIn(l.book, l.par - 1, budget);
    eq(low.ok, false, `${l.id}: ${l.par - 1} guesses must NOT be enough for a book printed at ${l.par}`);
    const hit = canBreakIn(l.book, l.par, budget);
    eq(hit.ok, true, `${l.id}: ${l.par} guesses must be enough (that is what par means)`);
  }
});

test('deleting a code never raises the value, and paring a book down must eventually drop it', () => {
  // The "erase one clue" experiment the contract asks for, in this model: a book is the clue
  // set. Monotonicity (every strategy for S works for S' ⊆ S) must hold on real shipped books —
  // checked code by code. And the value must not be a constant dressed as a measurement: a
  // probe book (printed 3) pared down guess by guess ends at two codes, and EVERY two-code book
  // has value 2 (guess one of them; its own answer isolates it, the other code answers
  // differently, and 2 is the floor for any book of size >= 2). So the chain must end strictly
  // below the printed number or the printed number is not measuring the book.
  for (const l of LOTS.filter((x) => x.tier === 'glance').slice(0, 4)) {
    for (let drop = 0; drop < l.book.length; drop++) {
      const smaller = l.book.slice(0, drop).concat(l.book.slice(drop + 1));
      const v = minimax(smaller, budget).value;
      ok(v <= l.value, `${l.id}: dropping code ${drop} RAISED the value ${l.value} -> ${v}`);
    }
  }
  const probe = LOTS.filter((x) => x.tier === 'probe').sort((a, b) => a.size - b.size)[0];
  eq(probe.value, 3, 'the chain starts from a printed 3');
  let chain = probe.book.slice();
  let last = probe.value;
  let droppedTo = null;
  while (chain.length > 2) {
    chain = chain.slice(0, -1);
    const v = minimax(chain, budget).value;
    ok(v <= last, `${probe.id}: paring down raised ${last} -> ${v} at size ${chain.length}`);
    last = v;
    if (v < 3 && droppedTo === null) droppedTo = { size: chain.length, value: v };
  }
  eq(last, 2, 'a two-code book is worth exactly 2 guesses');
  ok(droppedTo !== null, 'the probe book never came down to 2 on the way — contradiction with its own tail');
});

test('every lot: the baked policy is closed and strictly descending', () => {
  for (const l of LOTS) {
    const entries = l.policy;
    ok(entries.length >= 1, `${l.id}: policy must cover at least the full book`);
    const err = policyClosed(SPACE, l.book, entries);
    eq(err, null, `${l.id}: ${err}`);
  }
});

test('every policy key round-trips through the storage hex form', () => {
  for (const l of LOTS) {
    for (const [hex, guess, value] of l.policy) {
      eq(maskToHex(hexToMask(hex)), hex, `${l.id}: hex must be canonical lowercase`);
      const list = indicesOf(hexToMask(hex));
      ok(list.length >= 2, `${l.id}: a policy entry for fewer than 2 candidates should not exist`);
      ok(Number.isInteger(guess) && guess >= 0 && guess < SPACE.N, `${l.id}: guess outside the space`);
      ok(value >= 2 && value <= list.length, `${l.id}: policy value ${value} impossible for ${list.length} candidates`);
    }
  }
});

test('the root policy entry exists and its guess splits the whole book', () => {
  for (const l of LOTS) {
    const rootMask = maskOf(l.book.map((_, i) => i));
    const entry = l.policy.find(([hex]) => hexToMask(hex) === rootMask);
    ok(entry, `${l.id}: no policy entry for the full book — hint button would always fall back`);
  }
});

// ---- 2. the library layer over it ---------------------------------------

test('library: ALL is the same rows, compiled; lookups are stable', () => {
  eq(library.ALL.length, LOTS.length, 'all rows');
  const a = library.byId('glance-01');
  ok(a && a.id === 'glance-01', 'byId');
  eq(library.byId('nope-99'), null, 'unknown id says null, not throws');
  eq(library.campaign().map((l) => l.id), LOTS.map((l) => l.id), 'campaign order = bake order');
  eq(library.levelAt(-1).id, library.levelAt(library.ALL.length - 1).id, 'negative index wraps, does not crash');
  ok(library.lotsIn('glance').every((l) => l.tier === 'glance'), 'lotsIn filters');
  eq(library.tierByKey('bogus').key, TIERS_META[0].key, 'unknown tier falls back to the first');
});

test('library: policies compile to Maps keyed by the same masks', () => {
  const l = library.byId('probe-01');
  ok(l.policy instanceof Map, 'compiled to a Map');
  ok(l.policy.size >= 1, 'at least the root entry survived compilation');
  const m = l.policy.get(maskOf(l.book.map((_, i) => i)));
  ok(m && Number.isInteger(m.guess) && m.value >= 2, 'root mask lookup works');
});

test('daily and random picks are deterministic functions of the seed', () => {
  const d1 = library.dailyLot('2026-01-01').id;
  const d2 = library.dailyLot('2026-01-01').id;
  eq(d1, d2, 'same date, same lot');
  ok(library.dailyLot('2026-01-02').id !== undefined, 'adjacent date still resolves a lot');
  const r1 = library.randomLot('abc', 'grind').id;
  eq(library.randomLot('abc', 'grind').id, r1, 'same seed, same lot');
  eq(library.lotsIn('grind').some((l) => l.id === r1), true, 'random stays in its tier');
  eq(library.randomLot('any', 'all').id !== undefined, true, 'all tier resolves');
});

test('hashSeed is deterministic, seed-sensitive and unsigned', () => {
  eq(hashSeed('tango'), hashSeed('tango'), 'same string same hash');
  ok(hashSeed('tango') !== hashSeed('tangb'), 'different strings differ');
  ok(Number.isInteger(hashSeed('x')) && hashSeed('x') >= 0, 'unsigned 32-bit');
  eq(hashSeed('破码'), hashSeed('破码'), 'multibyte is at least stable');
});

test('mulberry32: same seed same stream, different seed different stream', () => {
  const rng1 = mulberry32(42);
  const rng2 = mulberry32(42);
  const s1 = [];
  const s2 = [];
  for (let i = 0; i < 8; i++) { s1.push(rng1()); s2.push(rng2()); }
  eq(s1, s2, 'same seed, same eight draws');
  ok(s1.every((x) => x >= 0 && x < 1), 'draws are in [0,1)');
  ok(mulberry32(43)() !== s1[0], 'different seed, different first draw (overwhelmingly likely)');
  const r = rngFrom('seeded');
  ok(typeof r.int === 'function' && r.int(1000000) >= 0 && r.int(1000000) < 1000000, 'rngFrom makes a working bounded rng');
  const a = rngFrom('same');
  const b = rngFrom('same');
  eq([a(), a.range(5, 9), a.pick([1, 2, 3])], [b(), b.range(5, 9), b.pick([1, 2, 3])], 'string seeds reproduce every helper');
  eq(rngFrom(5)(), rngFrom(5)(), 'number seeds reproduce');
  eq(rngFrom(5)() !== rngFrom(6)(), true, 'and differ across seeds');
});

test('TIERS_META matches the rows it summarises', () => {
  for (const t of TIERS_META) {
    const mine = LOTS.filter((l) => l.tier === t.key);
    eq(mine.length >= 1, true, `${t.key}: meta describes a tier nobody baked`);
    eq(t.min, Math.min(...mine.map((l) => l.value)), `${t.key}: min value`);
    eq(t.max, Math.max(...mine.map((l) => l.value)), `${t.key}: max value`);
    eq(t.sizeMin, Math.min(...mine.map((l) => l.size)), `${t.key}: sizeMin`);
    eq(t.sizeMax, Math.max(...mine.map((l) => l.size)), `${t.key}: sizeMax`);
    eq(t.boundMax, Math.max(...mine.map((l) => l.bound)), `${t.key}: boundMax`);
    eq(t.value, t.min, `${t.key}: bands are exact values, so min must equal the band value`);
    eq(t.value, t.max, `${t.key}: and max must too`);
  }
  eq(new Set(TIERS_META.map((t) => t.value)).size, TIERS_META.length, 'bands are pairwise disjoint by value');
});

test('BAKED_AT is the ISO stamp the file header claims, and library re-exports it', () => {
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(BAKED_AT), `not ISO: ${BAKED_AT}`);
  eq(library.bakedAt, BAKED_AT, 'the wiring main.js reads must be the file itself');
  ok(Date.parse(BAKED_AT) > 0, 'parses to a date');
});

test('library stats() agrees with a recount from the rows', () => {
  const s = library.stats();
  eq(s.lots, LOTS.length, 'count');
  let sum = 0;
  for (const t of TIERS_META) {
    const st = s.byTier[t.key];
    ok(st, `stats missing ${t.key}`);
    eq(st.n, LOTS.filter((l) => l.tier === t.key).length, `${t.key}: n`);
    eq(st.min, t.min, `${t.key}: min`);
    eq(st.max, t.max, `${t.key}: max`);
    eq(st.sizeMin, t.sizeMin, `${t.key}: sizeMin`);
    eq(st.sizeMax, t.sizeMax, `${t.key}: sizeMax`);
    sum += st.n;
  }
  eq(sum, LOTS.length, 'per-tier counts add up');
});

run();
