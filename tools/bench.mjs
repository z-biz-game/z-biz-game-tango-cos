// The measuring rig. This is the instrument the shipped |S| ceiling was read off, kept in
// the repo so the published numbers stay checkable — run it before changing any size window.
//
//   node tools/bench.mjs
//   SIZES=8,16,24 BOOKS=12 BENCH_MS=5000 node tools/bench.mjs
//   DECIDE=1 node tools/bench.mjs        # also cross-check solver 2 (slow)
//
// It answers three separate questions, all of which the README quotes:
//   1. how long does an exact minimax take per codebook size (the ceiling),
//   2. do the two solver families agree on random books, and what does each cost,
//   3. what does the browser's one live computation — shrinking the candidate list — cost.
// Nothing here is a pass/fail gate; test/*.test.mjs are the gates.

import { SPACE, infoBound } from '../js/core/codes.js';
import { rngFrom } from '../js/core/rng.js';
import { minimax, BudgetError } from '../js/core/minimax.js';
import { valueByDecision } from '../js/core/decide.js';
import { randomBook } from '../js/core/make.js';
import { consistent } from '../js/core/book.js';

const SIZES = (process.env.SIZES || '8,12,16,20,24,30,40,60,90,120').split(',').map(Number);
const BOOKS = Number(process.env.BOOKS || 10);
const MS = Number(process.env.BENCH_MS || 5000);
const NODES = Number(process.env.BENCH_NODES || 400000);
const WITH_DECIDE = process.env.DECIDE === '1';

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

console.log(`space: L=${SPACE.L} C=${SPACE.C} N=${SPACE.N} R=${SPACE.R}   budget: ${MS}ms / ${NODES} nodes per book`);
console.log('');
console.log(['size', 'bound', 'value min/med/max', 'ms min/med/max', 'nodes med/max', 'over budget'].map((h, i) => h.padEnd(i < 2 ? 7 : 20)).join(''));

const rows = [];
for (const size of SIZES) {
  const values = [];
  const times = [];
  const nodes = [];
  let over = 0;
  for (let b = 0; b < BOOKS; b++) {
    const rng = rngFrom(`bench-${size}-${b}`);
    const book = randomBook(SPACE, rng, size, {}).book;
    const t0 = performance.now();
    try {
      const r = minimax(book, { space: SPACE, maxNodes: NODES, maxMs: MS });
      values.push(r.value);
      times.push(performance.now() - t0);
      nodes.push(r.nodes);
    } catch (err) {
      if (!(err instanceof BudgetError)) throw err;
      over++;
    }
  }
  values.sort((a, b) => a - b);
  times.sort((a, b) => a - b);
  nodes.sort((a, b) => a - b);
  const fmt = (arr, f = (x) => String(x)) => (arr.length ? `${f(pct(arr, 0))}/${f(pct(arr, 0.5))}/${f(pct(arr, 1))}` : '—');
  console.log([
    String(size).padEnd(7),
    String(infoBound(SPACE, size)).padEnd(7),
    fmt(values).padEnd(20),
    fmt(times, (x) => x.toFixed(1)).padEnd(20),
    fmt(nodes.slice(0).map((x) => Math.round(x))).padEnd(16),
    `${over}/${BOOKS}`,
  ].join(''));
  rows.push({ size, values, times });

  if (WITH_DECIDE) {
    let agree = 0;
    const dt = [];
    for (let b = 0; b < Math.min(3, BOOKS); b++) {
      const rng = rngFrom(`bench-${size}-${b}`);
      const book = randomBook(SPACE, rng, size, {}).book;
      const t0 = performance.now();
      try {
        const a = minimax(book, { space: SPACE, maxNodes: NODES, maxMs: MS }).value;
        const d = valueByDecision(book, { space: SPACE, maxNodes: NODES, maxMs: MS });
        if (d.value === a) agree++;
        dt.push(performance.now() - t0);
      } catch (err) {
        if (!(err instanceof BudgetError)) throw err;
      }
    }
    if (dt.length) console.log(`        solver2: ${agree}/${dt.length} agree, ms ${Math.max(...dt).toFixed(0)} max`);
  }
}

// The one number the front end is responsible for: candidates left after an answer. It runs
// on every submit, in the browser, so it has to be boring-fast.
console.log('');
console.log('browser-side cost (js/core/book.js consistent, |S| -> filtered candidates):');
for (const size of SIZES) {
  if (size < 2) continue;
  const rng = rngFrom(`bench-live-${size}`);
  const book = randomBook(SPACE, rng, size, {}).book;
  const guess = rng.int(SPACE.N);
  const t0 = performance.now();
  let kept = 0;
  for (let i = 0; i < 2000; i++) kept = consistent(SPACE, book, guess, rng.int(SPACE.R)).length;
  const per = ((performance.now() - t0) / 2000);
  console.log(`  |S|=${String(size).padStart(3)}  ${per.toFixed(4)} ms per shrink   (last kept ${kept})`);
}
console.log('');
console.log(`Ceiling rule: keep the largest |S| whose med/max stays inside the budget above, then write it into README / DESIGN. Not a claim to be adjusted to fit a wish.`);
