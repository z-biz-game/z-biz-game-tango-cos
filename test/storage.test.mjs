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
import { store, persistent, reload, droppedRecords } from '../js/core/storage.js';

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

// ---- 脏存档：一段垃圾只能弄脏它自己 -------------------------------------------------
// The decoder used to take `records` and `daily` straight out of JSON, so one hostile entry
// reached the render loop — `guesses < prev.best` with `best` a string is a silent false, and
// `prev.done` on a number is a TypeError on the way to the first paint. That makes a single
// bad byte a whole-game outage. Two stages now: bytes first (JSON.parse), then per record, so
// an unusable record is dropped alone and the rest of the file is still a save file.
function fakeStorage(raw) {
  const map = new Map();
  if (raw !== undefined) map.set('tango.save.v1', raw);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test('one junk record drops itself, not its 30 neighbours', () => {
  globalThis.window = { localStorage: fakeStorage(JSON.stringify({
    records: {
      'good-1': { solved: true, best: 4, plays: 3, par: true },
      'bad-null': null,
      'bad-number': 7,
      'bad-array': [1, 2],
      'bad-string': 'oops',
      'soft-best': { solved: true, best: '5', plays: -3, par: 1 },
    },
    daily: {
      '2026-03-01': { id: 'good-1', done: true, guesses: 4, at: 1700000000000 },
      '2026-03-02': 'oops',
      '2026-03-03': 12,
    },
    unlocked: '12',
    stats: { breaks: 'x', par: 3, guesses: 2, hints: -1, rows: null },
  })) };
  reload();

  eq(Object.keys(store.records).sort(), ['good-1', 'soft-best'], 'the two decodable records survive');
  eq(store.record('good-1'), { solved: true, best: 4, plays: 3, par: true }, 'untouched');
  eq(store.record('bad-string'), null, 'the junk one reads as absent, exactly like an unsolved id');
  eq(store.record('soft-best'), { solved: true, best: 5, plays: 0, par: true }, 'repairable fields are repaired, not dropped');
  eq(droppedRecords(), 6, '4 records + 2 daily entries counted as dropped');
  eq(store.unlocked, 12, '"12" is a number the campaign can use');
  eq(Object.keys(store.daily), ['2026-03-01'], 'the good day survives');
  const s = store.stats;
  eq([s.breaks, s.par, s.guesses, s.hints, s.rows], [0, 3, 2, 0, 0], 'each stat field decoded alone');
  eq(store.totals(), { solved: 2, atPar: 2, breaks: 0, hints: 0 }, 'the header can be built from a dirty file');

  // And the writer must not choke on the file it just half-rejected: solving a dropped id and
  // re-marking a dropped day both start from a blank record rather than from the junk.
  const r = store.solve('bad-string', { guesses: 3, par: 3, hints: 0, rows: 3, won: true });
  eq([r.best, r.solved, r.plays, r.par], [3, true, 1, true], 'writing over a dropped record works');
  const m = store.markDaily('2026-03-02', 'good-1', { guesses: 5 });
  eq([m.done, m.guesses], [true, 5], 'writing over a dropped day works');
  eq(store.markDaily('2026-03-01', 'good-1', { guesses: 9 }).guesses, 4, 'a good day still refuses to inflate');
});

test('a file that is not JSON at all degrades to blank instead of throwing', () => {
  globalThis.window = { localStorage: fakeStorage('{"records": {"a":') };
  reload();
  eq([store.unlocked, Object.keys(store.records).length, store.stats.breaks], [1, 0, 0], 'blank slate');
  eq(droppedRecords(), 0, 'nothing to count — stage 1 already refused the bytes');
  store.solve('a', { guesses: 2, par: 2, hints: 0, rows: 2, won: true });
  eq(store.record('a').best, 2, 'and the game is writable afterwards');

  // A JSON scalar/array is technically parseable and still not a save file.
  globalThis.window.localStorage.setItem('tango.save.v1', '[1,2,3]');
  reload();
  eq([store.unlocked, Object.keys(store.records).length], [1, 0], 'an array is not an object shape');

  globalThis.window.localStorage.setItem('tango.save.v1', '"just a string"');
  reload();
  eq([store.unlocked, Object.keys(store.daily).length], [1, 0], 'a scalar is not a save either');
  delete globalThis.window;
});

run();
