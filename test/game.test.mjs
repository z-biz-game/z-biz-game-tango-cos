// The in-progress game: every rule in js/core/game.js, driven as pure data. No DOM, no window —
// the same object the canvas and the CDP driver see. The hand fixtures are the feedback numbers
// from test/fixture.mjs (worked out on paper, not read back from the code under test).

import { test, ok, eq, run } from '../tools/harness.mjs';
import { SPACE } from '../js/core/codes.js';
import {
  createGame, put, take, clearDraft, submit, undo, reset, hint, grade,
  guessesUsed, candidatePreview, draftFull, MAX_ROWS,
} from '../js/core/game.js';
import { consistent } from '../js/core/book.js';
import { code } from './fixture.mjs';
import { byId } from '../js/core/library.js';

// A hand-built lot: the secret and every feedback below were computed on paper from the
// two-pass rule before this file was run. `policy: null` on purpose — the fallback path.
function handLot() {
  const book = ['1234', '1111', '4321', '5555'].map((s) => code(SPACE, s));
  return {
    id: 'hand-01', tier: 'hand', par: 2, value: 2, bound: 1, floor: 2, R: 15, size: book.length,
    secret: code(SPACE, '1234'), book, policy: null,
  };
}

test('createGame: copies what the game needs and leaves the lot alone', () => {
  const lot = handLot();
  const snapshot = JSON.stringify(lot);
  const g = createGame(lot);
  eq(JSON.stringify(lot), snapshot, 'the lot object must not be touched');
  ok(g.cands !== lot.book && g.book !== lot.book, 'the game owns its arrays');
  eq(g.cands, lot.book, 'every code starts as a candidate');
  eq([g.rows.length, g.draft.length, g.done, g.won, g.failed, g.hints], [0, 0, false, false, false, 0], 'fresh board');
  eq([g.id, g.tier, g.par, g.value, g.bound, g.R], ['hand-01', 'hand', 2, 2, 1, 15], 'the printed numbers ride along');
});

test('put/take: fill the row in progress, refuse what is not a colour', () => {
  const g = createGame(handLot());
  eq(put(g, -1), false, 'no colour -1');
  eq(put(g, SPACE.C), false, `colour ${SPACE.C} does not exist (C=${SPACE.C})`);
  eq(put(g, 0), true, 'colour 0 goes in');
  eq(g.draft, [0], 'and is on the row');
  eq(put(g, 1), true);
  eq(put(g, 2), true);
  eq(put(g, 3), true);
  eq(g.draft.length, SPACE.L, 'the row is full at L');
  eq(draftFull(g), true, 'and draftFull says so');
  eq(put(g, 4), false, 'a fifth peg has nowhere to go');
  eq(g.draft.length, SPACE.L, 'and is not silently dropped in');
  eq(take(g), true, 'take lifts the last peg');
  eq(g.draft, [0, 1, 2], 'the rest stay');
  clearDraft(g);
  eq(g.draft, [], 'clearDraft empties what is left');
  eq(take(g), false, 'take on an empty row says no');
});

test('submit refuses the short row WITHOUT touching the board', () => {
  const g = createGame(handLot());
  put(g, 1); put(g, 2);
  const r = submit(g);
  eq(r.ok, false, 'refused');
  eq(r.reason, 'incomplete', 'and says why');
  eq(r.need, 2, 'and how many pegs are missing');
  eq([g.rows.length, g.cands.length, g.draft.length], [0, 4, 2], 'nothing was consumed: no row, no shrink, draft intact');
});

test('submit scores the hand fixture and shrinks candidates exactly like consistent()', () => {
  const g = createGame(handLot());
  for (const c of [0, 0, 1, 2]) put(g, c); // '1123' in display form
  const r = submit(g);
  eq([r.ok, r.black, r.white], [true, 1, 2], '1123 vs secret 1234 is (1,2): hand-computed, brief fixture');
  const guess = code(SPACE, '1123');
  const fb = SPACE.fbIndex(guess, g.secret);
  const expected = consistent(SPACE, handLot().book, guess, fb);
  eq(g.cands, expected, 'survivors are exactly the codes answering the same way');
  eq(r.left, g.cands.length, 'the number returned is the number left');
  eq(g.draft, [], 'the row in progress is consumed');
  eq(g.rows[0].guess, code(SPACE, '1123'), 'the row records the packed guess');
});

test('repeating a guess is legal, flagged, and still costs a row', () => {
  const g = createGame(handLot());
  for (const c of [0, 0, 1, 2]) put(g, c);
  submit(g);
  for (const c of [0, 0, 1, 2]) put(g, c);
  const r = submit(g);
  eq(r.ok, true, 'the repeat is accepted');
  eq(r.repeat, true, 'but it is flagged');
  eq(g.rows.length, 2, 'and it billed a guess — the par counts it');
  eq([r.black, r.white], [1, 2], 'same question, same answer');
});

