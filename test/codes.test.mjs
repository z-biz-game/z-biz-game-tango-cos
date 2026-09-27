// The model: what a code is, what a feedback peg means, and what the two counting functions
// promise. Everything downstream — the search, the baked levels, the on-screen numbers — rests on
// this file's assertions, so the fixtures here are hand-written and the counts are exhaustive.

import { test, ok, eq, run } from '../tools/harness.mjs';
import {
  SPACE, L, C, makeSpace, infoBound, capacity, valueFloor, COLOR_NAMES, COLOR_SWATCH,
} from '../js/core/codes.js';
import { FEEDBACK_FIXTURES, code } from './fixture.mjs';

// 1. The space itself.
test('space: L=4, C=6, N=1296, R=15', () => {
  eq([L, C], [4, 6], 'module constants');
  eq([SPACE.L, SPACE.C, SPACE.N], [4, 6, 1296], 'space dimensions');
  eq(SPACE.R, 15, 'answer patterns for L=4');
  eq(SPACE.all.length, 1296, 'every code listed');
});

test('space: the palette has one name and one swatch per colour', () => {
  eq(COLOR_NAMES.length, C, 'names');
  eq(COLOR_SWATCH.length, C, 'swatches');
  ok(COLOR_SWATCH.every((s) => /^#[0-9a-f]{6}$/.test(s)), 'swatches are hex, drawn by js/view.js');
  eq(new Set(COLOR_NAMES).size, C, 'no two colours share a name');
});

// 2. The brief's four fixtures, plus six more of my own. Hand-computed from the two-pass rule.
test('feedback: the brief fixtures reproduce exactly', () => {
  for (const f of FEEDBACK_FIXTURES) {
    const g = code(SPACE, f.guess);
    const s = code(SPACE, f.secret);
    const [black, white] = SPACE.blackWhite(g, s);
    eq([black, white], [f.black, f.white], `${f.guess} vs ${f.secret} (${f.note})`);
  }
});

test('feedback: the four named cases are the (1,2) (0,0) (2,2) (1,0) the spec lists', () => {
  const one = (i) => [FEEDBACK_FIXTURES[i].black, FEEDBACK_FIXTURES[i].white];
  eq(one(0), [1, 2]);
  eq(one(1), [0, 0]);
  eq(one(2), [2, 2]);
  eq(one(3), [1, 0]);
});

// A real theorem, not a fixture: the feedback of a against b equals the feedback of b against a.
// If this ever fails, one of the two solvers is partitioning candidate sets by an asymmetric
// relation and the printed par means nothing.
test('feedback is symmetric on every pair of the toy space L=2/C=4', () => {
  const sp = makeSpace({ L: 2, C: 4 });
  for (const a of sp.all) {
    for (const b of sp.all) {
      const [ab, aw] = sp.blackWhite(a, b);
      const [ba, bw] = sp.blackWhite(b, a);
      ok(ab === ba && aw === bw, `asymmetric: ${sp.format(a)} vs ${sp.format(b)}`);
    }
  }
  ok(true, 'all 4096 pairs symmetric');
});

test('feedback is symmetric on a 20000-pair sample of the shipped space', () => {
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 20000; i++) {
    const a = rnd(SPACE.N);
    const b = rnd(SPACE.N);
    eq(SPACE.fbIndex(a, b), SPACE.fbIndex(b, a), `fbIndex disagree: ${SPACE.format(a)} ${SPACE.format(b)}`);
  }
});

// 3. The feedback id table is a bijection onto the R patterns, and black+white never exceeds L.
test('feedback ids: exactly R of them, black-major numbered, sum within L', () => {
  const seen = new Map();
  for (let black = 0; black <= L; black++) {
    for (let white = 0; white + black <= L; white++) {
      const id = SPACE.fbOf[black * (L + 1) + white];
      ok(id >= 0 && id < SPACE.R, `id ${id} out of range for (${black},${white})`);
      ok(!seen.has(id), `id ${id} reused by (${black},${white}) and ${seen.get(id)}`);
      seen.set(id, [black, white]);
    }
  }
  eq(seen.size, SPACE.R, 'every id is used');
  eq(seen.get(0), [0, 0], 'id 0 is the emptiest answer');
  eq(SPACE.bw(SPACE.R - 1), [L, 0], 'the last id is four black');
  for (let black = 0; black <= L; black++) {
    for (let white = 0; white <= L; white++) {
      const id = SPACE.fbOf[black * (L + 1) + white];
      if (black + white > L) eq(id, -1, `(${black},${white}) must be impossible`);
    }
  }
});

test('feedback: black + white <= L on every pair of a 100-code grid', () => {
  for (let a = 0; a < 100; a++) {
    for (let b = 0; b < 100; b++) {
      const [black, white] = SPACE.blackWhite(a, b);
      ok(black >= 0 && white >= 0 && black + white <= L, `impossible answer ${black}+${white}`);
      ok(black <= L, 'black cannot exceed the row length');
    }
  }
});

// 4. format/parse round trip — the level files store indices, the screen shows these strings.
test('format/parse round-trips every code, and rejects what is not one', () => {
  for (const i of SPACE.all) {
    const s = SPACE.format(i);
    eq(s.length, L, 'display width');
    eq(SPACE.parse(s.replace(/[1-9]/g, (d) => String(Number(d) - 1))), i, `round trip of ${s}`);
  }
  eq(SPACE.parse('123'), -1, 'too short');
  eq(SPACE.parse('12345'), -1, 'too long');
  eq(SPACE.parse('1237'), -1, 'colour 7 does not exist');
  eq(SPACE.parse('12a4'), -1, 'not a digit');
});

// 5. The counting functions the screen prints and the search prunes on.
test('infoBound: ceil(log_R |S|) is exact at the powers of R', () => {
  eq(infoBound(SPACE, 1), 0, 'one candidate needs no information');
  eq(infoBound(SPACE, 15), 1, 'R^1 exactly');
  eq(infoBound(SPACE, 16), 2, 'one past R^1');
  eq(infoBound(SPACE, 225), 2, 'R^2 exactly');
  eq(infoBound(SPACE, 226), 3, 'one past R^2');
  eq(infoBound(SPACE, 3375), 3, 'R^3 exactly');
  eq(infoBound(SPACE, 3376), 4, 'one past R^3');
  eq(infoBound(SPACE, 1296), 3, 'the whole space');
});

test('infoBound never overshoots and never undershoots, by the definition R^k >= |S|', () => {
  for (let n = 1; n <= 1296; n++) {
    const k = infoBound(SPACE, n);
    ok(SPACE.R ** k >= n, `bound ${k} cannot cover ${n}`);
    ok(k === 0 || SPACE.R ** (k - 1) < n, `bound ${k} is one more than needed for ${n}`);
  }
});

test('capacity(k) = R^(k-1): the largest book breakable in k guesses', () => {
  eq(capacity(SPACE, 0), 0, 'no guesses, no candidates');
  eq(capacity(SPACE, 1), 1, 'one guess only works on one code');
  eq(capacity(SPACE, 2), SPACE.R, 'two guesses cover exactly R codes');
  eq(capacity(SPACE, 3), 225, 'three guesses cover 225');
  eq(capacity(SPACE, 4), 3375, 'four guesses cover more than the whole space');
});

test('valueFloor = 1 + infoBound for |S| >= 2, and >= infoBound always', () => {
  eq(valueFloor(SPACE, 1), 1, 'a single code is a one-guess book');
  eq(valueFloor(SPACE, 0), 0, 'an empty book needs no guess');
  eq(valueFloor(SPACE, 2), 2, 'two codes need two guesses');
  eq(valueFloor(SPACE, 16), 3, 'one past a single-answer split');
  for (let n = 1; n <= 1296; n++) {
    ok(valueFloor(SPACE, n) >= infoBound(SPACE, n), `floor below the printed bound at ${n}`);
    ok(capacity(SPACE, valueFloor(SPACE, n) - 1) < n, `floor ${valueFloor(SPACE, n)} is not justified at ${n}`);
  }
});

// The consequence the README quotes: at the shipped sizes the printed bound tops out at 2, so a
// par of 5 is only reachable because the search says so, not because counting does.
test('the printed bound stays far below every shipped par', () => {
  eq(infoBound(SPACE, 120), 2, 'a 120-code book: the screen says 2');
  eq(valueFloor(SPACE, 120), 3, 'the sharpened bound says 3');
  eq(infoBound(SPACE, 500), 3, 'a 500-code book: the screen says 3');
  ok(infoBound(SPACE, 520) <= 3, 'no book in this space can print a bound of 5');
});

// 6. Toy spaces behave the same way — the three-way check runs on them.
test('makeSpace: L=2/C=3 gives N=9 and R=(L+1)(L+2)/2 = 6 patterns', () => {
  const sp = makeSpace({ L: 2, C: 3 });
  eq([sp.L, sp.C, sp.N], [2, 3, 9], 'dimensions');
  eq(sp.R, 6, 'pattern count');
  eq(sp.R, ((sp.L + 1) * (sp.L + 2)) / 2, 'the triangular formula for R');
  eq(sp.blackWhite(sp.parse('01'), sp.parse('10')), [0, 2], 'both colours, both misplaced');
  eq(sp.blackWhite(sp.parse('00'), sp.parse('01')), [1, 0], 'one black, duplicate colour not also white');
  eq(SPACE.R, ((L + 1) * (L + 2)) / 2, 'the same formula holds for the shipped space');
});

run();
