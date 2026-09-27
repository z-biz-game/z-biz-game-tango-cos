// The generator. There is no hand-authored level file in this repo, and that is deliberate:
// a codebook is only worth offering once the search says how hard it is.
//
// This runs at build time (tools/bake.mjs) and in the balance rig (tools/bench.mjs). Nothing
// shipped to the browser imports it.
//
// How a book is drawn: take |S| distinct codes at random out of the 1296, optionally
// refusing a code whose colour multiset is already taken (tango.md 3's "丢掉与已有码反馈相同的
// 冗余码" — the operational rule we measured, see DESIGN.md 4.2 for why this particular
// reading and not a vague one), then run the exact minimax and keep the book only if its
// value lands in the band. Difficulty is not steered by construction: the *only* filter is
// the measured value, which is what keeps the number honest.
//
// Acceptance rate and cost are printed by tools/bake.mjs and tools/bench.mjs rather than
// asserted here, because both move when the search moves.

import { SPACE } from './codes.js';
import { rngFrom } from './rng.js';
import { minimax, BudgetError } from './minimax.js';

// The generation ladder: four bands, each one an exact `value` (worst-case guesses needed),
// so the bands cannot overlap by construction. `size` is the |S| window the drawer samples
// from, and every lower bound in it is a measurement off tools/bench.mjs, not a wish:
//
//   |S| <= 7 draws land on value 2, 10-55 on 3, 70-300 on 4, 460-600 on 5;
//   the search costs ~0.2 ms / ~1 ms / ~5 ms / ~2.2 s at |S| = 6 / 20 / 120 / 500.
//
// The windows below sit inside those bands and away from the one measured dead zone (|S| ~ 420
// needs > 12 s and still fails 2 books in 6 — see README's measured table). `maxMs` is what
// turns an expensive book into a discarded book rather than a published guess.
export const TIERS = [
  { key: 'glance', label: '一瞥', value: 2, size: [4, 7], draws: 60, distinct: true, maxNodes: 20000, maxMs: 1000 },
  { key: 'probe', label: '试探', value: 3, size: [12, 45], draws: 40, distinct: true, maxNodes: 40000, maxMs: 1500 },
  { key: 'grind', label: '拉锯', value: 4, size: [90, 160], draws: 30, distinct: false, maxNodes: 100000, maxMs: 3000 },
  { key: 'siege', label: '围城', value: 5, size: [490, 520], draws: 8, distinct: false, maxNodes: 2000000, maxMs: 9000 },
];

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}

// The colour multiset of a code, as a string: '0012' covers 0102, 2100 and the rest.
export function multisetKey(space, code) {
  const row = code * space.C;
  let s = '';
  for (let c = 0; c < space.C; c++) s += String.fromCharCode(48 + space.counts[row + c]);
  return s;
}

// |S| distinct codes from the space, deterministically. `stats` tallies refusals.
export function randomBook(space, rng, size, opts = {}) {
  const book = [];
  const have = new Set();
  const multisets = opts.distinct ? new Set() : null;
  let dropped = 0;
  let guard = 0;
  while (book.length < size) {
    if (++guard > size * 400) return { book, dropped, short: true };
    const code = rng.int(space.N);
    if (have.has(code)) continue;
    if (multisets) {
      const key = multisetKey(space, code);
      if (multisets.has(key)) { dropped++; continue; }
      multisets.add(key);
    }
    have.add(code);
    book.push(code);
  }
  return { book, dropped, short: false };
}

// makeLot(seed, tier, stats?) -> { book, secret, value, ... } | null, deterministic in the seed.
export function makeLot(seed, tier, opts = {}) {
  const space = opts.space || SPACE;
  const stats = opts.stats;
  const rng = rngFrom(`${tier.key}|${seed}`);
  const hit = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1; };
  const tries = tier.draws || 40;

  for (let attempt = 0; attempt < tries; attempt++) {
    const size = rng.range(tier.size[0], tier.size[1]);
    const drawn = randomBook(space, rng, size, { distinct: tier.distinct });
    if (drawn.short) { hit('drawShort'); continue; }
    if (drawn.dropped) hit('drawRefused');
    let rated;
    try {
      rated = minimax(drawn.book, { space, maxNodes: tier.maxNodes, maxMs: tier.maxMs });
    } catch (err) {
      if (err instanceof BudgetError) { hit('budget'); continue; }
      throw err;
    }
    if (rated.value === tier.value) {
      // The secret is a member of the book — that is the definition of a codebook, and
      // tools/bake.mjs re-asserts it on the serialised row.
      const secret = drawn.book[rng.int(drawn.book.length)];
      hit('kept');
      return {
        book: drawn.book,
        secret,
        value: rated.value,
        size: drawn.book.length,
        nodes: rated.nodes,
        ms: rated.ms,
        seed: `${tier.key}|${seed}`,
        tier: tier.key,
      };
    }
    hit(rated.value < tier.value ? 'light' : 'heavy');
  }
  hit('gaveUp');
  return null;
}
