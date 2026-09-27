// The third implementation, and deliberately the dumbest one.
//
//   value(S) = |S| <= 1 ? |S| : 1 + min over ALL guesses of max over produced answers value(branch)
//
// No memo, no bitmask, no ordering, no bound, no budget — a plain recursive game tree that
// recomputes every subtree from scratch. That is exactly why it is here: it is the only reading
// of the definition that shares no code with either shipped solver, so when
// js/core/minimax.js, js/core/decide.js and this agree on a codebook, the number is a property
// of the codebook and not of an algorithm.
//
// The one judgement call: a guess whose answer is the same for every remaining candidate leaves
// the position exactly as it was and one guess poorer, so it can never be the minimum and is
// skipped. That is arithmetic on the definition, not a prune borrowed from a solver — without it
// the recursion does not terminate.
//
// It is exponential in the worst case and only ever runs on small spaces in the tests. Nothing
// in js/ imports this file.

export function naiveValue(space, book) {
  if (book.length <= 1) return book.length;
  let best = Infinity;
  for (let guess = 0; guess < space.N; guess++) {
    const branches = new Map();
    for (const code of book) {
      const f = space.fbIndex(guess, code);
      const list = branches.get(f);
      if (list) list.push(code);
      else branches.set(f, [code]);
    }
    if (branches.size === 1) continue; // teaches nothing, see the note above
    let worst = 0;
    for (const list of branches.values()) {
      const v = naiveValue(space, list);
      if (v > worst) worst = v;
      if (1 + worst >= best) break; // arithmetic only: best so far already as good
    }
    if (1 + worst < best) {
      best = 1 + worst;
      if (best === 2) break; // 2 is the floor for any book of size >= 2
    }
  }
  return best;
}

// The same recursion, but reporting the move it chose, so a test can compare a baked policy
// against a search that shares nothing with the one that produced it.
export function naiveFirstGuess(space, book) {
  let best = Infinity;
  let bestGuess = -1;
  for (let guess = 0; guess < space.N; guess++) {
    const branches = new Map();
    for (const code of book) {
      const f = space.fbIndex(guess, code);
      const list = branches.get(f);
      if (list) list.push(code);
      else branches.set(f, [code]);
    }
    let worst = 0;
    for (const list of branches.values()) worst = Math.max(worst, naiveValue(space, list));
    if (1 + worst < best) { best = 1 + worst; bestGuess = guess; }
  }
  return { guess: bestGuess, value: best };
}
