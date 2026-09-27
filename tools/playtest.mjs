// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch). Zero deps,
// no Playwright — the whole contract.
// env: CDP_PORT (devtools port, default 9351 — deliberately off gridlock's 9340: one machine,
//      several repos, only one headless Chrome may run at a time),
//      BASE_URL (page to attach to, default http://127.0.0.1:5191/)
// usage:
//   node playtest.mjs open  <url>          # reuse-or-create our page and navigate
//   node playtest.mjs nav   <url>
//   node playtest.mjs eval  '<js expression>'   # pass `nonav` to skip the reload
//   node playtest.mjs eval  '@boot' nonav   # | @play | @routes | @save | @pointer
//   node playtest.mjs shot  <path.png>
//   node playtest.mjs logs
//
// Every scenario reports { rows, fail } in the same shape as tools/harness.mjs, so
// tools/verify.sh aggregates node suites and browser suites on one line.
const PORT = process.env.CDP_PORT || 9351;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5191/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Wait on the shell, not on a timer (the lesson gridlock paid for in full): the page is a
  // module graph fetched over the network, and a fixed sleep that works on localhost shows the
  // canvas as an unstyled 300x150 box against GitHub Pages.
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.tango && window.tango.state && window.tango.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      if (name === 'pointer') {
        value = await pointerScenario(cdp, sessionId, runJS);
      } else if (SCENARIOS[name]) {
        try {
          value = await runJS(SCENARIOS[name]);
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer');
        process.exit(1);
      }
      value.fail = (value.rows || []).filter((r) => !r.pass).map((r) => r.test);
      console.log(JSON.stringify(value, null, 2));
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
    }
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  }
  ws.close();
  process.exit(0);
}

