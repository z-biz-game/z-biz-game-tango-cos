// Solver 2 of 2: the same number, from a different algorithm family.
//
// Where js/core/minimax.js computes a value top-down and memoises subsets, this answers a
// *decision* question by depth-limited search:
//
//   canBreakIn(S, k) = does some guess exist whose every answer leaves a set breakable in
//                      k-1 guesses?
//
// and then finds value(S) by iterative deepening: the smallest k for which it answers true.
// There is no memo, no BigInt key, no fail-high value propagation, no per-depth ordering of
// guesses by branch size: a node either returns a boolean or nothing at all, and a false
// verdict is reached by scanning every remaining guess to the end. The only extra knowledge it
// uses is external counting theorems shared with solver 1 — `capacity()` (|S| > R^(k-1) proves
// k guesses cannot suffice) and the trivially true `k >= |S|`, "guess the candidates one at a
// time". Two implementations that agree on 120+ random codebooks from different search
// strategies is the evidence that the printed par is a property of the codebook rather than an
// artefact of one algorithm.
//
// Build time and tests only, like minimax.js: see the performance red line in DESIGN.md 5.

import { SPACE, capacity, valueFloor } from './codes.js';
import { classTable } from './table.js';
import { BudgetError, makeGuard } from './budget.js';

export { BudgetError };

// `book` is an array of code indices in the space. Returns { ok, nodes, ms }.
export function canBreakIn(book, k, opts = {}) {
  const space = opts.space || SPACE;
  const cls = classTable(space);
  const N = space.N;
  const guard = makeGuard('canBreakIn', opts);

  // Book members are tried before the rest of the space: purely a move ordering, it cannot
  // change the answer (a false verdict still scans every guess) but it finds a true verdict
  // sooner, which is the difference between a bake that finishes and one that does not.
  const inBook = new Uint8Array(N);
  for (let i = 0; i < book.length; i++) inBook[book[i]] = 1;
  const guesses = book.slice();
  for (let g = 0; g < N; g++) if (!inBook[g]) guesses.push(g);

  // The answer classes `guess` leaves on `list`, or null as soon as one class is bigger than
  // `cap` — that guess cannot win within the depth budget the caller is holding.
  const cnt = new Int32Array(space.R);
  const used = new Int32Array(space.R);
  const buckets = new Array(space.R);
  function split(list, guess, cap) {
    let touched = 0;
    for (let k = 0; k < space.R; k++) buckets[k] = null;
    for (let i = 0; i < list.length; i++) {
      const f = cls[guess * N + list[i]];
      const v = ++cnt[f];
      if (v > cap) {
        for (let j = 0; j < touched; j++) cnt[used[j]] = 0;
        return null;
      }
      if (v === 1) { used[touched++] = f; buckets[f] = []; }
      buckets[f].push(list[i]);
    }
    for (let j = 0; j < touched; j++) cnt[used[j]] = 0;
    const out = [];
    for (let j = 0; j < touched; j++) out.push(buckets[used[j]]);
    return out;
  }

  function dfs(list, depth) {
    if (list.length <= 1) return list.length <= depth;
    if (depth <= 0) return false;
    if (list.length > capacity(space, depth)) return false;
    if (depth >= list.length) return true;
    guard.tick();
    const cap = capacity(space, depth - 1);
    for (let i = 0; i < guesses.length; i++) {
      const kids = split(list, guesses[i], cap);
      if (kids === null) continue;
      let win = true;
      for (let j = 0; j < kids.length; j++) {
        if (!dfs(kids[j], depth - 1)) { win = false; break; }
      }
      if (win) return true;
    }
    return false;
  }

  const ok = dfs(book.slice(), k);
  return { ok, nodes: guard.nodes, ms: guard.ms() };
}

// value(S) by iterative deepening from the capacity bound upward — the bound is a theorem, so
// starting below it would only waste a full failed search.
export function valueByDecision(book, opts = {}) {
  const space = opts.space || SPACE;
  const start = Math.max(1, valueFloor(space, book.length));
  for (let k = start; k <= book.length; k++) {
    const r = canBreakIn(book, k, opts);
    if (r.ok) return { value: k, nodes: r.nodes, ms: r.ms, from: start };
  }
  throw new BudgetError(`canBreakIn: no k up to |S| = ${book.length} succeeded`);
}
