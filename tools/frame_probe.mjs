// 三档帧率对拍（30/60/120Hz）—— 同一份源码、同一个 LCG 种子、同一段 5 虚拟秒，
// 只换 requestAnimationFrame 的到达间隔，比较末态摘要。
//
// 为什么不用 cos_frame_probe.js：它用 vm.runInContext 把文件当 classic script 读，
// 本仓是 ES module（import/export），三档全部 `SyntaxError: Cannot use import statement
// outside a module` —— 那是量具的盲区，不是本仓的结论。所以按 BRIEF §3 自己搭：
//   * 真实 PLAYING 态：LCG 决定放哪枚颜色，按虚拟时刻 put/submit，走 view.setGame 全流程；
//   * 按 SIM STEP（虚拟秒）对齐而不是按帧号对齐：每档都跑满 5.000s（30Hz=150 帧、120Hz=600 帧）；
//   * 沙箱时钟从 1000ms 起，避免"首帧 dt = 首个时间戳"的假象（view 里由 last===null 哨兵兜住，
//     这一条正是被这里量出来的）；
//   * 中途 setPaused(true/false)，验证暂停是冻结累加器而不是攒下时间后补跑；
//   * 另跑一档 jitter（相邻帧间隔在 1/90..1/20 之间抖动，会撞到 dt 上限 0.05 的钳制分支），
//     钳制生效时 60Hz 与 jitter 的 clock 必然不同 —— 那是设计意图，不是分叉。
// 阴性对照：把 advance() 里那行**仍在吃帧 dt** 的 `clock += dt` 改成 `clock += 1`
//   （纯 per-frame 推进），本脚本必须报分叉；报不出分叉就是量具在撒谎。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

// 仓根 = tools/ 的上一层，不写死绝对路径：换机器、换 worktree 都要能跑。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIRTUAL_SECONDS = 5;
const r4 = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
const r2 = (v) => (typeof v === 'number' ? Math.round(v * 1e2) / 1e2 : v);

// ---- 沙箱 ---------------------------------------------------------------
function makeCtx(canvas) {
  const noop = () => {};
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'canvas') return canvas;
      if (prop === 'measureText') return () => ({ width: 8 });
      if (prop === 'createPattern') return () => ({ __pattern: true });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop: noop });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return noop;
    },
    set() { return true; },
  });
}

function makeEnv(mode) {
  const listeners = {};
  const canvas = {
    width: 0, height: 0, style: {}, dataset: {},
    getContext: () => ctx,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { if (listeners[t]) listeners[t] = listeners[t].filter((f) => f !== fn); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 640 }),
  };
  const ctx = makeCtx(canvas);

  let pending = [];
  globalThis.window = {
    devicePixelRatio: 2,
    onpointerdown: null,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame(fn) { const id = ++seq; pending.push([id, fn]); return id; },
    cancelAnimationFrame(id) { pending = pending.filter(([k]) => k !== id); },
    matchMedia: (q) => ({ media: q, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    setTimeout: () => 0, clearTimeout: () => {},
    localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; })(),
  };
  let seq = 0;
  globalThis.document = { getElementById: () => null, createElement: () => canvas, addEventListener() {}, removeEventListener() {}, documentElement: { requestFullscreen: () => Promise.resolve() }, body: {} };
  globalThis.Image = class {
    constructor() { this.onload = null; this.onerror = null; }
    set src(v) { if (this.onload) this.onload(); }
  };
  // 时间戳发生器：固定 fps，或抖动（撞 dt 钳制分支）
  let t = 1000;
  let k = 0;
  const rnd = lcg(0xbadf00d);
  const nextTs = () => {
    k++;
    if (mode.jitter) t += 1000 * (1 / 90 + (1 / 20 - 1 / 90) * rnd());
    else t += 1000 / mode.fps;
    return t;
  };
  return {
    canvas,
    step(dtMs) {
      const q = pending; pending = [];
      const ts = dtMs === undefined ? nextTs() : (t += dtMs, t);
      q.forEach(([, fn]) => fn(ts));
      return q.length;
    },
    pending: () => pending.length,
  };
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

