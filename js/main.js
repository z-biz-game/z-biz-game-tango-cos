// The shell: hash routes in, canvas out, records in between. Nothing here knows the rules of
// the game — those live in js/core/game.js — and nothing here draws — that is js/view.js. What
// this file owns is the third thing: which numbers get put on screen, and when a result is
// written to the save file.
//
// The panel deliberately shows three numbers together and in this order:
//   |S|       how many codes the secret is hiding among,
//   下界       ceil(log_R |S|), what pure counting forces on any strategy,
//   精确值     value(S), the exact minimax answer, i.e. the par,
// because the whole point of the game is that the middle one is a theorem and the last one is a
// measurement, and the player can watch them not be equal.

import { SPACE } from './core/codes.js';
import { createGame, put, take, clearDraft, submit, undo, reset, hint, grade, guessesUsed, candidatePreview, MAX_ROWS } from './core/game.js';
import { store, persistent } from './core/storage.js';
import {
  TIERS, ALL, byId, levelAt, randomLot, dailyLot, tierByKey, bakedAt, stats as poolStats,
} from './core/library.js';
import { todayKey, rngFrom } from './core/rng.js';
import { createView } from './view.js';
import { createAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const el = {
  modes: $('modes'), totals: $('totals'), crumbs: $('crumbs'), readout: $('readout'),
  hintline: $('hintline'), curtain: $('curtain'), stars: $('stars'), verdict: $('verdict'),
  tally: $('tally'), submit: $('submit'), take: $('take'), undo: $('undo'), hint: $('hint'),
  restart: $('restart'), share: $('share'), next: $('next'), again: $('again'), toast: $('toast'),
  canvas: $('board'), wipe: $('wipe'), drawer: $('drawer'), bookcount: $('bookcount'),
  chips: $('chips'), chipmore: $('chipmore'),
  pause: $('pause'), mute: $('mute'), fullscreen: $('fullscreen'), help: $('help'),
  resume: $('resume'), pausecard: $('pausecard'), helpcard: $('helpcard'), helpclose: $('helpclose'),
};

const LEVELS = ALL.length;
// Asked once at boot: localStorage can throw on access (file://, private windows, locked-down
// profiles), and `store` then runs on its memory cache for the rest of the session. The header
// says so rather than quietly losing the player's records at the tab close.
const CAN_PERSIST = persistent();
// One sound setting is worth persisting; it is the player's promise to the room, not a score.
const MUTE_KEY = 'tango.muted';
function readMuted() {
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch (err) {
    return false;
  }
}
function writeMuted(v) {
  try {
    window.localStorage.setItem(MUTE_KEY, v ? '1' : '0');
  } catch (err) {
    /* memory-only session: the setting just does not survive a reload */
  }
}

const MOTION_QUERY = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;
const audio = createAudio({ muted: readMuted() });
const app = {
  mode: 'campaign',
  index: 1,
  route: null,
  lot: null,
  game: null,
  hints: 0,
  label: '',
  day: null,
  lastLine: '',
  paused: false,
  muted: audio.muted,
  fullscreen: false,
  helpOpen: false,
  reducedMotion: !!(MOTION_QUERY && MOTION_QUERY.matches),
  sw: false,
};

function clampIndex(n) {
  return Math.min(LEVELS, Math.max(1, Number(n) || 1));
}

// #/c/12 · #/daily · #/random/probe/4kq2 · #/lot/grind-03
// The lot id is in the URL, so a shared link resolves to the same codebook on another device
// without the receiver needing the sender's save file — the pool is fixed and shipped.
function parseHash(hash = location.hash) {
  const p = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'daily') return { mode: 'daily' };
  if (p[0] === 'random') return { mode: 'random', tier: p[1] || TIERS[0].key, key: p[2] || null };
  if (p[0] === 'lot') return { mode: 'lot', id: p[1] };
  const n = p[0] === 'c' || p[0] === 'campaign' ? Number(p[1]) : Number(p[0]);
  return { mode: 'campaign', index: clampIndex(n) };
}

function linkFor(rt) {
  if (rt.mode === 'daily') return '#/daily';
  if (rt.mode === 'random') return `#/random/${rt.tier}/${rt.key}`;
  if (rt.mode === 'lot') return `#/lot/${rt.id}`;
  return `#/c/${rt.index}`;
}

