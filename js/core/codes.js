// The code space: what a code is, and what a feedback peg means. Everything else in the
// game — the solver, the generator, the screen — is a function of these two tables.
//
// A code is `L` digits in `0..C-1` packed as a base-C integer (most significant digit
// first), so code 1123 with C=6 is index 1*216 + 1*36 + 2*6 + 3 = 267 and the whole space
// is `0..C^L-1`. Digits are stored as one row of `L` bytes per code plus one row of `C`
// colour counts per code, which is what makes the feedback O(L + C) with no allocation.
//
// FEEDBACK IS THE TWO-PASS RULE, AND THE ORDER MATTERS:
//   pass 1 — black: right digit, right position.
//   pass 2 — white: on the *remaining* positions only, per colour take min(#guess, #secret)
//            and sum. `white = common - black` is the same statement, because a position
//            counted black contributes 1 to both multisets.
// Doing it the other way round (count colour matches first, then subtract) is the classic
// duplicate-colour bug: `1111` vs `2222` becomes (0,4) instead of (0,0), and `1122` vs
// `2112` stops being (2,2). `test/codes.test.mjs` holds those fixtures with hand-written
// expectations so a refactor cannot quietly redefine the rule.
//
// `R` = the number of distinct (black, white) outcomes with black + white <= L, which for
// L=4 is 15. R is the alphabet of the answers the code-maker can give, so it is also the
// base of the information bound in `infoBound` — the one number in this game that is a
// theorem rather than a measurement.
//
// Pure: no DOM, no window, no mutation of arguments. `makeSpace` is a factory so the tests
// can run the same three solvers on a toy space (L=2, C=3) where a brute-force game tree is
// still writable; the shipped game uses the single `SPACE` at the bottom.

export const L = 4;
export const C = 6;

// The palette. Six colours, drawn as canvas fills in js/view.js — no image files.
export const COLOR_NAMES = ['琥珀', '青', '玫', '苔', '紫', '霜'];
export const COLOR_SWATCH = ['#e0a63c', '#4fb3d1', '#d1618b', '#5d9c63', '#8a6fc0', '#cfd6e0'];

export function makeSpace(opts = {}) {
  const l = opts.L || L;
  const c = opts.C || C;
  const n = c ** l;

  // Feedback ids: (black, white) with black + white <= l, enumerated black-major. The
  // numbering is the storage format for baked lots, so it must never be reshuffled — a
  // re-numbered table would silently reinterpret every feedback peg already baked.
  const fbOf = new Int16Array((l + 1) * (l + 1)).fill(-1);
  const bwOf = [];
  let r = 0;
  for (let black = 0; black <= l; black++) {
    for (let white = 0; white + black <= l; white++) {
      fbOf[black * (l + 1) + white] = r;
      bwOf.push([black, white]);
      r++;
    }
  }

  const digits = new Int8Array(n * l);
  const counts = new Int8Array(n * c);
  for (let i = 0; i < n; i++) {
    let x = i;
    for (let p = l - 1; p >= 0; p--) {
      const d = x % c;
      x = (x - d) / c;
      digits[i * l + p] = d;
      counts[i * c + d]++;
    }
  }

  // (black, common) from the tables above, then white = common - black: the two passes.
  function score(a, b) {
    let black = 0;
    for (let p = 0; p < l; p++) if (digits[a * l + p] === digits[b * l + p]) black++;
    let common = 0;
    for (let k = 0; k < c; k++) {
      const ga = counts[a * c + k];
      const gb = counts[b * c + k];
      common += ga < gb ? ga : gb;
    }
    return [black, common - black];
  }

  function fbIndex(a, b) {
    const [black, white] = score(a, b);
    return fbOf[black * (l + 1) + white];
  }

  function format(i) {
    let s = '';
    for (let p = 0; p < l; p++) s += digits[i * l + p] + 1;
    return s;
  }

  // Accepts '1123' or '0123'-style digit strings; rejects anything that is not a code.
  function parse(str) {
    const s = String(str);
    if (s.length !== l) return -1;
    let i = 0;
    for (let p = 0; p < l; p++) {
      const ch = s.charCodeAt(p) - 48;
      if (ch < 0 || ch >= c) return -1;
      i = i * c + ch;
    }
    return i;
  }

  const all = [];
  for (let i = 0; i < n; i++) all.push(i);

  const space = {
    L: l, C: c, N: n, R: r,
    digits, counts,
    fbOf,
    bw: (id) => bwOf[id],
    blackWhite: score,
    fbIndex,
    format,
    parse,
    all,
  };
  return space;
}

// ceil(log_R |S|): after k answers the player can have learned at most R^k branches' worth
// of distinction, so a set bigger than R^k cannot be broken in k guesses. This is computed
// by repeated multiplication rather than Math.log so it is exact at the boundaries
// (|S| = R^k gives k, |S| = R^k + 1 gives k+1) — float logs get both of those wrong.
//
// This is the bound the game PRINTS, because it is the one the spec states and the one a
// reader can re-derive in their head from two numbers on screen.
export function infoBound(space, size) {
  let k = 0;
  let cap = 1;
  while (cap < size) {
    cap *= space.R;
    k++;
  }
  return k;
}

// capacity(space, k) = an upper bound on |S| for which k guesses suffice.
//   k = 1 -> 1 code (you can only be sure in one guess if there is one candidate);
//   k > 1 -> R * capacity(k-1), because one guess splits S into at most R answer classes,
//            each of which must itself be breakable in k-1 guesses.
// So capacity(k) = R^(k-1). It is one power of the same counting argument as `infoBound` and
// strictly stronger than it, which is what makes it the prune the solvers actually use:
// |S| > capacity(k) proves value(S) > k without searching at all.
export function capacity(space, k) {
  if (k <= 0) return 0;
  let v = 1;
  for (let i = 1; i < k; i++) v *= space.R;
  return v;
}

// valueFloor(space, n) = a lower bound on value(S) for |S| = n, from capacity():
// n > capacity(k) => value > k. Writing it out: for n >= 2 the bound is 1 + ceil(log_R n),
// and it is exact at the boundaries (n = R gives 2, n = R+1 gives 3). `infoBound` is the same
// family one power looser, so value >= valueFloor >= infoBound always holds — the tests assert
// both, and the search is allowed to stop at valueFloor.
export function valueFloor(space, n) {
  if (n <= 1) return n;
  return 1 + infoBound(space, n);
}

// The shipped space: L=4 pegs, C=6 colours, N=1296 codes, R=15 answer patterns.
export const SPACE = makeSpace();
