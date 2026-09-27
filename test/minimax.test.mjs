// The two shipped solvers and the dumb third one, against each other and against the theorems.
//
// This is the file that holds the `value(S)` evidence: every number printed on screen is the
// output of js/core/minimax.js, and what makes it trustworthy is that (a) an unrelated algorithm
// family (js/core/decide.js, iterative deepening, no memo, no bitmask) says the same thing on
// 120+ random codebooks, (b) a brute-force game tree with no pruning at all (test/naive.mjs)
// says the same thing on every small codebook that can be enumerated, and (c) the external
// inequality value >= 1 + ceil(log_R |S|) holds everywhere it is checked.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { SPACE, makeSpace, infoBound, valueFloor, capacity } from '../js/core/codes.js';
import { minimax, branchesOf, checkDescent, policyClosed, BudgetError } from '../js/core/minimax.js';
import { canBreakIn, valueByDecision } from '../js/core/decide.js';
import { randomBook } from '../js/core/make.js';
import { rngFrom } from '../js/core/rng.js';
import { maskOf, indicesOf, hexToMask, maskToHex } from '../js/core/book.js';
import { naiveValue, naiveFirstGuess } from './naive.mjs';
import { KNOWN_BOOKS, SMALL_SPACES, code } from './fixture.mjs';

const opt = (space, extra = {}) => ({ space, maxNodes: 400000, maxMs: 15000, ...extra });

// ---- 1. the frozen books --------------------------------------------------

test('the five hand-listed codebooks still come out at their written numbers', () => {
  for (const k of KNOWN_BOOKS) {
    const book = k.book.map((s) => code(SPACE, s));
    const a = minimax(book, opt(SPACE));
    eq(a.value, k.value, `minimax on ${k.book.join(' ')} (${k.why})`);
    eq(k.value >= 2, true, 'a book of two or more codes needs at least two guesses');
  }
});

test('solver 2 (decision search) reproduces all five frozen numbers', () => {
  for (const k of KNOWN_BOOKS) {
    const book = k.book.map((s) => code(SPACE, s));
    const d = valueByDecision(book, opt(SPACE));
    eq(d.value, k.value, `decide on ${k.book.join(' ')}`);
    ok(d.from <= k.value, 'iterative deepening started at or below the answer');
  }
});

test('the printed bound and the exact value differ on purpose', () => {
  const book = KNOWN_BOOKS[2].book.map((s) => code(SPACE, s)); // six codes, one peg apart
  const v = minimax(book, opt(SPACE)).value;
  eq(infoBound(SPACE, book.length), 1, 'what the screen prints as 下界');
  eq(valueFloor(SPACE, book.length), 2, 'the sharpened bound');
  eq(v, 3, 'the exact value beats both bounds — that gap is the game');
});

// ---- 2. three-way agreement where brute force is still possible -----------

function allBooks(space, size, cap) {
  const out = [];
  const n = space.N;
  const idx = new Array(size).fill(0);
  function at(pos, from) {
    if (out.length >= cap) return;
    if (pos === size) {
      out.push(idx.slice());
      return;
    }
    for (let c = from; c <= n - (size - pos) && out.length < cap; c++) {
      idx[pos] = c;
      at(pos + 1, c + 1);
    }
  }
  at(0, 0);
  return out;
}

