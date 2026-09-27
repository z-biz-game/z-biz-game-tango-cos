// The answer-pattern table, for build time and tests only.
//
//   classTable(space)[guess * N + code] = the feedback id space.fbIndex(guess, code)
//
// One row per guess, so partitioning a candidate set by a guess is a single byte lookup per
// candidate instead of an O(L + C) re-derivation. 1296 x 1296 = 1.68 MB and ~30 ms to fill,
// which is why nothing in js/ that the browser loads imports this file: the shipped page
// computes feedback through js/core/codes.js, and only js/core/minimax.js, js/core/decide.js
// and tools/bake.mjs ask for the table.
//
// Memoised per space object, so the L=2/C=3 toy space the three-way test builds gets its own
// 81-byte table and the shipped space its own.

const cache = new WeakMap();

export function classTable(space) {
  const hit = cache.get(space);
  if (hit) return hit;
  const n = space.N;
  const table = new Uint8Array(n * n);
  for (let g = 0; g < n; g++) {
    const row = g * n;
    for (let c = 0; c < n; c++) table[row + c] = space.fbIndex(g, c);
  }
  cache.set(space, table);
  return table;
}
