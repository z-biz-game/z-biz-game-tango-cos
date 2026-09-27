// Solver 1 of 2: exact worst-case value of a codebook, top-down with memoisation.
//
//   value(S) = |S|                                             when |S| <= 1
//            = 1 + min_over_guesses max_over_answers value(S_answer)   otherwise
//
// `value(S)` is the number the game prints as par: with codebook S the player can always break
// the code in that many guesses, and no strategy guarantees better. Two things make it exact
// rather than an estimate: the guess loop runs over the WHOLE code space (the player may guess
// any code, not only book members — the rule the printed number is computed under, see
// DESIGN.md 2.2), and the answer loop runs over every answer a guess can actually produce on
// this S. No scoring function anywhere.
//
// Four prunes, and each one is an inequality a reader can check on their own:
//   * MEMO on the BigInt bitmask of the candidate subset (js/core/book.js): a subset reached by
//     two different guess sequences is the same subproblem.
//   * FLOOR: value(S) >= valueFloor(|S|) = 1 + ceil(log_R |S|) for |S| >= 2, from
//     js/core/codes.js. A node that reaches its floor stops — the number cannot get better,
//     and the reason is an external theorem, not this search's own opinion.
//   * CAP: to beat `best`, a guess needs every branch to have value <= best-2, hence (capacity)
//     every branch of size <= capacity(best-2). Guesses are visited in ascending order of their
//     largest branch, so the loop stops dead at that cap.
//   * BOUNDS (the one that pays): a child is never asked "what is your value?", only "can you
//     stay under `limit`?". A child whose FLOOR already reaches the limit is condemned without
//     any scanning at all, which is what turns a 100-code book from seconds into milliseconds.
//     Measured in tools/bench.mjs.
//
// Build time and tests only (performance red line: DESIGN.md 5). It throws BudgetError instead
// of returning a plausible number when the node or time budget runs out, so an unmeasured size
// can never be baked as a measured one.

import { SPACE, valueFloor, capacity } from './codes.js';
import { maskOf, indicesOf, hexToMask } from './book.js';
import { classTable } from './table.js';
import { BudgetError, makeGuard } from './budget.js';

export { BudgetError };

