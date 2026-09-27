// The save file, under node — where there is no `window` at all. That is not a degenerate case
// to be skipped: it is the exact situation file://, private windows and locked-down browsers
// produce, and js/core/storage.js claims to keep working there. Every call below runs through
// the try/catch around a missing global, so these assertions double as the degrade test.
//
// The two monotonicities are the whole contract and are written OUT OF ORDER on purpose:
//   best only goes DOWN, unlock only goes UP. A save that lets a worse run erase a better one
//   (or a re-play hide a level you already earned) is a lie generator, so each is asserted by
//   trying to break it first.

import { test, ok, eq, run } from '../tools/harness.mjs';
import { store, persistent } from '../js/core/storage.js';

test('no window: persistent() says false and nothing throws', () => {
  eq(typeof window, 'undefined', 'this suite is only meaningful without a DOM global');
  eq(persistent(), false, 'with no localStorage to probe, the answer is memory-only');
});

test('reset gives a blank slate', () => {
  store.reset();
  eq(store.records, {}, 'no records');
  eq(store.unlocked, 1, 'one level open');
  eq(store.daily, {}, 'no daily marks');
  eq(store.totals(), { solved: 0, atPar: 0, breaks: 0, hints: 0 }, 'counters at zero');
});

test('best only goes DOWN: a worse solve cannot erase a better one', () => {
  store.reset();
  let r = store.solve('x-1', { guesses: 5, par: 3, hints: 1, rows: 5, won: true });
  eq([r.best, r.solved, r.plays, r.par], [5, true, 1, false], 'first solve, over par');
  r = store.solve('x-1', { guesses: 7, par: 3, hints: 0, rows: 7, won: true });
  eq([r.best, r.plays], [5, 2], 'a worse replay keeps the best at 5');
  r = store.solve('x-1', { guesses: 4, par: 3, hints: 0, rows: 4, won: true });
  eq(r.best, 4, 'an improvement takes it down');
  r = store.solve('x-1', { guesses: 9, par: 3, hints: 2, rows: 9, won: false });
  eq([r.best, r.solved, r.plays], [4, true, 4], 'a loss bills the play but changes nothing else');
  eq(store.record('x-2'), null, 'an unsolved id reads as null, not as a zero record');
});

test('the at-par flag sticks once earned, and never lights without a win', () => {
  store.reset();
  let r = store.solve('x-3', { guesses: 6, par: 4, hints: 0, rows: 6, won: true });
  eq(r.par, false, 'over par is a solve, not a par run');
  r = store.solve('x-3', { guesses: 4, par: 4, hints: 0, rows: 4, won: true });
  eq(r.par, true, 'matching par earns the flag');
  r = store.solve('x-3', { guesses: 8, par: 4, hints: 0, rows: 8, won: false });
  eq(r.par, true, 'and a later loss cannot un-earn it');
  r = store.solve('x-4', { guesses: 1, par: 9, hints: 0, rows: 1, won: false });
  eq([r.par, r.solved, r.best], [false, false, null], 'a loss never fakes best=1');
});

test('stats accumulate across runs and only for what they count', () => {
  store.reset();
  store.solve('x-5', { guesses: 2, par: 3, hints: 1, rows: 2, won: true });
  store.solve('x-5', { guesses: 4, par: 3, hints: 2, rows: 4, won: false });
  store.solve('x-6', { guesses: 3, par: 3, hints: 0, rows: 3, won: true });
  const s = store.stats;
  eq([s.breaks, s.par, s.guesses, s.hints, s.rows], [2, 2, 9, 3, 9], 'breaks/par/guesses/hints/rows');
  eq(store.totals(), { solved: 2, atPar: 2, breaks: 2, hints: 3 }, 'totals read the same store');
});

test('unlock only goes UP: replaying level 3 cannot hide level 9 again', () => {
  store.reset();
  eq(store.unlock(4), 4, 'first unlock opens to 4');
  eq(store.unlock(2), 4, 'a lower ask is ignored');
  eq(store.unlock(9), 9, 'a higher one moves');
  eq(store.unlock(9), 9, 'idempotent at the top');
  eq(store.unlocked, 9, 'and the getter agrees');
});

test('markDaily keeps the better run and knows today', () => {
  store.reset();
  const day = '2026-01-01';
  let m = store.markDaily(day, 'x-7', { guesses: 4 });
  eq([m.done, m.guesses, m.id], [true, 4, 'x-7'], 'first mark');
  m = store.markDaily(day, 'x-7', { guesses: 6 });
  eq(m.guesses, 4, 'a worse re-run cannot inflate the day');
  m = store.markDaily(day, 'x-7', { guesses: 2 });
  eq(m.guesses, 2, 'a better one is taken');
  m = store.markDaily(day, 'x-7', null);
  eq([m.done, m.guesses], [true, 2], 'a null result keeps the record');
  eq(store.dailyDone(day).guesses, 2, 'dailyDone reads it back');
  eq(store.dailyDone('2026-01-02'), null, 'another day is untouched');
});

test('reset wipes everything, including what was just written', () => {
  store.solve('x-8', { guesses: 3, par: 3, hints: 1, rows: 3, won: true });
  store.unlock(5);
  store.markDaily('2026-02-02', 'x-8', { guesses: 3 });
  store.reset();
  eq([store.unlocked, Object.keys(store.records).length, Object.keys(store.daily).length, store.stats.breaks], [1, 0, 0, 0], 'nothing survives');
});

test('records survive reads in the same session (the memory cache IS the store here)', () => {
  store.reset();
  store.solve('x-9', { guesses: 2, par: 2, hints: 0, rows: 2, won: true });
  const viaGetter = store.records['x-9'];
  const viaMethod = store.record('x-9');
  eq(viaGetter, viaMethod, 'one store, two doors');
  eq(viaMethod.best, 2, 'and the value is what was written');
});

run();