for (const { name, space } of SMALL_SPACES) {
  test(`three-way agreement on every ${name} book of 2 and 3 codes`, () => {
    let checked = 0;
    for (const size of [2, 3]) {
      for (const list of allBooks(space, size, 200)) {
        const book = list.map((i) => space.all[i]);
        const a = minimax(book, opt(space)).value;
        const d = valueByDecision(book, opt(space)).value;
        const nv = naiveValue(space, book);
        ok(a === d && d === nv, `${name} ${book.join(',')}: ${a} ${d} ${nv}`);
        checked++;
      }
    }
    ok(checked >= 120, `${name}: checked ${checked} books`);
  });

  // Deeper books cost N^value for the brute force, so the bigger toy space samples fewer sizes.
  const deepSizes = space.N <= 9 ? [4, 5] : [4];
  test(`three-way agreement on sampled ${name} books of ${deepSizes.join(' and ')} codes`, () => {
    let checked = 0;
    for (const size of deepSizes) {
      for (const list of allBooks(space, size, 25)) {
        const book = list.map((i) => space.all[i]);
        const a = minimax(book, opt(space)).value;
        const d = valueByDecision(book, opt(space)).value;
        const nv = naiveValue(space, book);
        ok(a === d && d === nv, `${name} size ${size} book ${book.join(',')}: ${a}/${d}/${nv}`);
        ok(a >= valueFloor(space, size), `value ${a} below the floor for ${size} codes`);
        ok(a <= size, `value ${a} above one-guess-per-candidate`);
        checked++;
      }
    }
    ok(checked >= 25, `checked ${checked}`);
  });
}

// ---- 3. the 120-case two-way cross-check on the shipped space -------------

test('120 random codebooks: solver 1 and solver 2 agree, one number each', () => {
  let agree = 0;
  const seen = new Map();
  for (let i = 0; i < 120; i++) {
    const rng = rngFrom(`cross-${i}`);
    const size = rng.range(4, 24);
    const book = randomBook(SPACE, rng, size, { distinct: true }).book;
    const a = minimax(book, opt(SPACE));
    const d = valueByDecision(book, opt(SPACE));
    eq(a.value, d.value, `book ${i} of size ${size}`);
    agree++;
    seen.set(a.value, (seen.get(a.value) || 0) + 1);
    ok(a.value >= valueFloor(SPACE, size), `value ${a.value} under the floor for |S|=${size}`);
    ok(a.value >= infoBound(SPACE, size) + 1, 'the sharpened bound implies the printed one');
    ok(a.value <= size, 'one-at-a-time is always an upper bound');
  }
  eq(agree, 120, 'every case compared');
  ok(seen.size >= 2, `the sample spans more than one value: ${[...seen.keys()]}`);
});

test('the bound chain value >= valueFloor >= infoBound holds up to |S| = 1296', () => {
  for (let n = 2; n <= SPACE.N; n++) {
    ok(valueFloor(SPACE, n) >= infoBound(SPACE, n), `floor vs bound at ${n}`);
    ok(capacity(SPACE, valueFloor(SPACE, n) - 1) < n, `floor justified at ${n}`);
  }
  ok(true, '1295 sizes checked');
});

// ---- 4. what the search returns, not just the number ---------------------

test('the opening guess is allowed to be outside the codebook', () => {
  // If the solver only ever considered book members this would be hard to trigger; on the
  // shipped space it is common, and it is the visible proof of the 口径 (the player may guess
  // any of the 1296 codes) the printed par is computed under.
  let outside = 0;
  for (let i = 0; i < 20; i++) {
    const rng = rngFrom(`outside-${i}`);
    const book = randomBook(SPACE, rng, rng.range(10, 20), { distinct: true }).book;
    const r = minimax(book, opt(SPACE));
    const first = r.policy.get(maskOf(book.map((_, k) => k)));
    ok(first >= 0 && first < SPACE.N, 'the policy holds a code index');
    if (!book.includes(first)) outside++;
  }
  ok(outside >= 5, `only ${outside}/20 openings were non-book codes — the guess space is not the book`);
});

test('guesses really range over the whole space: a non-member can be strictly better', () => {
  // Two candidate-only guesses versus the best full-space guess, on a book chosen so the
  // difference is visible. naiveValue restricted to book members is the comparison.
  const space = SMALL_SPACES[0].space; // L=2 C=3, small enough to brute force
  let found = false;
  for (let i = 0; i < 60 && !found; i++) {
    const rng = rngFrom(`gap-${i}`);
    const book = randomBook(space, rng, 4, {}).book;
    const full = naiveValue(space, book);
    let restricted = Infinity;
    for (const g of book) {
      const buckets = new Map();
      for (const c of book) {
        const f = space.fbIndex(g, c);
        (buckets.get(f) || buckets.set(f, []).get(f)).push(c);
      }
      let worst = 0;
      for (const list of buckets.values()) worst = Math.max(worst, naiveValue(space, list));
      restricted = Math.min(restricted, 1 + worst);
    }
    if (full < restricted) {
      found = true;
      ok(full < restricted, `full-space ${full} beats book-only ${restricted}`);
    }
  }
  ok(found, 'no example found where the guess space matters — the 口径 would be pointless');
});

