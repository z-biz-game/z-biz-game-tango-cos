// Save file. One localStorage key, plain JSON, and a versioned shape so an old save can be
// recognised rather than mistaken for a new one.
//
// Records are keyed by lot id, plus a daily log and a campaign unlock pointer. Everything here
// degrades to memory when localStorage is denied, which it is under file://, in private windows
// and whenever the OS decides a page may not persist — the game must still be playable, so a
// throwing localStorage is caught and the session simply forgets.
//
// Two monotonicities are the whole design:
//   * `best` only ever goes DOWN (a worse solve cannot erase a better one),
//   * `unlock` only ever goes UP (re-playing level 3 cannot hide level 9 again).
// test/storage.test.mjs asserts both by writing them out of order.

const KEY = 'tango.save.v1';

function blank() {
  return {
    records: {},
    daily: {},
    unlocked: 1,
    stats: { breaks: 0, par: 0, guesses: 0, hints: 0, rows: 0 },
  };
}

let cache = null;

function readRaw() {
  try {
    return window.localStorage.getItem(KEY);
  } catch (err) {
    return null;
  }
}

function load() {
  if (cache) return cache;
  const raw = readRaw();
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        const base = blank();
        cache = {
          records: p.records && typeof p.records === 'object' ? p.records : base.records,
          daily: p.daily && typeof p.daily === 'object' ? p.daily : base.daily,
          unlocked: Number(p.unlocked) > 0 ? Number(p.unlocked) : base.unlocked,
          stats: { ...base.stats, ...(p.stats || {}) },
        };
        return cache;
      }
    } catch (err) {
      // A corrupt save is not worth keeping; start clean rather than crash the shell.
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (err) {
    /* memory-only session */
  }
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get unlocked() { return load().unlocked; },

  record(id) {
    return load().records[id] || null;
  },

  // Unlocking is monotone: the campaign never goes backwards.
  unlock(n) {
    const s = load();
    if (n > s.unlocked) s.unlocked = n;
    persist();
    return s.unlocked;
  },

  markDaily(dateKey, id, result) {
    const s = load();
    const prev = s.daily[dateKey];
    if (prev && prev.done && (!result || (result.guesses || 0) >= (prev.guesses || 0))) {
      s.daily[dateKey] = { id, done: true, guesses: prev.guesses, at: prev.at };
    } else {
      s.daily[dateKey] = { id, done: !!(result && result.guesses), guesses: (result && result.guesses) || 0, at: Date.now() };
    }
    persist();
    return s.daily[dateKey];
  },

  dailyDone(dateKey) {
    return load().daily[dateKey] || null;
  },

  // `par` is the exact minimax value of this codebook, so "破码 in par" is a fact about the
  // player's play rather than a feeling: they matched the worst-case number the search proved.
  solve(id, { guesses, par, hints, rows, won }) {
    const s = load();
    const prev = s.records[id];
    const cur = {
      solved: !!(won || (prev && prev.solved)),
      best: won && (!prev || !prev.best || guesses < prev.best) ? guesses : (prev ? prev.best : null),
      plays: (prev && prev.plays ? prev.plays : 0) + 1,
      par: !!(won && guesses <= par) || !!(prev && prev.par),
    };
    s.records[id] = cur;
    if (won) {
      s.stats.breaks += 1;
      if (guesses <= par) s.stats.par += 1;
    }
    s.stats.guesses += guesses || 0;
    s.stats.rows += rows || 0;
    s.stats.hints += hints || 0;
    persist();
    return cur;
  },

  // Level-list counters the header prints; kept here so the number is one thing everywhere.
  totals() {
    const s = load();
    let solved = 0;
    let atPar = 0;
    for (const r of Object.values(s.records)) {
      if (r && r.solved) solved++;
      if (r && r.par) atPar++;
    }
    return { solved, atPar, breaks: s.stats.breaks, hints: s.stats.hints };
  },

  reset() {
    cache = blank();
    try {
      window.localStorage.removeItem(KEY);
    } catch (err) {
      /* nothing was ever persisted */
    }
  },
};

// Only for the test: which backing store this session actually got.
export function persistent() {
  try {
    window.localStorage.setItem('tango.probe', '1');
    window.localStorage.removeItem('tango.probe');
    return true;
  } catch (err) {
    return false;
  }
}
