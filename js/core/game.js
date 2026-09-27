// A game in progress: pure state plus the rules that touch it. No DOM anywhere in here, which
// is what lets test/game.test.mjs and tools/playtest.mjs drive the same object the screen does.
//
// THE RULES, and where each one bites:
//   * The secret is a member of the level's codebook, but the player may guess ANY code in the
//     space. The codebook is knowledge, not a restriction — the printed par is computed under
//     exactly this rule (DESIGN.md 2.2).
//   * A row must be `L` pegs long before it can be submitted. `submit` refuses a short row
//     instead of padding it, because a padded row would score a feedback the player never
//     asked for. tools/playtest.mjs asserts this from a real click sequence.
//   * Repeating a guess is legal and costs a guess: Mastermind does not forbid it, and neither
//     do we — the row is just flagged so the screen can say "这一步没有新信息".
//   * Feedback is the two-pass rule from js/core/codes.js, and the surviving-candidate count is
//     filtered through the SAME function, so the pegs and the number can never disagree.
//   * `black === L` wins. Ten rows is the hard ceiling; par is at most 5 at the shipped sizes,
//     so losing here means the player stopped reasoning about the feedback rather than that the
//     level was unfair.
//
// The one computation this file does is `consistent()` — O(candidates), allocation-free apart
// from the output — which is why the "剩余候选" tile updates on every submit without a spinner.
// `value()` and `canBreakIn()` are never imported here: see the performance red line,
// DESIGN.md 5.

import { SPACE } from './codes.js';
import { consistent, maskOf } from './book.js';

// Rows on the screen. Generously above every baked par (max 5 at the measured sizes).
export const MAX_ROWS = 10;

// `lot.policy` is a Map from a surviving-subset mask to { guess, value }, baked by
// tools/bake.mjs out of the exact minimax run. See `hint` below for what it does and does not
// cover.
export function createGame(lot, opts = {}) {
  const space = opts.space || SPACE;
  const book = lot.book.slice();
  // code -> position in the book. A typed array of the space size (2.6 kB), so the candidate
  // list can be turned into a policy key without a hash map on the hot path.
  const posOf = new Int16Array(space.N).fill(-1);
  for (let i = 0; i < book.length; i++) posOf[book[i]] = i;
  return {
    space,
    id: lot.id,
    tier: lot.tier,
    par: lot.par,
    value: lot.value,
    bound: lot.bound,
    size: book.length,
    R: space.R,
    secret: lot.secret,
    book,
    posOf,
    policy: lot.policy || null,
    cands: book.slice(),
    rows: [],
    draft: [],
    hints: 0,
    done: false,
    won: false,
    failed: false,
  };
}

export function draftFull(game) {
  return game.draft.length >= game.space.L;
}

// Tap a palette colour: appends to the row in progress. Returns false when there is no room
// (the screen keeps the old pegs rather than silently replacing one).
export function put(game, colour) {
  if (game.done || colour < 0 || colour >= game.space.C || draftFull(game)) return false;
  game.draft.push(colour);
  return true;
}

// Lift the last peg off the row in progress.
export function take(game) {
  if (game.done || !game.draft.length) return false;
  game.draft.pop();
  return true;
}

export function clearDraft(game) {
  game.draft = [];
}

// Submit the row in progress. `reason: 'incomplete'` is the one illegal move in the game and
// the browser test asserts it is actually reached by clicking.
export function submit(game) {
  if (game.done) return { ok: false, reason: 'over' };
  if (game.draft.length < game.space.L) {
    return { ok: false, reason: 'incomplete', need: game.space.L - game.draft.length };
  }
  const space = game.space;
  let guess = 0;
  for (let p = 0; p < space.L; p++) guess = guess * space.C + game.draft[p];
  const [black, white] = space.blackWhite(guess, game.secret);
  const fbId = space.fbIndex(guess, game.secret);
  const left = consistent(space, game.cands, guess, fbId);
  const repeat = game.rows.some((r) => r.guess === guess);
  game.rows.push({
    guess,
    black,
    white,
    left: left.length,
    repeat,
    candsBefore: game.cands,
  });
  game.cands = left;
  game.draft = [];
  if (black === space.L) {
    game.done = true;
    game.won = true;
  } else if (game.rows.length >= MAX_ROWS) {
    game.done = true;
    game.failed = true;
  }
  return {
    ok: true,
    black,
    white,
    left: left.length,
    repeat,
    won: game.won,
    failed: game.failed,
  };
}