test('strict descent: every answer to the strategy move leaves value <= value - 1', () => {
  for (let i = 0; i < 12; i++) {
    const rng = rngFrom(`descent-${i}`);
    const book = randomBook(SPACE, rng, rng.range(4, 14), { distinct: true }).book;
    const r = minimax(book, opt(SPACE));
    const d = checkDescent(SPACE, book, r.policy, r.value);
    ok(d.ok, `descent failed on book ${i}: worst child ${d.worst} of value ${r.value}`);
    eq(d.worst <= r.value - 1, true, 'at least one guess is gone after one ply');
    const rows = [...r.policy.entries()].map(([m, g]) => [maskToHex(m), g, r.memo.get(m)]);
    const err = policyClosed(SPACE, book, rows);
    eq(err, null, 'the strategy is closed and descending everywhere, not just at the root');
    for (const [hex, , value] of rows) {
      ok(maskOf(indicesOf(hexToMask(hex))) === hexToMask(hex), 'keys round-trip through the storage form');
      ok(value !== undefined && value >= 2, 'every policy entry carries the exact value of that subset');
    }
  }
});

test('branchesOf partitions the book exactly once per candidate', () => {
  const book = KNOWN_BOOKS[1].book.map((s) => code(SPACE, s));
  const list = book.map((_, i) => i);
  for (const guess of [book[0], code(SPACE, '1111'), code(SPACE, '3456')]) {
    const kids = branchesOf(SPACE, book, guess, list);
    const flat = kids.reduce((a, k) => a.concat(k.list), []);
    eq(flat.length, list.length, 'nothing lost or duplicated');
    eq(new Set(flat).size, list.length, 'each candidate lands in exactly one answer class');
    for (const { fb, list: kid } of kids) {
      for (const k of kid) eq(SPACE.fbIndex(guess, book[k]), fb, 'the class really is one feedback');
    }
  }
});

// ---- 5. solver hygiene ---------------------------------------------------

test('minimax does not mutate its book and is deterministic', () => {
  const book = randomBook(SPACE, rngFrom('pure'), 18, { distinct: true }).book;
  const before = book.slice();
  const a = minimax(book, opt(SPACE));
  const b = minimax(book, opt(SPACE));
  eq(book, before, 'input array untouched');
  eq(a.value, b.value, 'two runs agree');
  eq([...a.policy.entries()].map(([m, g]) => `${m}:${g}`).sort(), [...b.policy.entries()].map(([m, g]) => `${m}:${g}`).sort(), 'same strategy');
  ok(a.nodes > 0 && a.ms >= 0, 'the node counter really counts');
});

test('decide does not mutate its book either, and reports its node count', () => {
  const book = randomBook(SPACE, rngFrom('pure2'), 14, { distinct: true }).book;
  const before = book.slice();
  const r = canBreakIn(book, 3, opt(SPACE));
  eq(book, before, 'input untouched');
  eq(typeof r.ok, 'boolean', 'a verdict');
  ok(r.nodes > 0, 'it looked at something');
});

test('a book that cannot be certified inside the budget throws instead of printing a number', () => {
  const book = randomBook(SPACE, rngFrom('budget'), 22, { distinct: true }).book;
  let threw = null;
  try {
    minimax(book, { space: SPACE, maxNodes: 3 });
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof BudgetError, `expected BudgetError, got ${threw}`);
  let threw2 = null;
  try {
    canBreakIn(book, 4, { space: SPACE, maxNodes: 5 });
  } catch (err) {
    threw2 = err;
  }
  ok(threw2 instanceof BudgetError, 'solver 2 also refuses to answer on an empty budget');
});

