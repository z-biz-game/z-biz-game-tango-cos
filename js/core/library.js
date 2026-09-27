// The shipped level pool. The game picks a codebook from here; it never analyses one, and that
// is a measured decision — see tools/bake.mjs and the performance red line in DESIGN.md 5.
//
// Everything below is a pure lookup over js/data/lots.js, which is why the daily puzzle and a
// shared link are reproducible without any state: the pool is fixed and the seed only chooses
// an index. The one transformation applied at load is turning each lot's serialised `policy`
// array into a Map keyed by the subset bitmask, so a hint is one O(|S|) mask build plus one
// hash lookup.

import { LOTS, TIERS_META, BAKED_AT } from '../data/lots.js';
import { hexToMask } from './book.js';
import { hashSeed } from './rng.js';

// Display-side tier list (label / blurb / measured band). The generation ladder with its search
// budgets lives in js/core/make.js and is not needed once the lots are baked.
export const TIERS = TIERS_META;
export const bakedAt = BAKED_AT;

function compile(row) {
  const policy = new Map();
  for (const [hex, guess, value] of row.policy) policy.set(hexToMask(hex), { guess, value });
  return {
    id: row.id,
    tier: row.tier,
    par: row.par,
    value: row.value,
    size: row.size,
    bound: row.bound,
    floor: row.floor,
    R: row.R,
    secret: row.secret,
    book: row.book.slice(),
    policy,
    nodes: row.nodes,
    ms: row.ms,
  };
}

const prepared = LOTS.map(compile);

export const ALL = prepared;

function pick(list, seed, salt) {
  if (!list.length) return null;
  return list[hashSeed(`${salt}|${seed}`) % list.length];
}

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}

export function lotsIn(key) {
  return prepared.filter((l) => l.tier === key);
}

export function byId(id) {
  return prepared.find((l) => l.id === id) || null;
}

// The campaign: every baked lot, easiest band first and inside a band smallest codebook first —
// the order tools/bake.mjs wrote them in.
export function campaign() {
  return prepared;
}

export function levelAt(index) {
  return prepared[((index % prepared.length) + prepared.length) % prepared.length];
}

// Endless play in one band. A seed picks, so a shared link stays honest.
export function randomLot(seed, tierKey) {
  const list = tierKey && tierKey !== 'all' ? lotsIn(tierKey) : prepared;
  return pick(list, seed, 'random');
}

// One puzzle per calendar day, the same for everyone.
export function dailyLot(dateKey) {
  return pick(prepared, dateKey, 'daily');
}

// What the shipped pool actually contains, measured rather than claimed: the harness prints
// this, so a re-bake that quietly loses difficulty shows up as a changed band. `sizeMed` is
// here for the same reason a min/max pair is not enough — a tier where every lot has the same
// codebook is one puzzle wearing four costumes.
function median(sorted) {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}

export function stats() {
  const byTier = {};
  for (const l of prepared) {
    const s = byTier[l.tier] || (byTier[l.tier] = {
      n: 0, min: Infinity, max: 0, sizeMin: Infinity, sizeMax: 0, boundMax: 0, sizes: [], nodesMax: 0, msMax: 0,
    });
    s.n++;
    if (l.par < s.min) s.min = l.par;
    if (l.par > s.max) s.max = l.par;
    if (l.size < s.sizeMin) s.sizeMin = l.size;
    if (l.size > s.sizeMax) s.sizeMax = l.size;
    if (l.bound > s.boundMax) s.boundMax = l.bound;
    if (l.nodes > s.nodesMax) s.nodesMax = l.nodes;
    if (l.ms > s.msMax) s.msMax = l.ms;
    s.sizes.push(l.size);
  }
  for (const key of Object.keys(byTier)) {
    const s = byTier[key];
    s.sizes.sort((a, b) => a - b);
    s.sizeMed = median(s.sizes);
    s.msMax = Math.round(s.msMax * 10) / 10;
    delete s.sizes;
  }
  return { lots: prepared.length, byTier };
}