test('black === L wins: done, won, and no more moves', () => {
  const g = createGame(handLot());
  for (const d of [1, 2, 3, 4]) put(g, d - 1); // guess the secret itself
  const r = submit(g);
  eq([r.black, r.white, r.won, g.done, g.won], [4, 0, true, true, true], 'four black ends it');
  eq(g.cands.length, 1, 'the only survivor is the secret');
  eq(put(g, 0), false, 'no pegging after the end');
  eq(take(g), false, 'no taking after the end');
  eq(submit(g).reason, 'over', 'no submitting after the end');
  eq(hint(g), null, 'and no hint');
});

test('the ten-row ceiling loses the game, not the theorem', () => {
  const lot = handLot();
  lot.secret = code(SPACE, '5555'); // make every guess below a guaranteed miss
  const g = createGame(lot);
  let last;
  for (let i = 0; i < MAX_ROWS; i++) {
    for (const c of [0, 0, 0, 0]) put(g, c); // '1111' vs '5555' is (0,0): no black ever
    last = submit(g);
  }
  eq([last.black, last.white], [0, 0], 'every one of them answered (0,0)');
  eq([g.rows.length, g.failed, g.won, g.done], [MAX_ROWS, true, false, true], 'the ceiling fires exactly at MAX_ROWS');
  eq(guessesUsed(g), MAX_ROWS, 'and the count matches the rows');
});

test('undo puts the board back; undo after a win lets you keep playing', () => {
  const g = createGame(handLot());
  eq(undo(g), false, 'nothing to undo yet');
  for (const c of [0, 0, 1, 2]) put(g, c);
  submit(g);
  const afterOne = g.cands.slice();
  put(g, 5); // a dangling draft must not survive the undo either
  eq(undo(g), true, 'undo the row');
  eq(g.cands.length, 4, 'candidates are the pre-row four');
  eq(g.draft, [], 'the draft was dropped, not merged back');
  eq(guessesUsed(g), 0, 'and the count went down');
  for (const d of [1, 2, 3, 4]) put(g, d - 1);
  submit(g);
  eq(g.won, true, 'win');
  eq(undo(g), true, 'undoing the winning row reopens the game');
  eq([g.done, g.won], [false, false], 'no longer finished');
  ok(afterOne.length < 4, 'sanity: the earlier filter really did shrink');
});

test('reset wipes rows, candidates and the finish flags', () => {
  const g = createGame(handLot());
  for (const c of [0, 0, 1, 2]) put(g, c);
  submit(g);
  reset(g);
  eq([g.rows.length, g.cands, g.draft, g.done], [0, handLot().book, [], false], 'back to the opening position');
});

test('the baked policy drives a real game to a win inside par (glance lot)', () => {
  // A value-2 book, by definition, has a first guess whose EVERY answer class has value <= 1 —
  // i.e. leaves at most one candidate. So this game must end in <= 2 plies: ply 1 comes from the
  // strategy table (exact), ply 2 is the forced finisher on the single survivor. That IS the
  // strict-descent theorem of js/core/minimax.js, played out through the browser's object.
  const lot = byId('glance-01');
  ok(lot && lot.par === 2, 'glance-01 is a printed par of 2');
  const g = createGame(lot);
  const h1 = hint(g);
  eq(h1.kind, 'policy', 'the opening move is off the baked table');
  eq(h1.exact, true, 'and it is certified as such');
  eq(h1.left, 2, 'the table promises two guesses at worst');
  for (let p = 0; p < SPACE.L; p++) put(g, SPACE.digits[h1.guess * SPACE.L + p]);
  submit(g);
  if (!g.done) {
    eq(g.cands.length, 1, 'ply 1 leaves exactly one survivor — value 2 means every branch has value <= 1');
    const h2 = hint(g);
    eq(h2.kind, 'split', 'a one-candidate subset has no strategy entry, and the game admits it');
    eq(h2.exact, false, 'no fake certificate on the finisher');
    eq(h2.guess, g.cands[0], 'the fallback hands back THE survivor — optimal by being forced');
    for (let p = 0; p < SPACE.L; p++) put(g, SPACE.digits[h2.guess * SPACE.L + p]);
    const r = submit(g);
    eq(r.won, true, 'and it wins');
  }
  eq(g.won, true, 'the policy line always wins');
  ok(guessesUsed(g) <= lot.par, `the certified strategy took ${guessesUsed(g)} > par ${lot.par}`);
});

