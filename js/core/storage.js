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

// ---- stage 2: sanitise ---------------------------------------------------------------
// Stage 1 (JSON.parse) only tells us the bytes were valid JSON. The shape is the part that
// can still be hostile: a hand-edited file, a save written by a older/newer build, or one
// truncated by a quota error mid-write. So every field is decoded on its own, and a bad
// record is dropped on its own — losing one lot's history must not lose the other 30, and
// must not throw on the way to the first render.
function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function posInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

// A record is only believable if its numbers are numbers and its flags are flags. `best`
// is the one field the UI compares against a live guess count, so a string there would
// turn `guesses < prev.best` into a silent false instead of a new personal best.
function decodeRecord(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const best = posInt(v.best);
  return {
    solved: !!v.solved || (best !== null),
    best,
    plays: count(v.plays),
    par: !!v.par,
  };
}

function decodeDaily(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return {
    id: typeof v.id === 'string' || typeof v.id === 'number' ? v.id : null,
    done: !!v.done,
    guesses: count(v.guesses),
    at: posInt(v.at) || 0,
  };
}

function decodeMap(raw, decode) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(raw)) {
    const clean = decode(v);
    if (clean) out[k] = clean; else dropped++;
  }
  return { map: out, dropped };
}

let cache = null;
let droppedCount = 0;

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
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Un-parseable bytes carry no information worth keeping: start clean rather than crash.
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const base = blank();
      const records = decodeMap(parsed.records, decodeRecord);
      const daily = decodeMap(parsed.daily, decodeDaily);
      const statsIn = parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : {};
      droppedCount = (records ? records.dropped : 0) + (daily ? daily.dropped : 0);
      cache = {
        records: records ? records.map : base.records,
        daily: daily ? daily.map : base.daily,
        unlocked: posInt(parsed.unlocked) || base.unlocked,
        stats: {
          breaks: count(statsIn.breaks),
          par: count(statsIn.par),
          guesses: count(statsIn.guesses),
          hints: count(statsIn.hints),
          rows: count(statsIn.rows),
        },
      };
      return cache;
    }
  }
  cache = blank();
  return cache;
}

// How many records/daily entries the decoder threw away on the last read. Diagnostics only:
// deliberately kept outside `cache` so it never lands in the persisted file.
export function droppedRecords() {
  load();
  return droppedCount;
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
    cache = null;
    droppedCount = 0;
    try {
      window.localStorage.removeItem(KEY);
    } catch (err) {
      /* nothing was ever persisted */
    }
  },
};

// Drop the in-memory copy and read the file again — what a page reload does. Only used by the
// tests (and by a future "import save" flow), but it is what makes the decoder observable:
// without it the first decode is cached forever and a junk save could be silently self-healing.
export function reload() {
  cache = null;
  droppedCount = 0;
}

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