// ---- the one suite a page-side script cannot run: real input ----------------
// Everything below goes through Chrome's own mouse and keyboard over CDP. Page-side JS can
// prove commit() is right; only a dispatched mouse event proves a finger can reach the peg.
async function pointerScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0,
  }, sessionId);
  const click = async (p) => {
    await mouse('mousePressed', p.x, p.y, 1);
    await sleep(40);
    await mouse('mouseReleased', p.x, p.y, 0);
    await sleep(90);
  };
  const keyDown = (k, code, vk) => {
    const base = { key: k, code, windowsVirtualKeyCode: vk };
    const pressParams = k.length === 1 ? { ...base, text: k, type: 'keyDown' } : { ...base, type: 'keyDown' };
    return cdp.send('Input.dispatchKeyEvent', pressParams, sessionId)
      .then(() => cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sessionId));
  };

  // Reset + load, then WAIT for the route to settle: go() applies the lot through the hashchange
  // listener, so reading state.id on the same synchronous tick returns whatever the previous
  // suite (@save) left on screen. Bounded poll, exactly like the @routes scenario's sleeps.
  await runJS(`(() => { const t = window.tango; t.store.reset(); t.load('#/lot/glance-01'); return 1; })()`);
  let fresh = null;
  for (let i = 0; i < 40; i++) {
    await sleep(80);
    fresh = await runJS(`(() => { const t = window.tango; return { id: t.state.id, par: t.state.par, size: t.state.size, L: t.state.L, C: 6 }; })()`);
    if (fresh && fresh.id === 'glance-01') break;
  }
  rec('a par-2 lot loads for the pointer run', !!fresh && fresh.id === 'glance-01' && fresh.par === 2, fresh);

  const ids = await runJS(`['submit','take','undo','hint','restart','curtain','stars','bookcount','chips'].map((i) => [i, !!document.getElementById(i)])`);
  rec('every control the shell reaches for exists', ids.every(([, on]) => on), Object.fromEntries(ids));

  // --- real click #1..#4: the palette, exactly where view.js says a swatch is drawn.
  const move1 = await runJS(`(() => { const h = window.tango.hintMove(); return h && { guess: h.guess, digits: h.digits, exact: h.exact, left: h.left }; })()`);
  rec('the baked policy answers the opening position with a certified move', move1 && move1.exact === true, move1);
  for (const d of move1.digits) {
    const p = await runJS(`window.tango.palettePoint(${d})`);
    await click(p);
  }
  const draftAfter = await runJS(`window.tango.state.draft`);
  rec('four palette clicks put four pegs down', JSON.stringify(draftAfter) === JSON.stringify(move1.digits), { want: move1.digits, got: draftAfter });

  // A fifth colour click on a full row must bounce, not replace.
  const pFull = await runJS(`window.tango.palettePoint(0)`);
  await click(pFull);
  const draftBounce = await runJS(`window.tango.state.draft`);
  rec('a click on a full row adds nothing and says the row is full',
    JSON.stringify(draftBounce) === JSON.stringify(move1.digits) && /满了/.test(await runJS(`window.tango.state.line`)),
    { draft: draftBounce, line: await runJS(`window.tango.state.line`) });

  // --- real click: the RETRACT button shortens the row by one.
  const takeP = await runJS(`window.tango.buttonPoint('take')`);
  await click(takeP);
  const draftTake = await runJS(`window.tango.state.draft`);
  rec('退一枚 clicked for real lifts exactly the last peg', draftTake.length === move1.digits.length - 1, draftTake);

  // --- real keyboard: Escape empties the row in progress (js/core/game.js clearDraft, wired in
  // the shell; the export would otherwise be a ghost).
  for (const d of move1.digits) await click(await runJS(`window.tango.palettePoint(${d})`));
  await keyDown('Escape', 'Escape', 27);
  await sleep(120);
  const draftEsc = await runJS(`window.tango.state.draft`);
  rec('Escape clears the drafted row (clearDraft is not a ghost export)', Array.isArray(draftEsc) && draftEsc.length === 0, draftEsc);

  // --- illegal submit by hand: three pegs, then the real button.
  for (let i = 0; i < 3; i++) await click(await runJS(`window.tango.palettePoint(${move1.digits[i]})`));
  const beforeBad = await runJS(`({ g: window.tango.state.rows.length, c: window.tango.state.cands })`);
  await click(await runJS(`window.tango.buttonPoint('submit')`));
  const afterBad = await runJS(`({ g: window.tango.state.rows.length, c: window.tango.state.cands, line: window.tango.state.line })`);
  rec('a three-peg row cannot be submitted by mouse',
    afterBad.g === beforeBad.g && afterBad.c === beforeBad.c && /还差 1 枚/.test(afterBad.line), afterBad);

  // --- the certified win, by clicks only: policy ply 1, then the forced finisher.
  // (row currently holds the first three digits — top it up to four, then submit)
  if ((await runJS(`window.tango.state.draft.length`)) < 4) {
    await click(await runJS(`window.tango.palettePoint(${move1.digits[3]})`));
  }
  await click(await runJS(`window.tango.buttonPoint('submit')`));
  const afterPly1 = await runJS(`(() => {
    const t = window.tango;
    const r = t.state.rows[t.state.rows.length - 1];
    return { rows: t.state.rows.length, last: r, cands: t.state.cands, won: t.state.won, left: t.hintMove() && t.hintMove().guess };
  })()`);
  // Independently recompute the feedback the screen claims, from the shipped rule.
  const recheck = await runJS(`(async () => {
    const { SPACE } = await import('/js/core/codes.js');
    const { consistent } = await import('/js/core/book.js');
    const t = window.tango, lot = t.lot(), r = t.state.rows[0];
    const [b, w] = SPACE.blackWhite(r.guess, lot.secret);
    return { b, w, left: consistent(SPACE, lot.book, r.guess, SPACE.fbIndex(r.guess, lot.secret)).length,
      survivors: t.cands().every((c) => SPACE.fbIndex(r.guess, c) === SPACE.fbIndex(r.guess, lot.secret)) };
  })()`);
  rec('ply 1 by mouse bills one row with the hand-checkable feedback',
    afterPly1.rows === 1 && afterPly1.last.black === recheck.b && afterPly1.last.white === recheck.w,
    { shown: afterPly1.last, recomputed: recheck });
  rec('剩余候选 shrinks to exactly what the two-pass rule leaves',
    afterPly1.cands === recheck.left && recheck.survivors, { cands: afterPly1.cands, expect: recheck.left });

  if (!afterPly1.won) {
    const finisher = await runJS(`(() => { const h = window.tango.hintMove(); return h && { digits: h.digits, kind: h.kind, exact: h.exact }; })()`);
    rec('the finisher position is honest about being forced (one candidate left)',
      finisher && (finisher.exact === true || (await runJS(`window.tango.state.cands`)) === 1), finisher);
    for (const d of finisher.digits) await click(await runJS(`window.tango.palettePoint(${d})`));
    await click(await runJS(`window.tango.buttonPoint('submit')`));
  }
  const end = await runJS(`(() => {
    const t = window.tango;
    return { won: t.state.won, done: t.state.done, guesses: t.state.guesses, par: t.state.par,
      stars: document.getElementById('stars').textContent,
      verdict: document.getElementById('verdict').textContent,
      curtain: !document.getElementById('curtain').hidden,
      record: t.store.record(t.state.id) };
  })()`);
  rec('the whole certified solution plays out under real mouse events',
    end.won && end.guesses <= end.par, end);
  rec('终点判定: the card goes up at exactly black=4, three stars at par',
    end.curtain && end.stars === '★★★' && end.verdict === '当庭破码', end);
  rec('the mouse-played solve reaches the save file',
    !!end.record && end.record.solved === true && end.record.best === end.guesses, end.record);

  // 原地点击不动: press and release on the same already-locked row must not touch the game.
  const row0 = await runJS(`window.tango.pegPoint(0, 1)`);
  const beforeIdle = await runJS(`({ g: window.tango.state.guesses, c: window.tango.state.cands, d: window.tango.state.draft })`);
  await click(row0);
  await click(row0);
  const afterIdle = await runJS(`({ g: window.tango.state.guesses, c: window.tango.state.cands, d: window.tango.state.draft })`);
  rec('clicking a locked row in place moves nothing',
    afterIdle.g === beforeIdle.g && afterIdle.c === beforeIdle.c && afterIdle.d.length === 0,
    { before: beforeIdle, after: afterIdle });

  // 非法位置: dead space below the palette is not a control.
  const dead = await runJS(`(() => {
    const b = document.getElementById('board').getBoundingClientRect();
    return { x: Math.round(b.right - 6), y: Math.round(b.bottom - 6) };
  })()`);
  await click(dead);
  rec('a click on the dead corner of the board does nothing',
    (await runJS(`window.tango.state.guesses`)) === afterIdle.g, dead);

  // Terminal lock (win detection at the input layer): once the lot is won the shell DISABLS the
  // submit control (main.js: el.submit.disabled = g.done) and covers it with the curtain, so a
  // real finger on submit bills nothing. The core submit() also carries an 'over' reason, but the
  // shell never reaches it once done — that guard is proven in test/game.test.mjs, not here.
  const submitState = await runJS(`({ disabled: document.getElementById('submit').disabled, curtain: !document.getElementById('curtain').hidden })`);
  await click(await runJS(`window.tango.buttonPoint('submit')`));
  const over = await runJS(`({ g: window.tango.state.guesses, c: window.tango.state.cands, won: window.tango.state.won })`);
  rec('after the win submit is disabled and a real click bills nothing',
    submitState.disabled === true && submitState.curtain === true
    && over.g === afterIdle.g && over.won === true, { submitState, over });

  // Re-entering the code by clicks: restart for real, then verify the board is blank.
  await click(await runJS(`window.tango.buttonPoint('restart')`));
  const fresh2 = await runJS(`({ g: window.tango.state.guesses, c: window.tango.state.cands, size: window.tango.state.size, curtain: window.tango.state.curtain })`);
  rec('重开 clicked for real restores the full book',
    fresh2.g === 0 && fresh2.c === fresh2.size && !fresh2.curtain, fresh2);

  return { rows };
}