export function undo(game) {
  const last = game.rows.pop();
  if (!last) return false;
  game.cands = last.candsBefore;
  game.draft = [];
  game.done = false;
  game.won = false;
  game.failed = false;
  return true;
}

export function reset(game) {
  game.cands = game.book.slice();
  game.rows = [];
  game.draft = [];
  game.done = false;
  game.won = false;
  game.failed = false;
}

export function guessesUsed(game) {
  return game.rows.length;
}

// The next guess, and how many guesses are provably left after it.
//
// `exact: true` means the answer came out of the baked policy map, i.e. the minimax really
// solved this subset at build time and this move is optimal. The whole optimal subtree is
// recorded (every child of the move the search chose is itself solved exactly and records its
// own move), so a player who follows the hints from the start is covered at every step — that
// is what test/library.test.mjs checks by replaying the policy to a win.
//
// `exact: false` means the player wandered onto a subset the search never needed, and the game
// hands back the candidate guess that splits the survivors most evenly. That is NOT a par
// guarantee and the screen prints which kind it got, rather than dressing a fallback up as the
// theorem. The fallback scans only book members as guesses, which is a deliberate,
// documented weakening: it keeps the browser at O(|S|²) feedback calls with no 1.7 MB lookup
// table shipped to a phone.
export function hint(game) {
  if (game.done || !game.cands.length) return null;
  const list = [];
  for (let i = 0; i < game.cands.length; i++) list.push(game.posOf[game.cands[i]]);
  const entry = game.policy ? game.policy.get(maskOf(list)) : null;
  if (entry) return { kind: 'policy', exact: true, guess: entry.guess, left: entry.value, candidates: game.cands.length };
  return { kind: 'split', exact: false, guess: bestSplit(game), left: null, candidates: game.cands.length };
}

// Largest surviving class of one guess over `list`, over the guesses this file is willing to
// spend time on (see `hint`).
function classWorst(game, guess) {
  const space = game.space;
  let worst = 0;
  const seen = new Map();
  for (let i = 0; i < game.cands.length; i++) {
    const f = space.fbIndex(guess, game.cands[i]);
    const v = (seen.get(f) || 0) + 1;
    seen.set(f, v);
    if (v > worst) worst = v;
  }
  return worst;
}

function bestSplit(game) {
  let best = game.cands[0];
  let bestWorst = Infinity;
  for (let i = 0; i < game.cands.length; i++) {
    const w = classWorst(game, game.cands[i]);
    if (w < bestWorst) { bestWorst = w; best = game.cands[i]; }
  }
  return best;
}

// Three grades, keyed on the certified par rather than on a feeling: `rows <= par` means the
// player matched the exact minimax number, which is a checkable claim about their play.
export function grade(game) {
  if (!game.won) return { key: 'open', label: '尚未破码', stars: 0 };
  const over = game.rows.length - game.par;
  if (over <= 0) return { key: 'break', label: '当庭破码', stars: 3 };
  if (over === 1) return { key: 'late', label: '迟一步', stars: 2 };
  return { key: 'pried', label: '硬撬开的', stars: 1 };
}

// What the drawer of possibilities shows: the surviving codes, capped so a 500-code book does
// not build 500 DOM nodes on every submit. Codes, not strings — formatting is the shell's job.
// The count is always the true count.
export function candidatePreview(game, cap = 60) {
  const shown = [];
  const n = Math.min(cap, game.cands.length);
  for (let i = 0; i < n; i++) shown.push(game.cands[i]);
  return { shown, more: game.cands.length - n };
}