test('off-policy positions fall back and SAY they fall back', () => {
  // The baked policy only covers the optimal subtree. On the biggest book in the pool a single
  // arbitrary guess lands on a subset the search never needed — the hint must come back as
  // kind 'split', exact: false, and offer a survivor, not a fake theorem.
  const lot = byId('siege-01');
  const g = createGame(lot);
  const h0 = hint(g);
  eq(h0.exact, true, 'the full book is covered');
  const guess = code(SPACE, '1111');
  for (let p = 0; p < SPACE.L; p++) put(g, SPACE.digits[guess * SPACE.L + p]);
  submit(g);
  const h = hint(g);
  ok(h !== null, 'there is a hint either way');
  eq(h.candidates, g.cands.length, 'it reports the real size of this position');
  eq(h.kind, 'split', 'a 500-way slice of a random subset is not in a 166-entry strategy');
  eq(h.exact, false, 'and says it is not the theorem');
  eq(h.left, null, 'no guess count is promised');
  ok(g.cands.includes(h.guess), 'the fallback guess is one of the survivors — O(|S|^2) and boring-fast');
});

test('grade keys the stars to the measured par, not to a feeling', () => {
  const g = createGame(handLot());
  eq(grade(g), { key: 'open', label: '尚未破码', stars: 0 }, 'before a win there are no stars');
  // par here is 2 and the secret is a book member, so the direct guess wins in 1: three stars.
  for (const d of [1, 2, 3, 4]) put(g, d - 1);
  submit(g);
  eq(grade(g).stars, 3, 'under par still grades as the top band');

  const atPar = createGame(handLot());
  for (const c of [0, 0, 0, 0]) put(atPar, c); // '1111' vs secret '1234' is (1,0): the brief fixture, reversed
  const m = submit(atPar);
  eq([m.black, m.white], [1, 0], 'one wasted row, hand-computed feedback');
  for (const d of [1, 2, 3, 4]) put(atPar, d - 1);
  submit(atPar);
  eq([guessesUsed(atPar), grade(atPar).key, grade(atPar).stars], [2, 'break', 3], 'matching par earns the top band');

  const late = createGame(handLot());
  for (const c of [0, 0, 0, 0]) put(late, c);
  submit(late);
  for (const c of [0, 0, 1, 1]) put(late, c); // '1122' vs '1234': pos1 black, one shared 2 -> (1,1)
  submit(late);
  for (const d of [1, 2, 3, 4]) put(late, d - 1);
  submit(late);
  eq([guessesUsed(late), grade(late).key, grade(late).stars], [3, 'late', 2], 'one over par is 迟一步');

  const pried = createGame(handLot());
  for (let i = 0; i < 4; i++) {
    for (const c of [0, 0, 0, 0]) put(pried, c);
    submit(pried); // four repeats of the same miss: legal, billed, no new information
  }
  for (const d of [1, 2, 3, 4]) put(pried, d - 1);
  submit(pried);
  eq([guessesUsed(pried), grade(pried).key, grade(pried).stars], [5, 'pried', 1], 'three over par drops to 硬撬开的');
});

test('candidatePreview caps the list but never lies about the count', () => {
  const lot = byId('siege-01'); // the biggest book in the pool
  const g = createGame(lot);
  const p = candidatePreview(g, 10);
  eq(p.shown.length, 10, 'capped');
  eq(p.more, g.cands.length - 10, 'the remainder is reported, not hidden');
  eq(p.shown, g.cands.slice(0, 10), 'and it is the front of the real list');
  const small = candidatePreview(g, 10000);
  eq([small.shown.length, small.more], [g.cands.length, 0], 'a cap past the size shows everything');
  ok(small.shown.every((c) => Number.isInteger(c)), 'codes, not strings — formatting is the shell\'s job');
});

test('the game never searches: candidate left after an answer equals the O(|S|) filter', () => {
  // This is the front-end red line in miniature: whatever the row shows, `left` is one pass of
  // consistent() over the survivors — no solver is reachable from js/core/game.js.
  const g = createGame(byId('grind-01'));
  for (let ply = 0; ply < 3 && !g.done; ply++) {
    const guess = SPACE.all[ply * 137 + 5];
    for (let p = 0; p < SPACE.L; p++) put(g, SPACE.digits[guess * SPACE.L + p]);
    const r = submit(g);
    const again = consistent(SPACE, g.rows[ply].candsBefore, guess, SPACE.fbIndex(guess, g.secret));
    eq(r.left, again.length, `ply ${ply + 1}: left == filter result`);
    eq(g.cands, again, 'and the survivor list itself');
  }
});

run();