// ---- in-page suites: each returns { rows: [{ test, pass, detail }] } --------
const SCENARIOS = {
  boot: `(async () => {
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const { SPACE, infoBound, valueFloor } = await import('/js/core/codes.js');
    const g = window.tango;
    rec('the shell boots straight into a game', g && g.version === 1 && g.state.mode === 'campaign' && g.state.id, g && g.state);
    const c = document.getElementById('board');
    rec('the canvas has real pixels', c.width > 0 && c.height > 0 && !!c.getContext('2d'), { w: c.width, h: c.height });
    const lit = (() => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
      return n;
    })();
    rec('the board was actually painted', lit > 50, { litSamples: lit });
    const pool = g.pool;
    rec('the shipped pool loaded', pool && pool.lots >= 24, pool && pool.lots);
    rec('four measured bands, one per exact value', g.tiers.length === 4 && new Set(g.tiers.map((t) => t.value)).size === 4, g.tiers.map((t) => [t.key, t.value]));
    rec('no band overlaps another', g.tiers.every((t) => t.min === t.max && t.value === t.min), g.tiers);
    const s = g.state;
    rec('the three numbers on the panel are consistent', s.bound === infoBound(SPACE, s.size) && s.floor === valueFloor(SPACE, s.size) && s.par >= s.floor && s.par >= 2, s);
    rec('R is a property of the space, not of the lot', s.R === SPACE.R && s.R === 15, { r: s.R });
    const readout = document.getElementById('readout').textContent;
    rec('the panel prints |S|, 下界, 精确值, 已用, 剩余候选 and R together',
      /码本/.test(readout) && /下界/.test(readout) && /精确值/.test(readout) && /已用/.test(readout) && /剩余候选/.test(readout) && /反馈种类/.test(readout), readout);
    rec('the crumbs tooltip stamps when the pool was baked', /^\\d{4}-\\d{2}-\\d{2}T/.test((document.getElementById('crumbs').title.match(/\\d{4}.*/) || [''])[0]), document.getElementById('crumbs').title);
    rec('this origin can persist', s.persist === true, { persist: s.persist });
    rec('the drawer counts candidates out loud', /\\(\\d+\\)/.test(document.getElementById('bookcount').textContent), document.getElementById('bookcount').textContent);
    return { rows };
  })()`,

  play: `(async () => {
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const { SPACE, makeSpace } = await import('/js/core/codes.js');
    const { consistent } = await import('/js/core/book.js');
    const t = window.tango;
    const D = (id) => document.getElementById(id);
    t.store.reset();

    t.load('#/lot/glance-01'); await sleep(160);
    rec('the page and a hand-built space agree on the space', t.state.R === 15 && t.state.L === 4 && t.state.N === 1296 && makeSpace().R === SPACE.R, t.state);

    // The certified line, played via commit(): win inside par on a value-2 book.
    const play = t.autoPlay(3);
    await sleep(160);
    rec('the baked policy wins a glance lot inside par', play.won && play.guesses <= t.state.par, play);
    rec('and the card celebrates with the par it promised',
      D('curtain').hidden === false && D('stars').textContent === '★★★' && new RegExp('精确值是 <b>' + t.state.par + '</b>').test(D('tally').innerHTML),
      { stars: D('stars').textContent, tally: D('tally').textContent });

    D('restart').click(); await sleep(150);
    rec('重开 clears rows, card and candidate loss', t.state.guesses === 0 && t.state.cands === t.state.size && D('curtain').hidden, t.state);

    // Illegal move: a short row is refused by the rules, not just the button.
    t.press(0); t.press(0); t.press(0);
    const g0 = t.state.guesses;
    t.tapSubmit();
    rec('submitting three pegs bills nothing and explains the shortfall',
      t.state.guesses === g0 && /还差 1 枚/.test(t.state.line), { line: t.state.line });

    // Legal-but-wasteful: the repeat costs a guess and is flagged. (Fresh board first: the
    // refused row above left its three pegs on the draft.)
    D('restart').click(); await sleep(120);
    const lot = t.lot();
    const wrong = (lot.secret + 1) % SPACE.N; // by construction not the secret
    for (const d of SPACE.digits.slice(wrong * 4, wrong * 4 + 4)) t.press(d);
    t.tapSubmit();
    const midRows = t.state.rows.length;
    for (const d of SPACE.digits.slice(wrong * 4, wrong * 4 + 4)) t.press(d);
    t.tapSubmit(); await sleep(120);
    rec('a repeated row is legal, flagged, and billed as a guess',
      t.state.rows.length === midRows + 1 && /猜过了/.test(t.state.line), { rows: t.state.rows.length, line: t.state.line });

    // The live shrink is the O(|S|) filter, verified against the shipped implementation itself.
    const check = (() => {
      const r = t.state.rows[t.state.rows.length - 1];
      const expect = consistent(SPACE, lot.book, r.guess, SPACE.fbIndex(r.guess, lot.secret)).length;
      return { shown: r.left, expect, ok: t.state.cands === expect };
    })();
    rec('剩余候选 equals the independent consistent() recompute', check.ok && check.shown === check.expect, check);

    // The hint button bills and speaks; off a glance par it may fall back and must admit it.
    D('restart').click(); await sleep(120);
    const h = t.hintOnce();
    rec('提示 names the certified move and counts itself',
      t.state.hints === 1 && /(策略表|没存过)/.test(h.line), h);

    // The 10-row ceiling: ten non-winning rows fail the lot, not crash it.
    D('restart').click(); await sleep(120);
    const miss = (lot.secret + 7) % SPACE.N; // also not the secret, and not the repeat-row guess
    for (let i = 0; i < 10; i++) {
      for (const d of SPACE.digits.slice(miss * 4, miss * 4 + 4)) t.press(d);
      t.tapSubmit();
    }
    await sleep(120);
    rec('十行用完 ends the lot as failed, never won', t.state.done === true && t.state.won === false && t.state.guesses === 10, t.state);
    rec('and the loss card says the code is still out there', /密码还在/.test(D('verdict').textContent), D('verdict').textContent);
    return { rows };
  })()`,

  routes: `(async () => {
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = window.tango;
    t.store.reset();

    t.load('#/c/7'); await sleep(150);
    rec('#/c/7 is level seven', t.state.index === 7 && t.state.mode === 'campaign', t.state);
    t.load('#/c/99999'); await sleep(150);
    rec('a huge index clamps to the last level', t.state.index === t.pool.lots, { index: t.state.index, lots: t.pool.lots });
    t.load('#/c/0'); await sleep(150);
    rec('index zero clamps up to one', t.state.index === 1, t.state.index);

    t.load('#/daily'); await sleep(150);
    const daily = t.state.id;
    t.load('#/c/1'); await sleep(150);
    t.load('#/daily'); await sleep(150);
    rec('the daily route is the same puzzle twice', t.state.mode === 'daily' && t.state.id === daily, { first: daily, again: t.state.id });
    rec('the daily label carries the date', /^每日破码 · \\d{4}-\\d{2}-\\d{2}$/.test(t.state.label), t.state.label);

    for (const tier of Object.keys(t.pool.byTier)) {
      t.load('#/random/' + tier + '/fixedseed'); await sleep(140);
      const first = t.state.id;
      t.load('#/c/1'); await sleep(140);
      t.load('#/random/' + tier + '/fixedseed'); await sleep(140);
      rec('#/random/' + tier + ' stays in its band and repeats itself', t.state.tier === tier && t.state.id === first, { tier: t.state.tier, id: t.state.id, first });
    }
    t.load('#/random'); await sleep(220);
    rec('a bare #/random mints a token INTO the URL (share-safe)', /^#\\/random\\/[a-z]+\\/\\d+$/.test(location.hash), location.hash);
    t.load('#/random/grind/seedA'); await sleep(140);
    const a = t.state.id;
    t.load('#/random/grind/seedB'); await sleep(140);
    rec('two seeds both resolve into the grind band', !!a && t.state.tier === 'grind', { a, b: t.state.id });

    t.load('#/lot/probe-01'); await sleep(140);
    rec('#/lot/<id> opens that lot', t.state.id === 'probe-01', t.state.id);
    t.load('#/lot/not-a-real-lot'); await sleep(200);
    rec('an unknown lot id falls back instead of blanking the board', !!t.state.id && t.state.mode === 'campaign', t.state);

    document.querySelector('#modes button[data-mode=daily]').click(); await sleep(160);
    rec('the header 每日 button routes (it was dead wiring once)', t.state.mode === 'daily', t.state.mode);
    document.querySelector('#modes button[data-mode=campaign]').click(); await sleep(160);
    rec('and the 战役 button routes back', t.state.mode === 'campaign', t.state.mode);
    return { rows };
  })()`,

  save: `(async () => {
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t = window.tango;
    const D = (id) => document.getElementById(id);
    const KEY = 'tango.save.v1';

    t.store.reset();
    t.load('#/lot/glance-01'); await sleep(160);
    rec('a wiped save is empty', Object.keys(t.store.records).length === 0 && t.store.unlocked === 1 && localStorage.getItem(KEY) === null, { unlocked: t.store.unlocked });

    t.autoPlay(3); await sleep(160);
    const id = t.state.id;
    const raw = JSON.parse(localStorage.getItem(KEY));
    rec('the solve reaches localStorage, not only memory', !!(raw && raw.records[id] && raw.records[id].solved), raw && Object.keys(raw.records || {}));
    rec('clearing an early campaign lot unlocks the next', raw.unlocked >= 2, { unlocked: raw.unlocked });

    // best only goes DOWN: hand the store a worse and a better run directly.
    const g0 = t.state.guesses;
    t.store.solve(id, { guesses: 9, par: 2, hints: 0, rows: 9, won: true });
    rec('a worse replay cannot raise best', t.store.record(id).best === g0, t.store.record(id));
    t.store.solve(id, { guesses: 1, par: 2, hints: 0, rows: 1, won: true });
    rec('an impossible-looking 1 still only lowers best', t.store.record(id).best === 1, t.store.record(id));
    t.store.solve(id, { guesses: 4, par: 2, hints: 0, rows: 4, won: false });
    rec('a loss changes plays, not the record', t.store.record(id).best === 1 && t.store.record(id).plays >= 4, t.store.record(id));

    // unlock only goes UP.
    const u0 = t.store.unlock(3);
    t.store.unlock(1);
    rec('unlock never goes backwards', t.store.unlocked === 3 && u0 === 3, { u0, now: t.store.unlocked });

    // the daily log.
    t.load('#/daily'); await sleep(160);
    const day = t.state.day || t.state.label.split(' · ')[1];
    t.autoPlay(6); await sleep(160);
    const mark = t.store.dailyDone(day);
    rec('today is logged once solved', !!mark && mark.done && mark.id === t.state.id, { day, mark });
    rec('dailyDone for another day is null', t.store.dailyDone('1999-01-01') === null, null);

    // the two-click wipe.
    D('wipe').click(); await sleep(80);
    rec('the first click only arms it', Object.keys(t.store.records).length > 0, { records: Object.keys(t.store.records) });
    D('wipe').click(); await sleep(200);
    rec('清空存档 takes two clicks and clears everything',
      Object.keys(t.store.records).length === 0 && t.store.unlocked === 1 && localStorage.getItem(KEY) === null,
      { records: Object.keys(t.store.records), unlocked: t.store.unlocked, raw: localStorage.getItem(KEY) });
    return { rows };
  })()`,
};

main().catch((err) => {
  console.error('playtest failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