test('a false decision verdict: the bound condemns when it can, the search when it cannot', () => {
  // |S| > capacity(k) proves k guesses cannot be enough without looking at a single guess; a
  // book small enough to pass that filter has to be disproved the hard way. Both branches are
  // asserted, because both are load-bearing in tools/bake.mjs.
  const wide = randomBook(SPACE, rngFrom('false-wide'), 20, { distinct: true }).book;
  const vw = minimax(wide, opt(SPACE)).value;
  const condemned = canBreakIn(wide, vw - 1, opt(SPACE));
  eq(condemned.ok, false, `${vw - 1} guesses are not enough for a book of value ${vw}`);
  ok(wide.length > capacity(SPACE, vw - 1), 'this book is the case the bound alone decides');
  eq(condemned.nodes, 0, 'and it decided it before scanning a single guess');

  const tight = randomBook(SPACE, rngFrom('false-tight'), 14, { distinct: true }).book;
  const vt = minimax(tight, opt(SPACE)).value;
  const hard = canBreakIn(tight, vt - 1, opt(SPACE));
  eq(hard.ok, false, `${vt - 1} guesses are not enough for a 14-code book of value ${vt}`);
  ok(tight.length <= capacity(SPACE, vt - 1), 'the bound cannot decide this one');
  ok(hard.nodes > 0, 'so the search paid for the negative verdict');
  eq(canBreakIn(tight, vt, opt(SPACE)).ok, true, 'and the true verdict comes back at the value');
});

test('one-at-a-time is an upper bound the search never exceeds', () => {
  for (const size of [2, 5, 11, 30, 70]) {
    const book = randomBook(SPACE, rngFrom(`upper-${size}`), size, {}).book;
    const v = minimax(book, opt(SPACE, { maxMs: 30000, maxNodes: 3000000 })).value;
    ok(v <= size, `value ${v} > |S| ${size}: guessing each candidate one at a time is always legal`);
    ok(v >= 2, 'a book of two or more codes needs at least two guesses');
  }
});

test('the memo holds only exact subset values, and each is >= its own floor', () => {
  const book = randomBook(SPACE, rngFrom('memo'), 24, { distinct: true }).book;
  const r = minimax(book, opt(SPACE));
  ok(r.memo.size >= 1, 'subsets were solved');
  for (const [mask, v] of r.memo) {
    const n = indicesOf(mask).length;
    ok(v >= valueFloor(SPACE, n), `memo says ${v} for a ${n}-code subset, floor is ${valueFloor(SPACE, n)}`);
    ok(v <= n, `memo says ${v} for ${n} candidates`);
    ok(maskOf(indicesOf(mask)) === mask, 'keys are book masks');
  }
});

test('a single-code book and an empty book are not puzzles but must not crash', () => {
  eq(minimax([42], opt(SPACE)).value, 1, 'one candidate: one guess');
  eq(minimax([], opt(SPACE)).value, 0, 'no candidate: no guess');
  eq(canBreakIn([42], 1, opt(SPACE)).ok, true, 'solver 2 agrees');
  eq(canBreakIn([42], 0, opt(SPACE)).ok, false, 'and knows zero guesses is not enough');
});

test('cost stays inside what the README advertises for the shipped sizes', () => {
  // Not a performance gate — a regression tripwire: if one of these takes an order of magnitude
  // longer than the measured table in README.md, the prunes have been broken.
  const sizes = [20, 120];
  for (const size of sizes) {
    const book = randomBook(SPACE, rngFrom(`cost-${size}`), size, {}).book;
    const t0 = Date.now();
    const r = minimax(book, opt(SPACE, { maxMs: 4000 }));
    const ms = Date.now() - t0;
    ok(r.value >= 2, `|S|=${size} has a value`);
    ok(ms < (size > 60 ? 1200 : 400), `|S|=${size} took ${ms}ms, measured budget blown`);
  }
});

run();