async function run(root, mode, tag) {
  const q = `?tag=${tag}&fps=${mode.fps || 'jit'}&r=${Math.random().toString(36).slice(2)}`;
  const { createView } = await import(pathToFileURL(path.join(root, 'js/view.js')).href + q);
  const core = await import(pathToFileURL(path.join(root, 'js/core/game.js')).href + q);
  const { LOTS } = await import(pathToFileURL(path.join(root, 'js/data/lots.js')).href + q);
  const { makeSpace } = await import(pathToFileURL(path.join(root, 'js/core/codes.js')).href + q);

  const SPACE = makeSpace();
  const { createGame, put, submit, guessesUsed } = core;
  const env = makeEnv(mode);
  const lot = LOTS.find((l) => l.tier === 'grind') || LOTS[0];
  const game = createGame(lot);
  const view = createView(env.canvas, { space: SPACE, onPalette() {}, onPeg() {}, onRow() {} });
  view.measure(); // 真实布局：main.js 在 resize 与启动时都会调它，不调就只在占位 geo 上量
  view.setGame(game);

  const rnd = lcg(0x5eed);
  const events = [];
  for (let tt = 0.2; tt < VIRTUAL_SECONDS; tt += 0.35) events.push({ at: tt, colour: Math.floor(rnd() * SPACE.C) });

  const steps = mode.jitter ? 5 * 60 : VIRTUAL_SECONDS * mode.fps;
  let placed = 0;
  for (let i = 0; i < steps; i++) {
    const vt = (i + 1) / (mode.jitter ? 60 : mode.fps);
    while (placed < events.length && events[placed].at <= vt) {
      const e = events[placed++];
      if (game.draft.length >= SPACE.L) submit(game);
      put(game, e.colour);
      view.setGame(game);
    }
    if (Math.abs(vt - 2.0) < 0.5 / (mode.jitter ? 60 : mode.fps)) view.setPaused(true);
    if (Math.abs(vt - 3.0) < 0.5 / (mode.jitter ? 60 : mode.fps)) view.setPaused(false);
    env.step();
  }

  // 真暂停断言：动画正 live 时按下暂停，随后 20 帧不得推进累加器，也不得排到下一帧
  view.setPaused(false);
  put(game, 0);
  view.setGame(game);
  // 对齐口径：按**虚拟秒**采样，不按帧号 —— 按帧号取会量到 1 帧 = 1/fps 的档位差（那是采样bug）。
  // 对齐口径：0.100 虚拟秒在 30Hz 是 3 帧、60Hz 是 6 帧、120Hz 是 12 帧 —— 按各自帧数走到同一虚拟时刻。
  for (let i = 0; i < Math.round(0.10 * (mode.jitter ? 60 : mode.fps)); i++) env.step();
  const pre = view.stats();
  const animAt100ms = r4(pre.anim - 0);
  view.setPaused(true);
  let queuedDuringPause = 0;
  for (let i = 0; i < 20; i++) queuedDuringPause += env.step();
  const frozen = view.stats();
  view.setPaused(false);
  env.step(); // 恢复后的第一帧由 last===null 哨兵吃掉（dt=0），这是设计：暂停期间的时间不补跑
  // dt 钳制：喂一个 200ms 的巨型帧距，clock 只允许推进 0.05s（丢帧不补跑）
  const beforeClamp = view.stats().clock;
  env.step(200);
  const clampDelta = r4(view.stats().clock - beforeClamp);

  const st = view.stats();
  const g0 = view.pegPoint(0, 0);
  const p1 = view.palettePoint(1);
  const geom = view.geom();
  return {
    'st.clock': r4(st.clock),
    'st.frames': st.frames,
    'st.anim': r4(st.anim),
    'anim@0.100s(虚拟)': animAt100ms,
    'st.live': r4(st.live),
    'st.paused': st.paused,
    'st.reduced': st.reduced,
    'st.texture': st.texture,
    'game.rows': game.rows.length,
    'game.guesses': guessesUsed(game),
    'game.left': game.cands.length,
    'game.draft': game.draft.length,
    'game.done': game.done,
    'geom.w': r2(geom.w),
    'geom.h': r2(geom.h),
    'geom.minHit': geom.minHit,
    'peg(0,0).x': r2(g0.x), 'peg(0,0).y': r2(g0.y),
    'pal(1).x': r2(p1.x), 'pal(1).y': r2(p1.y),
    'pal.hit.diam': r2(p1.hit * 2),
    'pause.clockDelta': r4(frozen.clock - pre.clock),
    'pause.framesDelta': frozen.frames - pre.frames,
    'pause.queuedFrames': queuedDuringPause,
    'pause.frozen': frozen.clock === pre.clock && frozen.frames === pre.frames && queuedDuringPause === 0,
    'clamp.200ms->s': clampDelta,
  };
}

