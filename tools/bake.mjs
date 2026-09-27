// The content pipeline. This is where the levels in the game come from — the browser never
// analyses a codebook, it only picks one and shrinks its candidate list.
//
// Why offline: tools/bench.mjs measured the exact minimax, and its cost per codebook grows
// violently with |S| (~0.2 ms at |S| = 6, ~5 ms at 120, ~2.2 s at 500 — README quotes the
// table). A few hundred milliseconds at build time is free; the same stall behind a tap is not
// a product. So the search runs here, once, and what ships is a measured set.
//
//   node tools/bake.mjs                  # -> js/data/lots.js
//   PER_TIER=24 node tools/bake.mjs
//
// A lot only enters the file if every one of these holds, and each is an assert in this script
// rather than a hope:
//   * the book, re-searched from the serialised array in a fresh solver, reproduces `value`;
//   * `value` >= valueFloor(|S|) >= ceil(log_R |S|) — an external theorem checking the search;
//   * the secret is a member of the book (validateBook, js/core/book.js);
//   * the baked strategy is closed and strictly descending (policyClosed, js/core/minimax.js),
//     which is what lets the hint button print "还有 N 步" as a fact.
//
// Nothing here is a gate the CI relies on: test/library.test.mjs re-verifies the shipped file
// from scratch, so a hand-edited js/data/lots.js fails the build too.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TIERS, makeLot } from '../js/core/make.js';
import { SPACE, infoBound, valueFloor } from '../js/core/codes.js';
import { minimax, policyClosed, BudgetError } from '../js/core/minimax.js';
import { validateBook, maskOf, indicesOf, maskToHex, hexToMask } from '../js/core/book.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PER_TIER = Number(process.env.PER_TIER || 8);
// Whole-bake watchdog: the per-book budgets discard expensive codebooks, but a tier whose
// acceptance rate collapses would otherwise keep the script drawing forever.
const MAX_TOTAL_S = Number(process.env.BAKE_MAX_S || 900);

const started = Date.now();
function elapsed() {
  return (Date.now() - started) / 1000;
}
function outOfTime(what) {
  if (elapsed() > MAX_TOTAL_S) throw new Error(`bake: ${what} after ${elapsed().toFixed(0)}s > BAKE_MAX_S=${MAX_TOTAL_S}`);
}

// Two books that differ only in the order their codes were drawn are the same puzzle.
function signature(book) {
  return book.slice().sort((a, b) => a - b).join(',');
}

// Median off an unsorted list (returns the upper-middle element for even lengths). Separate from
// the `median` used later for the shipped band metadata because that one is fed pre-sorted arrays.
const med = (list) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// Fraction of *rated* books (those that reached minimax) that landed in band. `drawRefused` and
// `drawShort` are drawing notes, not rating verdicts, so they stay out of the denominator.
function acceptanceRate(stats) {
  const rated = (stats.kept || 0) + (stats.light || 0) + (stats.heavy || 0) + (stats.budget || 0);
  return rated ? (100 * (stats.kept || 0)) / rated : NaN;
}

const lots = [];
const report = [];