function resolve(rt) {
  if (rt.mode === 'daily') {
    const day = todayKey();
    return { lot: dailyLot(day), label: `每日破码 · ${day}`, day };
  }
  if (rt.mode === 'random') {
    const key = rt.key || String(rngFrom(`rand-${rt.tier}`).int(1e6));
    return { lot: randomLot(`${rt.tier}|${key}`, rt.tier), label: `随机 · ${tierByKey(rt.tier).label}`, seedKey: key };
  }
  if (rt.mode === 'lot') return { lot: byId(rt.id), label: `关卡 ${rt.id}` };
  return { lot: levelAt(rt.index - 1), label: `战役第 ${rt.index} 关` };
}

let view = null;

function go(hash) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) apply();
  else location.hash = target;
}

function apply() {
  const rt = parseHash();
  // A bare `#/random` must mint its key INTO the URL. resolve() used to mint one internally,
  // which played fine but made 分享 produce `#/random/tier/null` — a link that re-rolls on every
  // open, defeating the point of sharing a puzzle. Mint first, rewrite the hash, then resolve.
  if (rt.mode === 'random' && !rt.key) {
    rt.key = String(rngFrom(`mint-${Date.now()}`).int(1e6));
    return go(linkFor(rt));
  }
  const found = resolve(rt);
  // A route that does not name a shipped lot falls back to the campaign, never to a blank
  // board: the URL is a request, not a source of truth.
  if (!found.lot) {
    if (rt.mode !== 'campaign') return go(`#/c/${store.unlocked}`);
    app.lot = ALL[0];
    app.label = '关卡库为空';
  } else {
    app.lot = found.lot;
    app.label = found.label;
  }
  app.mode = rt.mode === 'lot' ? 'campaign' : rt.mode;
  app.index = rt.mode === 'campaign' ? clampIndex(rt.index) : ALL.findIndex((l) => l === app.lot) + 1;
  app.day = found.day || null;
  app.hints = 0;
  app.route = rt;
  app.game = createGame(app.lot, { space: SPACE });
  // A new lot is a new board: it must not arrive still paused, or still behind the rules card.
  if (view) {
    setPaused(false);
    setHelp(false);
  }
  view.setGame(app.game);
  view.measure();
  el.curtain.hidden = true;
  render(`载入 ${app.lot.id} · ${tierByKey(app.lot.tier).label}`);
}

// One tile per number, and each tile says what kind of number it is: `measured` came out of the
// search, `theorem` came out of the counting argument, `live` is the player's own state.
function tile(key, term, value, note) {
  return `<div class="${key}"><dt>${term}</dt><dd>${value}${note ? `<small>${note}</small>` : ''}</dd></div>`;
}

function render(line) {
  const g = app.game;
  const lot = app.lot;
  const tier = tierByKey(lot.tier);
  const used = guessesUsed(g);
  if (line !== undefined) app.lastLine = line;
  el.crumbs.innerHTML = `${app.label} · <span class="band">${tier.label}</span><b>${lot.id}</b>`;
  // The pool is a measurement; a measurement has a timestamp. Hovering the crumbs shows when
  // tools/bake.mjs certified these books — js/data/lots.js carries the stamp and library
  // re-exports it so the shell has one source for the number.
  el.crumbs.title = `码本烘焙于 ${bakedAt}${CAN_PERSIST ? '' : ' · 本机存档不可用，成绩只存内存'}`;
  el.readout.innerHTML = [
    tile('size', '码本 |S|', lot.size, `<small> 码</small>`),
    tile('bound', '下界', lot.bound, `<small> ceil(log_${lot.R} |S|)</small>`),
    tile('par', '精确值', lot.par, `<small> 次必破</small>`),
    tile('used', '已用', used, `<small> / ${MAX_ROWS} 行</small>`),
    tile('left', '剩余候选', g.cands.length, `<small> / ${lot.size}</small>`),
    tile('R', '反馈种类 R', lot.R, `<small> ${SPACE.L}  pegs</small>`),
  ].join('');
  el.hintline.innerHTML = app.lastLine;
  // Deliberately NOT disabled while the row is short: an illegal submit has to stay reachable by
  // a real click, so the rule lives in game.submit() and not in the button. tools/playtest.mjs
  // presses it on purpose with three pegs down.
  el.submit.disabled = g.done;
  el.take.disabled = g.done || !g.draft.length;
  el.undo.disabled = !g.rows.length;
  el.hint.disabled = g.done;
  drawChips();
  const t = store.totals();
  el.totals.innerHTML = `破码 <b>${t.atPar}</b>/${LEVELS} 关达到精确值 · 已解锁 ${store.unlocked}`
    + (CAN_PERSIST ? '' : ' · <span class="warn">内存模式</span>');
  for (const b of el.modes.querySelectorAll('button')) {
    b.setAttribute('aria-current', String(b.dataset.mode === app.mode));
  }
}