export function minimax(book, opts = {}) {
  const space = opts.space || SPACE;
  const cls = classTable(space);
  const N = space.N;
  const R = space.R;
  const size = book.length;
  const memo = new Map();
  const policy = new Map();
  const guard = makeGuard('minimax', opts);
  const ABOVE = size + 2; // any limit above every achievable value: ask for the exact number

  const cnt = new Int32Array(R);
  const used = new Int32Array(R);
  // One largest-branch array per search depth: a node keeps its own ordering while it recurses,
  // so the scan is never clobbered by a child. Depth is bounded by value(S) (a node only
  // recurses into strictly smaller subsets), so this stays a few dozen kilobytes.
  const branchSizes = [];
  function sizesAt(depth) {
    let buf = branchSizes[depth];
    if (!buf) buf = branchSizes[depth] = new Int32Array(N);
    return buf;
  }

  // Same per-depth trick for the counting sort that turns "smallest biggest-class first" into a
  // linear scan instead of a scan per candidate size.
  const sorts = [];
  function orderAt(depth) {
    let s = sorts[depth];
    if (!s) s = sorts[depth] = { hist: new Int32Array(size + 3), order: new Int32Array(N) };
    return s;
  }

  // `buf` holds each guess's largest answer class; the returned array lists every guess ordered
  // by it, ascending.
  function sortedGuesses(depth, buf) {
    const s = orderAt(depth);
    const hist = s.hist;
    const order = s.order;
    hist.fill(0);
    for (let g = 0; g < N; g++) hist[buf[g]]++;
    let acc = 0;
    for (let w = 0; w < hist.length; w++) { const c = hist[w]; hist[w] = acc; acc += c; }
    for (let g = 0; g < N; g++) { const w = buf[g]; order[hist[w]++] = g; }
    return order;
  }

  // Size of the largest answer class this guess would leave, over `list`.
  //
  // A guess whose biggest class *is* the whole list teaches nothing: its worst branch is the
  // node we are standing in, so it can never beat the alternatives and would recurse into
  // itself forever (the memo key is only written once a node is solved). Reporting n+1 keeps
  // those out of the visit loop below, which only ever walks sizes 1..n. Dropping them cannot
  // change the minimum, because an informative guess always exists — guessing a candidate
  // splits that candidate off into an answer class of its own.
  function maxSize(guess, list) {
    let max = 0;
    let touched = 0;
    const base = guess * N;
    for (let k = 0; k < list.length; k++) {
      const f = cls[base + book[list[k]]];
      const v = ++cnt[f];
      if (v > max) max = v;
      if (v === 1) used[touched++] = f;
    }
    for (let i = 0; i < touched; i++) cnt[used[i]] = 0;
    return max === list.length ? list.length + 1 : max;
  }

  // The candidate subsets a guess leaves, largest first: the biggest branch decides max_f, so
  // meeting it first is what lets the abort below fire before the cheap branches are explored.
  function branches(guess, list) {
    const out = [];
    const base = guess * N;
    for (let k = 0; k < list.length; k++) {
      const code = list[k];
      const f = cls[base + book[code]];
      (out[f] || (out[f] = [])).push(code);
    }
    const kept = out.filter(Boolean);
    if (kept.length > 1) kept.sort((a, b) => b.length - a.length);
    return kept;
  }

  // Returns value(list) when that is below `limit`, otherwise `limit` itself (fail-high: "not
  // better than you asked"). A result below the limit is exact, and only exact results are
  // memoised — a bound cached as a value would be the fake number this file promises not to
  // produce. The same rule decides the policy entry: it is written only together with an exact
  // value AND a witness guess whose every child was itself solved exactly, which is what makes
  // the baked strategy closed (policyClosed below checks exactly that, and js/core/game.js can
  // therefore hand out a real optimal move instead of a plausible one).
  function search(list, depth, limit) {
    const n = list.length;
    if (n <= 1) return n < limit ? n : limit;
    const floor = valueFloor(space, n);
    if (floor >= limit) return limit; // the theorem alone condemns this subset: nothing scanned
    const key = maskOf(list);
    const seen = memo.get(key);
    if (seen !== undefined) return seen < limit ? seen : limit;
    guard.tick();

    // Two upper bounds on value(list), take the tighter:
    //   n           — guess the candidates one at a time, worst case n guesses;
    //   sStar + 1   — the best split available leaves a biggest class of sStar codes, whose
    //                 value is at most sStar by the same one-at-a-time argument.
    // Guesses are then visited in ascending order of that largest class, via a counting sort
    // over `want` (a sort, not a filter: the order is what lets the loop stop early).
    const buf = sizesAt(depth);
    let sStar = n + 1;
    let gStar = -1;
    for (let g = 0; g < N; g++) {
      const s = maxSize(g, list);
      buf[g] = s;
      if (s < sStar) { sStar = s; gStar = g; }
    }
    const order = sortedGuesses(depth, buf);

    let best = Math.min(n, sStar + 1, limit);
    let witness = -1;

    // This loop only ever LOWERS `best`, and only from a guess whose every child came back exact
    // — so the guess that produced the last lowering witnesses the value the loop ends on.
    for (let i = 0; i < N; i++) {
      const g = order[i];
      const want = buf[g];
      // A guess whose largest class is the whole list teaches nothing (see maxSize); past the cap
      // no unvisited guess can beat `best` either: to land at value <= best-1 it needs every child
      // of value <= best-2, hence of size <= capacity(best-2).
      if (want > n) break;
      if (want > capacity(space, best - 2)) break;
      if (best === floor) break; // at the theorem's own floor: nothing lower exists to find
      const kids = branches(g, list);
      let worst = 0;
      let failed = false;
      for (let k = 0; k < kids.length; k++) {
        const v = search(kids[k], depth + 1, best - 1);
        if (v >= best - 1) { failed = true; break; } // this guess cannot beat best
        if (v > worst) worst = v;
      }
      if (failed) continue;
      if (worst + 1 < best) {
        best = worst + 1;
        witness = g; // a guess is already a space index, unlike a candidate
      }
    }
    if (best < limit && witness < 0) witness = repairWitness(gStar, list, depth, best);
    if (best < limit && witness >= 0) {
      // `best` is the true value: it is achieved (the witness, whose children are all solved
      // exactly and memoised), and every guess that could have beaten it was visited while every
      // guess that was not visited has a branch whose size alone rules it out.
      memo.set(key, best);
      policy.set(key, witness);
    }
    return best < limit && witness >= 0 ? best : limit;
  }

  // When the loop above never improved on the initial bound `sStar + 1`, that bound still needs a
  // witness before it may be memoised as a value. `gStar` is it: its biggest answer class has
  // sStar codes, and any book of m codes is breakable in m guesses (guess one candidate per
  // guess — the (L,0) answer isolates it and every other class is smaller), so each of gStar's
  // children has value <= sStar = best - 1 and comes back exact below `best`. Asking for those
  // exact values is also what writes the child memo/policy entries `policyClosed` demands, which
  // is why this runs before memoisation instead of as an afterthought. A child that somehow
  // reaches `best` contradicts the arithmetic above, so return -1 and let the node go unsolved:
  // tools/bake.mjs then fails its closure check rather than publishing a move we cannot vouch for.
  function repairWitness(guess, list, depth, best) {
    const kids = branches(guess, list);
    for (let k = 0; k < kids.length; k++) {
      if (search(kids[k], depth + 1, best) >= best) return -1;
    }
    return guess;
  }

  const root = [];
  for (let i = 0; i < size; i++) root.push(i);
  const value = search(root, 0, ABOVE);
  if (value > size) throw new BudgetError(`minimax: no value within ${size} guesses`);
  return { value, nodes: guard.nodes, memo, policy, ms: guard.ms() };
}