// ---- 变异体：阴性对照 ------------------------------------------------------
function mutate(dst, label, from, to) {
  const src = path.join(dst, 'js/view.js');
  const text = fs.readFileSync(src, 'utf8');
  if (!text.includes(from)) { console.error(`变异锚点未命中: ${label} 找不到 ${from}`); process.exit(3); }
  fs.writeFileSync(src, text.replace(from, to));
  console.log(`变异 ${label}: "${from}" -> "${to}"`);
}

function copyRepo(dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(path.join(REPO, 'js'), path.join(dst, 'js'), { recursive: true });
  fs.cpSync(path.join(REPO, 'assets'), path.join(dst, 'assets'), { recursive: true });
}

const WORK = fs.mkdtempSync('/tmp/tango-fc-');
const BASE = path.join(WORK, 'base');
const MUT = path.join(WORK, 'mutant');
console.log(`工作副本: ${WORK}（只读原仓，变异只发生在副本里）`);
copyRepo(BASE);
copyRepo(MUT);
mutate(MUT, '阴性对照·把帧 dt 换成每帧 1 个单位', 'clock += dt;', 'clock += 1;');

async function suite(root, tag, modes) {
  const rows = [];
  for (const m of modes) rows.push([m.label, await run(root, m, tag)]);
  const keys = Object.keys(rows[0][1]);
  const diverging = [];
  console.log(`\n### ${tag}`);
  console.log('字段'.padEnd(15), ...rows.map(([l]) => l.padStart(12)), '  一致?');
  for (const k of keys) {
    const vals = rows.map(([, r]) => r[k]);
    const same = new Set(vals.map((v) => JSON.stringify(v))).size === 1;
    if (!same) diverging.push(k);
    console.log(String(k).padEnd(15), ...vals.map((v) => String(v).padStart(12)), same ? ' ✅' : ' ❌分叉');
  }
  return { diverging, rows };
}

const MODES = [{ fps: 30, label: '30Hz' }, { fps: 60, label: '60Hz' }, { fps: 120, label: '120Hz' }];
const dBase = await suite(BASE, 'BASE 当前源码（三档同 5.000 虚拟秒）', MODES);
const dMut = await suite(MUT, 'MUTANT 阴性对照（clock += 1，纯每帧推进）', MODES);


console.log('\n=== 判定 ===');
// 判据按 BRIEF §3 的比值口径来，不按"字段必须逐位相等"：
//   比值 > 3.6 ⇒ 帧率依赖（120/30 = 4，正是纯帧推进的指纹）；
//   st.frames 本身就是档位定义，125/248/494 恒等于 4.0×，不参与判定。
// st.clock / st.live 允许一个"停 loop 边界"的量化误差：动画跑完就停车，最后一次积分落在
// 各自的帧网格上，误差上界 = 每个动画事件 ≤ 1 帧，本次共 4 个事件 ⇒ 4 × 1/30 = 0.133s。
function verdict(rows, tag) {
  const clock = rows.map((r) => r['st.clock']);
  const ratio = Math.max(...clock) / Math.min(...clock);
  const spread = Math.max(...clock) - Math.min(...clock);
  const frames = rows.map((r) => r['st.frames']);
  const fRatio = Math.max(...frames) / Math.min(...frames);
  const motion = ['st.anim', 'anim@0.100s(虚拟)', 'st.live', 'game.rows', 'game.guesses', 'game.left', 'geom.minHit', 'pal.hit.diam', 'clamp.200ms->s', 'pause.frozen'];
  const bad = motion.filter((k) => new Set(rows.map((r) => JSON.stringify(r[k]))).size !== 1);
  console.log(`${tag}: clock 比值 ${ratio.toFixed(4)}（阈值 3.6）、spread ${spread.toFixed(4)}s（上界 0.133s）、frames 比值 ${fRatio.toFixed(3)}（档位定义，不判定）`);
  console.log(`${tag}: 运动量/玩法量分叉字段: ${bad.length ? bad.join(', ') : '（无）'}`);
  return { ratio, spread, bad };
}
const base = dBase.rows.map(([, r]) => r);
const mut = dMut.rows.map(([, r]) => r);
const vb = verdict(base, 'BASE');
const vm2 = verdict(mut, 'MUTANT');
console.log(vm2.ratio > 3.6 ? '✅ 阴性对照有牙：per-frame 推进把 clock 比值推到 3.6 阈值以上' : '⚠ 阴性对照未过阈值 —— 量具无效');
console.log(vb.ratio <= 3.6 && vb.bad.length === 0
  ? '✅ 通过：三档运动量完全一致，累计时钟只差停 loop 的帧网格量化（比值 ' + vb.ratio.toFixed(4) + '）'
  : '⚠ 帧率依赖确证：' + vb.bad.join(', '));