function drawChips() {
  const g = app.game;
  const preview = candidatePreview(g, 60);
  el.bookcount.textContent = `(${g.cands.length})`;
  const guessed = new Set(g.rows.map((r) => r.guess));
  el.chips.innerHTML = preview.shown
    .map((code) => `<span class="${guessed.has(code) ? 'hit' : ''}">${SPACE.format(code)}</span>`)
    .join('');
  el.chipmore.textContent = preview.more > 0 ? `…另有 ${preview.more} 个候选未列出` : '';
}

// ---- playing -------------------------------------------------------------

function commit() {
  if (!playing()) return;
  const g = app.game;
  const r = submit(g);
  if (!r.ok) {
    audio.play('illegal');
    if (r.reason === 'incomplete') render(`<span class="warn">这行还差 ${r.need} 枚 peg 才能提交</span>`);
    else if (r.reason === 'over') render('本关已经结束，按重开再来。');
    return;
  }
  audio.play('answer', r.black, r.white);
  const line = `第 ${g.rows.length} 次：<b>${r.black}</b> 黑 <b>${r.white}</b> 白 · 剩余候选 ${r.left}${r.repeat ? ' · 这一码你猜过了' : ''}`;
  if (g.done) {
    finish(line);
  } else {
    render(`${line} · 还有 ${g.cands.length} 个可能`);
  }
  view.setGame(g);
}

function finish(line) {
  const g = app.game;
  const lot = app.lot;
  const gr = grade(g);
  const used = guessesUsed(g);
  store.solve(lot.id, { guesses: used, par: lot.par, hints: app.hints, rows: used, won: g.won });
  if (g.won) {
    const at = ALL.findIndex((l) => l.id === lot.id) + 1;
    if (at > 0) store.unlock(Math.min(LEVELS, Math.max(store.unlocked, at + 1)));
    if (app.mode === 'daily' && app.day) store.markDaily(app.day, lot.id, { guesses: used });
  }
  el.stars.textContent = '★'.repeat(gr.stars) + '☆'.repeat(3 - gr.stars);
  el.verdict.textContent = g.won ? gr.label : '十行用完，密码还在';
  el.tally.innerHTML = g.won
    ? `用了 <b>${used}</b> 次 · 这一关的精确值是 <b>${lot.par}</b> · 码本 <b>${lot.size}</b> 码 · 下界 <b>${lot.bound}</b><br>`
      + `提示用了 ${app.hints} 次${used <= lot.par ? ' · 你打平了搜索量出来的最坏情况' : ''}`
    : `候选还剩 <b>${g.cands.length}</b> 个 · 精确值 ${lot.par} 次本该够 · 按“重开”再试一次`;
  el.curtain.hidden = false;
  audio.play(g.won ? 'win' : 'lose');
  render(line);
  view.setGame(g);
}

function doHint() {
  if (!playing()) return;
  const g = app.game;
  const h = hint(g);
  if (!h) return;
  audio.play('hint');
  app.hints++;
  g.hints++;
  const code = SPACE.format(h.guess);
  if (h.exact) {
    render(`策略表：猜 <b>${code}</b>，之后最多还需 <b>${h.left}</b> 次（这一步搜索在构建期算过）`);
  } else {
    render(`<span class="warn">这一步搜索没存过（${h.candidates} 个候选的分支），</span>给你收得最快的 <b>${code}</b>——不保证精确值`);
  }
}