// Candidate subsets a guess leaves, as { fb, list } with `list` in book-relative indices.
export function branchesOf(space, book, guess, list) {
  const cls = classTable(space);
  const buckets = new Map();
  const base = guess * space.N;
  for (let k = 0; k < list.length; k++) {
    const f = cls[base + book[list[k]]];
    if (!buckets.has(f)) buckets.set(f, []);
    buckets.get(f).push(list[k]);
  }
  return [...buckets.entries()].map(([fb, codes]) => ({ fb, list: codes }));
}

// The strict-decrease property the hint feature rests on: under the policy's first guess, every
// answer leaves a book whose value is at most value(S) - 1. `ok: false` means the search
// contradicts itself, so test/minimax.test.mjs asserts this on every random book it tries
// instead of trusting a comment.
export function checkDescent(space, book, policy, value) {
  const root = [];
  for (let i = 0; i < book.length; i++) root.push(i);
  const first = policy.get(maskOf(root));
  if (first === undefined) return { ok: false, reason: 'no policy entry for the full book' };
  const rows = branchesOf(space, book, first, root).map(({ fb, list }) => ({
    fb,
    size: list.length,
    value: list.length <= 1 ? list.length : minimax(list.map((k) => book[k]), { space }).value,
  }));
  const worst = rows.reduce((a, r) => Math.max(a, r.value), 0);
  return { ok: worst <= value - 1, first, worst, rows };
}

// The same statement, for the WHOLE baked strategy instead of only its first ply — and without
// re-searching anything, so it is cheap enough to run on every lot in js/data/lots.js in a test.
//
// `entries` is the serialised policy: [maskHex, guess, value] triples, exactly what
// tools/bake.mjs writes and js/core/library.js reads back. The check is two pure lookups per
// entry and says:
//   * CLOSED — for every subset the strategy knows, each answer that answer-pattern can give
//     leaves a subset the strategy also knows (or a single candidate, which needs no strategy);
//   * DESCENDING — that surviving subset has value <= parent value - 1, i.e. the advertised
//     number of guesses really goes down one per ply no matter which feedback arrives.
// Together those two are what makes "提示是最优的" a checked claim rather than a promise: a
// player who follows the printed strategy can never be told there are more guesses left than
// the number said before they guessed. Returns an error string, or null when it holds.
export function policyClosed(space, book, entries) {
  const byMask = new Map();
  for (const [hex, guess, value] of entries) byMask.set(hexToMask(hex), { guess, value });
  const root = [];
  for (let i = 0; i < book.length; i++) root.push(i);
  const rootMask = maskOf(root);
  const rootEntry = byMask.get(rootMask);
  if (!rootEntry) return '策略表没有整本手册这一项';
  for (const [mask, entry] of byMask) {
    const list = indicesOf(mask);
    if (entry.value < 2) return `策略项 value=${entry.value} 但子集有 ${list.length} 个候选`;
    for (const { fb, list: kid } of branchesOf(space, book, entry.guess, list)) {
      const v = kid.length <= 1 ? kid.length : (byMask.get(maskOf(kid)) || {}).value;
      if (v === undefined) return `策略不闭合：${entry.guess} 收到反馈 ${fb} 之后的子集不在表里`;
      if (v > entry.value - 1) return `策略不下降：value=${entry.value} 的子集走了 ${entry.guess} 之后还剩 value=${v}`;
    }
  }
  return null;
}