for (const tier of TIERS) {
  outOfTime(`${tier.key} never started`);
  const seen = new Set();
  const picked = [];
  const stats = {};
  const worst = { ms: 0, nodes: 0 };
  const msList = [];
  const nodeList = [];
  let policyEntries = 0;
  let policyBytes = 0;
  const t0 = Date.now();
  for (let s = 0; picked.length < PER_TIER && s < PER_TIER * 120; s++) {
    const lot = makeLot(`bake-${tier.key}-${s}`, tier, { stats });
    if (!lot) continue;
    const sig = signature(lot.book);
    if (seen.has(sig)) continue;
    seen.add(sig);

    // Re-search from the serialised array, in a fresh solver with nothing inherited.
    const book = JSON.parse(JSON.stringify(lot.book));
    let again;
    try {
      again = minimax(book, { space: SPACE, maxNodes: tier.maxNodes, maxMs: tier.maxMs });
    } catch (err) {
      if (err instanceof BudgetError) { stats.researchGaveUp = (stats.researchGaveUp || 0) + 1; continue; }
      throw err;
    }
    if (again.value !== lot.value) {
      throw new Error(`${tier.key}: value ${lot.value} not reproducible from the book (fresh search says ${again.value})`);
    }
    const bound = infoBound(SPACE, book.length);
    const floor = valueFloor(SPACE, book.length);
    if (again.value < floor || floor < bound) {
      throw new Error(`${tier.key}: value ${again.value} below the bound chain ${again.value} >= ${floor} >= ${bound}`);
    }
    if (again.value !== tier.value) {
      throw new Error(`${tier.key}: band drifted, ${again.value} != ${tier.value}`);
    }
    // [maskHex, guess, value]: the browser looks a subset up and gets both the move the search
    // chose and the exact number of guesses left after it.
    const policy = [...again.policy.entries()]
      .map(([m, g]) => [maskToHex(m), g, again.memo.get(m)])
      .sort((a, b) => (a[0].length - b[0].length) || (a[0] < b[0] ? -1 : 1));
    const row = {
      id: `${tier.key}-${String(picked.length + 1).padStart(2, '0')}`,
      tier: tier.key,
      value: again.value,
      par: again.value,
      size: book.length,
      bound,
      floor,
      R: SPACE.R,
      L: SPACE.L,
      C: SPACE.C,
      secret: lot.secret,
      book,
      policy,
      nodes: again.nodes,
      ms: again.ms,
    };
    const err = validateBook(SPACE, row);
    if (err) throw new Error(`${tier.key}-${row.id}: generator emitted an invalid lot: ${err}`);
    for (const [hex] of row.policy) {
      const m = hexToMask(hex);
      if (maskOf(indicesOf(m)) !== m) throw new Error(`${row.id}: policy mask ${hex} does not round trip`);
    }
    const broken = policyClosed(SPACE, book, policy);
    if (broken) throw new Error(`${row.id}: ${broken}`);
    for (const [hex, g, v] of policy) {
      if (v === undefined) throw new Error(`${row.id}: policy entry ${hex}/${g} has no value`);
      policyBytes += hex.length + 8;
    }
    policyEntries += policy.length;
    msList.push(again.ms);
    nodeList.push(again.nodes);
    if (again.ms > worst.ms) worst.ms = again.ms;
    if (again.nodes > worst.nodes) worst.nodes = again.nodes;
    picked.push(row);
    outOfTime(`${tier.key} stalled`);
    process.stdout.write(`\r${tier.key}: ${picked.length}/${PER_TIER}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
  }
  process.stdout.write(`\n`);
  if (!picked.length) throw new Error(`bake: tier ${tier.key} produced no lot at all — the |S| window is outside what the search certifies`);
  if (picked.length < PER_TIER) console.error(`warn: ${tier.key} only reached ${picked.length} lots`);

  // A tier is played as a curve, so order it by the number that means something here: how many
  // codes the player has to reason over.
  picked.sort((a, b) => a.size - b.size || a.nodes - b.nodes);
  picked.forEach((p, i) => { p.id = `${tier.key}-${String(i + 1).padStart(2, '0')}`; });
  lots.push(...picked);
  report.push({
    tier: tier.key,
    lots: picked.length,
    secs: ((Date.now() - t0) / 1000).toFixed(1),
    accept: acceptanceRate(stats),
    medMs: med(msList),
    worstMs: worst.ms,
    medNodes: med(nodeList),
    worstNodes: worst.nodes,
    policyEntries,
    policyKB: (policyBytes / 1024).toFixed(1),
    stats,
  });
}

// The band the UI prints is measured off the lots that actually shipped, not copied from the
// generator's wish list — so a re-bake that lands lighter or heavier says so out loud.
const median = (sorted) => sorted[sorted.length >> 1];
const meta = TIERS.map((t) => {
  const mine = lots.filter((l) => l.tier === t.key);
  const values = mine.map((l) => l.value).sort((a, b) => a - b);
  const sizes = mine.map((l) => l.size).sort((a, b) => a - b);
  return {
    key: t.key,
    label: t.label,
    value: t.value,
    min: values[0],
    max: values[values.length - 1],
    sizeMin: sizes[0],
    sizeMax: sizes[sizes.length - 1],
    sizeMed: median(sizes),
    boundMax: Math.max(...mine.map((l) => l.bound)),
    nodesMax: Math.max(...mine.map((l) => l.nodes)),
    msMax: Math.max(...mine.map((l) => l.ms)),
    blurb: `${t.value} 次必破 · 码本 ${sizes[0]}-${sizes[sizes.length - 1]} 码`,
  };
});

const lines = [
  '// Generated by tools/bake.mjs — the codebooks in this game are measurements, not opinions.',
  '// `value`/`par` is the exact minimax worst case for the `book` on the same line; `bound` is',
  '// the printed information lower bound ceil(log_R size) and `floor` the sharpened form',
  '// 1 + bound that the search prunes on; `policy` maps a candidate-subset bitmask to',
  '// [guess, value] — the move the search chose and how many guesses it leaves. Re-run',
  '// `node tools/bake.mjs` rather than hand-editing, and `node test/library.test.mjs` fails if',
  '// a line and its numbers ever disagree.',
  `export const BAKED_AT = ${JSON.stringify(new Date().toISOString())};`,
  `export const TIERS_META = ${JSON.stringify(meta)};`,
  'export const LOTS = [',
  ...lots.map((l) => `  ${JSON.stringify(l)},`),
  '];',
  '',
];
const body = lines.join('\n');
const path = join(root, 'js', 'data', 'lots.js');
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, body);

const byTier = {};
for (const l of lots) byTier[l.tier] = (byTier[l.tier] || 0) + 1;
console.log(`wrote ${lots.length} lots (${Object.entries(byTier).map(([k, n]) => `${k}:${n}`).join(' ')}) -> js/data/lots.js`);
for (const r of report) {
  const acc = Number.isFinite(r.accept) ? `${r.accept.toFixed(0)}%` : 'n/a';
  console.log(`${r.tier}: n=${r.lots} accept=${acc} (draw loop ${r.secs}s) · `
    + `counter ms med ${r.medMs.toFixed(1)} / max ${r.worstMs.toFixed(1)} · `
    + `nodes med ${r.medNodes} / max ${r.worstNodes} · `
    + `policy ${r.policyEntries} entries (${r.policyKB} kB) · reject tally ${JSON.stringify(r.stats)}`);
}
console.log(`file: ${(Buffer.byteLength(body) / 1024).toFixed(1)} kB in ${elapsed().toFixed(1)}s total`);
console.log('Measured basis for the |S| ceiling: rerun `node tools/bench.mjs` before changing any window in js/core/make.js.');