// The digits a click needs, in palette indices: `format` is 1-based for humans, the palette is
// 0-based for the colour table.
function digitsOf(guess) {
  const out = [];
  for (let p = 0; p < SPACE.L; p++) out.push(SPACE.digits[guess * SPACE.L + p]);
  return out;
}

// ---- system controls -----------------------------------------------------

// Gameplay input is dead while the board is frozen. This is the one guard, checked by every
// action, so "paused" cannot mean "the buttons still work but the animation stopped".
function playing() {
  return !app.paused && !app.helpOpen;
}

function setPaused(v) {
  const next = !!v;
  if (next === app.paused) return next;
  app.paused = next;
  view.setPaused(next);
  // Pausing stops the sound too, and unpausing must not replay what was skipped: the context is
  // suspended, so any voice scheduled during the pause window is simply gone.
  if (next) audio.suspend();
  else if (!app.muted) audio.resume();
  el.pausecard.hidden = !next;
  el.pause.setAttribute('aria-pressed', String(next));
  el.pause.textContent = next ? '▶' : '⏸';
  el.pause.setAttribute('aria-label', next ? '继续' : '暂停');
  return next;
}

function togglePause() {
  if (app.game && app.game.done && !app.paused) return false;
  const on = setPaused(!app.paused);
  render(on ? '已暂停 · 动画与音效冻结' : '继续 · 回到牌桌');
  return on;
}

// Mute is the AudioContext's own state plus a refusal to build voices — not a gain of 0.
function setMuted(v) {
  app.muted = audio.setMuted(!!v);
  writeMuted(app.muted);
  el.mute.setAttribute('aria-pressed', String(app.muted));
  el.mute.textContent = app.muted ? '🔇' : '🔊';
  el.mute.setAttribute('aria-label', app.muted ? '取消静音' : '静音');
  return app.muted;
}

function toggleMute() {
  const m = setMuted(!app.muted);
  if (!m) audio.play('ui');
  toast(m ? '已静音（AudioContext 已挂起）' : '声音已开');
  return m;
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function syncFullscreen() {
  app.fullscreen = isFullscreen();
  el.fullscreen.setAttribute('aria-pressed', String(app.fullscreen));
  el.fullscreen.textContent = app.fullscreen ? '🗗' : '⛶';
  // The layout is measured off the canvas box, so a fullscreen change is a resize.
  view.measure();
}

function toggleFullscreen() {
  const root = document.documentElement;
  if (isFullscreen()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(document)).catch(() => { /* denied */ });
    return false;
  }
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!req) {
    toast('这个浏览器不支持全屏');
    return false;
  }
  Promise.resolve(req.call(root)).then(() => {
    toast('全屏 · 再按 F 或 Esc 退出');
  }, () => {
    toast('全屏被拒绝了（需要一次真实点击）');
  });
  return true;
}

function setHelp(v) {
  app.helpOpen = !!v;
  el.helpcard.hidden = !app.helpOpen;
  el.help.setAttribute('aria-pressed', String(app.helpOpen));
  if (app.helpOpen) audio.suspend();
  else if (!app.muted && !app.paused) audio.resume();
  return app.helpOpen;
}

function toggleHelp() {
  const open = setHelp(!app.helpOpen);
  el.help.setAttribute('aria-label', open ? '关闭玩法说明' : '玩法说明');
  return open;
}

// ---- wiring --------------------------------------------------------------

function toast(msg) {
  el.toast.hidden = false;
  el.toast.textContent = msg;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

function shareLink() {
  const url = `${location.origin}${location.pathname}${linkFor(parseHash())}`;
  const done = () => toast('链接已复制，对方打开就是这一本码');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => toast(url));
  } else {
    toast(url);
  }
}

function restart() {
  // A restart from the pause card or the help card has to unfreeze as well as refill, or the new
  // board arrives already frozen.
  setPaused(false);
  setHelp(false);
  clearTimeout(toast.timer);
  toast.timer = 0;
  el.toast.hidden = true;
  const g = app.game;
  reset(g);
  app.hints = 0;
  el.curtain.hidden = true;
  view.setGame(g);
  view.resetClock();
  render(`重开 · 码本 ${g.size} 码 · 精确值 ${g.par} 次必破`);
}

