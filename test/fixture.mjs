// Hand-written expectations. These are the fixtures the whole repo is anchored to: they were
// worked out on paper from the two-pass rule before any code existed, and they are the reason a
// refactor cannot quietly redefine what a feedback peg means. If one of these ever changes, the
// change is a bug report, not an update.
//
// The strings are the ones the brief uses, in human form: `1123` means four pegs coloured
// amber-amber-teal-rose, i.e. palette indices 0,0,1,2. `code()` below is the only place that
// converts them, so a mistake in the convention shows up everywhere at once rather than in one
// silently-passing test.

import { SPACE, makeSpace } from '../js/core/codes.js';

export function code(space, display) {
  const s = String(display).replace(/[1-9]/g, (d) => String(Number(d) - 1));
  const idx = space.parse(s);
  if (idx < 0) throw new Error(`not a code in this space: ${display}`);
  return idx;
}

// guess / secret / (black, white). The first four are the brief's own examples.
export const FEEDBACK_FIXTURES = [
  { guess: '1123', secret: '1234', black: 1, white: 2, note: '一个位置对，两个颜色对但错位' },
  { guess: '1111', secret: '2222', black: 0, white: 0, note: '没有共用颜色：重复计数法会错报 4 白' },
  { guess: '1122', secret: '2112', black: 2, white: 2, note: '两黑两白，重复颜色的经典坑' },
  { guess: '1234', secret: '1111', black: 1, white: 0, note: '共用一种颜色只算一次' },
  // Extra fixtures of my own, each pinning a different failure mode:
  { guess: '1234', secret: '4321', black: 0, white: 4, note: '全部错位' },
  { guess: '1111', secret: '1111', black: 4, white: 0, note: '全中就是全中，不再补白' },
  { guess: '1122', secret: '1221', black: 2, white: 2, note: '第 1、3 位对中，剩两位互换了颜色' },
  // Hand recount 2026-09-27 (finisher): the earlier note here read (1,2) and forgot that the
  // `3` in guess position 4 sits on the `3` of secret position 4 — that is a SECOND black, not a
  // white. Two passes on paper: black = positions 2 and 4 = 2; remaining guess {1,2}, remaining
  // secret {2,3}, one shared colour -> white = 1. Expectation (2,1); implementation agrees.
  { guess: '1223', secret: '2233', black: 2, white: 1, note: '两个位置对（2 号位与 4 号位），剩余位只共用一色' },
  { guess: '6666', secret: '1111', black: 0, white: 0, note: '第 6 色（下标 5）也要能解析' },
  { guess: '1234', secret: '1243', black: 2, white: 2, note: '两对两错' },
];

// Spaces small enough that a brute-force game tree (test/naive.mjs) still finishes, used for the
// three-way agreement check. The shipped space is L=4/C=6; these are not played, only proved on.
export const SMALL_SPACES = [
  { name: 'L2C3', space: makeSpace({ L: 2, C: 3 }) },
  { name: 'L2C4', space: makeSpace({ L: 2, C: 4 }) },
];

// A fixed set of codebooks for the cross-checks, written as arrays of display strings. The
// `value` next to each was computed by both build-time solvers and then frozen here, so a solver
// that drifts has to disagree with a number sitting in this file in plain text.
//
// `1111..1116` is the one worth reading twice: six codes that differ ONLY in the last peg, and
// the answer is three guesses. Neither bound on the screen explains that — ceil(log_15 6) = 1 and
// even the sharpened 1 + ceil(log_15 6) = 2 — so the third guess is a fact about how feedback
// works on this particular book, which is precisely the kind of thing a search is for and an
// information count is not.
export const KNOWN_BOOKS = [
  { book: ['1234', '4321', '1111'], value: 2, why: '存在一个码对三者给出三种不同反馈' },
  { book: ['1234', '5566', '1356', '2461'], value: 2, why: '四个互不同色的码也能一次分开' },
  { book: ['1111', '1112', '1113', '1114', '1115', '1116'], value: 3, why: '只差最后一位的六个码：一次反馈分不开六种' },
  { book: ['1111', '1112', '1113', '1114', '1115', '1116', '1122'], value: 3, why: '再加一个改动第三位的码，仍然三次' },
  { book: ['1111', '1112', '1121', '1211', '2111', '2222', '3333'], value: 3, why: '混入两种颜色的七个码' },
];

export { SPACE };
