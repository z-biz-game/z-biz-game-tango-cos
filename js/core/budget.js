// Search budgets. Both solvers are exponential in the worst case, so "it finished" has to be
// a fact the code checks rather than a hope: every visited node ticks a guard that throws
// BudgetError when the node count or the wall clock runs out.
//
// Throwing rather than returning a number is the whole point. A solver that answers 4 when it
// gave up would print a fake par, and nothing downstream could tell. tools/bake.mjs catches
// this and treats the codebook as "too big to certify", which is how the shipped |S| ceiling
// is measured rather than guessed (README / DESIGN.md 5).

export class BudgetError extends Error {}

export function makeGuard(kind, opts = {}) {
  const maxNodes = opts.maxNodes || 400000;
  const maxMs = opts.maxMs === undefined ? 20000 : opts.maxMs;
  const now = opts.now || Date.now;
  const started = now();
  let nodes = 0;
  return {
    tick() {
      nodes++;
      if (nodes > maxNodes) throw new BudgetError(`${kind}: ${nodes} nodes > maxNodes ${maxNodes}`);
      if ((nodes & 255) === 0 && now() - started > maxMs) {
        throw new BudgetError(`${kind}: ${nodes} nodes past ${maxMs}ms`);
      }
      return nodes;
    },
    get nodes() { return nodes; },
    ms() { return now() - started; },
  };
}