el.submit.addEventListener('click', commit);
// The three mode buttons in the header were wired to nothing — aria-current said which mode you
// were in, and clicking the others did not change it. They route, exactly like a hand-typed hash
// would, so campaign/daily/random are reachable without knowing the URL grammar.
el.modes.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || !b.dataset.mode) return;
  const m = b.dataset.mode;
  if (m === 'daily') go('#/daily');
  else if (m === 'random') go(linkFor({
    mode: 'random',
    tier: app.lot ? app.lot.tier : TIERS[0].key,
    key: String(rngFrom(`btn-${Date.now()}`).int(1e6)),
  }));
  else go(`#/c/${app.index || store.unlocked}`);
});
el.take.addEventListener('click', () => {
  if (!playing()) return;
  if (take(app.game)) {
    audio.play('take');
    view.setGame(app.game);
    render(`这行还剩 ${SPACE.L - app.game.draft.length} 格`);
  }
});
el.undo.addEventListener('click', () => {
  if (!playing()) return;
  if (undo(app.game)) {
    audio.play('take');
    el.curtain.hidden = true;
    view.setGame(app.game);
    render(`退回一步 · 候选 ${app.game.cands.length} 个`);
  }
});
el.hint.addEventListener('click', doHint);
el.restart.addEventListener('click', restart);
el.share.addEventListener('click', shareLink);
el.again.addEventListener('click', restart);
el.next.addEventListener('click', () => go(`#/c/${Math.min(LEVELS, (app.index || 1) + 1)}`));
// The system row is reachable by click and by key; both go through the same four functions so
// the button state can never disagree with what the keyboard did.
el.pause.addEventListener('click', togglePause);
el.resume.addEventListener('click', () => { setPaused(false); render('继续 · 回到牌桌'); });
el.mute.addEventListener('click', toggleMute);
el.fullscreen.addEventListener('click', toggleFullscreen);
el.help.addEventListener('click', toggleHelp);
el.helpclose.addEventListener('click', () => { setHelp(false); render('按 1–6 或点色板放第一枚 peg'); });
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('webkitfullscreenchange', syncFullscreen);
if (MOTION_QUERY) {
  const onMotion = (ev) => {
    app.reducedMotion = !!(ev && ev.matches);
    view.setReducedMotion(app.reducedMotion);
  };
  if (MOTION_QUERY.addEventListener) MOTION_QUERY.addEventListener('change', onMotion);
  else if (MOTION_QUERY.addListener) MOTION_QUERY.addListener(onMotion);
}
// A hidden tab pauses. Left alone, the rAF loop stops firing anyway and the elapsed time would
// come back as one giant dt on return — pausing makes that a feature instead of an accident.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    setPaused(true);
    audio.suspend();
  } else if (!app.muted) {
    audio.resume();
  }
});

// Wiping the save is the one destructive thing this game can do, so it asks twice instead of
// firing on a stray click.
let wipeArmed = false;
el.wipe.addEventListener('click', () => {
  if (!wipeArmed) {
    wipeArmed = true;
    toast('再点一次会清空本机全部成绩');
    setTimeout(() => { wipeArmed = false; }, 4000);
    return;
  }
  store.reset();
  wipeArmed = false;
  toast('存档已清空');
  apply();
});

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => view.measure());
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key;
  const low = k.toLowerCase();
  // System keys answer in every state — a muted board is still muted while the curtain is up.
  if (low === 'm') { ev.preventDefault(); toggleMute(); return; }
  if (low === 'f') { ev.preventDefault(); toggleFullscreen(); return; }
  if (low === 'h' || k === '?') { ev.preventDefault(); toggleHelp(); return; }
  if (low === 'p' || k === ' ' || k === 'Spacebar') {
    ev.preventDefault();
    if (app.helpOpen) setHelp(false);
    else togglePause();
    return;
  }
  if (k === 'Escape') {
    // Escape dismisses whatever is on top; only with nothing open does it mean "this row, all of
    // it, never mind" — the one use of core's clearDraft.
    if (app.helpOpen) { setHelp(false); return; }
    if (!el.pausecard.hidden) { setPaused(false); render('继续 · 回到牌桌'); return; }
    if (!el.curtain.hidden) { el.curtain.hidden = true; return; }
    const g = app.game;
    if (g && playing() && g.draft.length) {
      clearDraft(g);
      view.setGame(g);
      render(`这一行清空了 · 码本还是 ${g.cands.length} 个候选`);
    }
    return;
  }
  if (!playing()) return;
  const g = app.game;
  if (!g) return;
  if (low === 'r') { ev.preventDefault(); restart(); return; }
  if (g.done) return;
  if (k >= '1' && k <= String(SPACE.C)) {
    if (put(g, Number(k) - 1)) {
      audio.play('put', Number(k) - 1);
      view.setGame(g);
      render(`这行 ${g.draft.length}/${SPACE.L}`);
    }
  } else if (k === 'Backspace') {
    ev.preventDefault();
    el.take.click();
  } else if (k === 'Enter') {
    ev.preventDefault();
    commit();
  } else if (low === 'u') {
    el.undo.click();
  } else if (low === 't') {
    el.hint.click();
  }
});

view = createView(el.canvas, {
  space: SPACE,
  onPalette(c) {
    if (!playing()) return;
    const g = app.game;
    if (put(g, c)) {
      audio.play('put', c);
      view.setGame(g);
      render(g.draft.length === SPACE.L ? '按“提交这一行”，或点 peg 拿掉一枚' : `这行 ${g.draft.length}/${SPACE.L}`);
    } else {
      audio.play('illegal');
      render('<span class="warn">这行满了，先提交或先拿掉一枚</span>');
    }
  },
  onPeg(col) {
    if (!playing()) return;
    const g = app.game;
    if (col < g.draft.length) {
      g.draft.splice(col, 1);
      audio.play('take');
      view.setGame(g);
      render(`拿掉第 ${col + 1} 枚`);
    }
  },
  onRow(row) {
    if (!playing()) return;
    const r = app.game.rows[row];
    if (r) render(`第 ${row + 1} 行：${SPACE.format(r.guess)} → ${r.black} 黑 ${r.white} 白 · 当时剩 ${r.left} 个候选`);
  },
});
// The OS preference and the save file are both read before the first frame, so the board never
// animates once under reduce-motion and the speaker icon never claims sound is on when it is not.
view.setReducedMotion(app.reducedMotion);
setMuted(app.muted);

// The view owns one dt-driven rAF loop that parks itself once the row has landed and the desk has
// stopped breathing; the shell drives the first measure explicitly so the board is drawn before
// any test probes a point on it.
apply();

// Installable, but only where a service worker is legal. Over file:// (a double-clicked
// index.html, or any shell that forgot an origin) the registration either rejects or starts
// caching a directory listing, so it is skipped outright — and the rejection is swallowed here
// rather than left to surface as an uncaught error on every desktop open.
function registerShell() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(false);
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return Promise.resolve(false);
  return navigator.serviceWorker.register('sw.js')
    .then(() => true, () => false);
}
app.sw = false;
registerShell().then((ok) => { app.sw = ok; });

window.tango = {
  version: 1,
  get state() {
    const g = app.game;
    const lot = app.lot;
    return {
      mode: app.mode,
      label: app.label,
      id: lot && lot.id,
      tier: lot && lot.tier,
      index: app.index,
      size: lot && lot.size,
      bound: lot && lot.bound,
      par: lot && lot.par,
      value: lot && lot.value,
      floor: lot && lot.floor,
      R: SPACE.R,
      L: SPACE.L,
      N: SPACE.N,
      cands: g && g.cands.length,
      draft: g ? g.draft.slice() : null,
      rows: g ? g.rows.map((r) => ({ guess: r.guess, black: r.black, white: r.white, left: r.left })) : null,
      guesses: g && guessesUsed(g),
      hints: app.hints,
      done: !!(g && g.done),
      won: !!(g && g.won),
      grade: g ? grade(g).key : null,
      unlocked: store.unlocked,
      broken: store.totals().atPar,
      persist: CAN_PERSIST,
      baked: bakedAt,
      curtain: !el.curtain.hidden,
      line: el.hintline.textContent,
      day: app.day,
      // System state, because "is pause real?" is only answerable from the outside: `paused` has
      // to agree with `view.clock` standing still and the AudioContext being suspended.
      paused: app.paused,
      muted: app.muted,
      audio: audio.state,
      voices: audio.voicesCreated,
      fullscreen: app.fullscreen,
      help: app.helpOpen,
      pausecard: !el.pausecard.hidden,
      reducedMotion: app.reducedMotion,
      sw: app.sw,
      view: view.stats(),
    };
  },
  get pool() { return poolStats(); },
  get tiers() { return TIERS; },
  load(hash) { go(hash); return app.lot && app.lot.id; },
  // Where a peg and a palette swatch are, in client pixels: what an automated finger needs to
  // press the thing it means instead of redoing the layout maths.
  pegPoint(row, col) { return view.pegPoint(row, col); },
  palettePoint(c) { return view.palettePoint(c); },
  buttonPoint(id) {
    const b = el[id];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  },
  lot() { return app.lot ? { id: app.lot.id, book: app.lot.book.slice(), secret: app.lot.secret, par: app.lot.par } : null; },
  cands() { return app.game ? app.game.cands.slice() : null; },
  digitsOf(guess) { return digitsOf(guess); },
  // The move the baked strategy would play from exactly this position, and whether the strategy
  // covers it. Read-only: the driver uses this to aim clicks; it does not press them.
  hintMove() { const h = hint(app.game); return h ? { ...h, digits: digitsOf(h.guess), code: SPACE.format(h.guess) } : null; },
  hintOnce() { el.hint.click(); return { hints: app.hints, line: el.hintline.textContent }; },
  press(colour) { put(app.game, colour); view.setGame(app.game); render(); return app.game.draft.length; },
  tapSubmit() { commit(); return guessesUsed(app.game); },
  autoPlay(limit = 8) {
    let n = 0;
    while (!app.game.done && n < limit) {
      const h = hint(app.game);
      if (!h) break;
      for (const c of digitsOf(h.guess)) put(app.game, c);
      commit();
      n++;
    }
    return { guesses: guessesUsed(app.game), won: app.game.won, done: app.game.done };
  },
  store,
  els: el,
  // The system controls, callable exactly as a click calls them — a harness that reached for
  // `el.pause.click()` would get the same thing, and this says which one is the contract.
  togglePause() { return togglePause(); },
  toggleMute() { return toggleMute(); },
  toggleFullscreen() { return toggleFullscreen(); },
  toggleHelp() { return toggleHelp(); },
  frames() { return view.stats(); },
  audioState() { return { state: audio.state, voices: audio.voicesCreated, muted: audio.muted }; },
};

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页 HUD 上真实存在的那个按钮。全屏最常见的假实现就是引用一个并不存在的
// id：点下去什么也不会发生，量具却算它"已实现"。所以这里找不到按钮就直接不装。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  // supported 这枚标记不能省：下面 sync() 每次都会重写 title，不挡住的话，装的时候刚写
  // 进去的人话原因会被随后的 sync() 立刻抹成"全屏 (F)"——禁用就变成一句没有理由的禁用。
  let supported = !!req;
  const unsupported = () => {
    supported = false;
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则用户已经退出、HUD 还停在"退出全屏"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    if (supported) btn.title = "全屏" + '（F）';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 盘号 / 种子这类输入框里打字不能触发全屏，否则玩家输 seed 输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();

// ---- 减弱动效（prefers-reduced-motion）----
//
// 跟住系统设置，而且**运行中改设置要立刻生效**：只读一次 matchMedia 不够，玩家在系统里
// 把开关拨回来，页面还停在上一次读到的答案上。addEventListener 是标准接口，老 Safari 只有
// addListener —— 特性探测，不做 UA 判断。
const motionQuery = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)') : null;
function applyReduceMotion(on) { view.setReduceMotion(on); }
if (motionQuery) {
  applyReduceMotion(motionQuery.matches);
  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', (e) => applyReduceMotion(e.matches));
  } else if (typeof motionQuery.addListener === 'function') {
    motionQuery.addListener((e) => applyReduceMotion(e.matches));
  }
}
window.tango.setReduceMotion = applyReduceMotion;
window.tango.isReducedMotion = () => view.isReducedMotion();
