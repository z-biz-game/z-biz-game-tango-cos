// Canvas renderer + pointer handling. This file owns pixels and gestures and decides nothing
// about legality: a tap hands `main.js` a palette index or a peg position, and js/core/game.js
// is the only place that knows whether a row may be submitted. So the drawing can lag the
// rules but can never show a move the rules forbid.
//
// NOTHING HERE IS AN IMAGE. Pegs, the feedback slots and the palette are rounded rects and
// circles filled from the colour table in js/core/codes.js, which is why the repo has no asset
// directory and the whole game is a few kilobytes of text.
//
// The two exported probes are the contract with tools/playtest.mjs: `pegPoint(row, col)` and
// `palettePoint(c)` return CLIENT coordinates — the same mapping the click handler inverts, run
// forwards, so a headless Chrome can press exactly where a human would aim.

import { MAX_ROWS } from './core/game.js';
import { COLOR_SWATCH, COLOR_NAMES } from './core/codes.js';

const PAD = 16;
const INK = '#e6e9ef';
const DIM = 'rgba(230, 233, 239, 0.30)';
const SLOT = 'rgba(230, 233, 239, 0.10)';
const SLOT_EDGE = 'rgba(230, 233, 239, 0.22)';
const ROW_BG = 'rgba(230, 233, 239, 0.04)';
const ACTIVE = 'rgba(224, 166, 60, 0.16)';
const ACTIVE_EDGE = '#e0a63c';
const BLACK_PEG = '#12141a';
const WHITE_PEG = '#f2f4f8';

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function createView(canvas, { space, onPalette, onPeg, onRow } = {}) {
  const ctx = canvas.getContext('2d');
  const L = space.L;
  const C = space.C;
  let game = null;
  // Geometry in CSS pixels, recomputed on measure(). `pitch` is the distance between two peg
  // centres, `peg` the drawn size, so a slot always has a visible gap inside a row.
  let geo = { peg: 30, pitch: 36, ox: PAD, oy: PAD, rowH: 44, fbX: 0, palY: 0, palR: 14, palX: PAD, w: 320, h: 320 };
  let anim = 0; // 0..1, the last row sliding in
  let raf = 0;

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const W = Math.max(200, Math.round(box.width));
    const H = Math.max(220, Math.round(box.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // One row is: gutter + L pegs + gap + a 2x2 feedback block, all in units of `peg`. The
    // palette under it needs one row of its own. Solving for `peg` keeps the board identical in
    // proportion from a phone to a desktop instead of overflowing on the small end.
    const rowUnits = L * 1.22 + 2.35;
    const heightUnits = MAX_ROWS * 1.36 + 3.6;
    const peg = Math.max(9, Math.min(42, Math.floor(Math.min((W - PAD * 2) / rowUnits, (H - PAD * 2) / heightUnits))));
    const pitch = Math.round(peg * 1.22);
    const rowH = Math.round(peg * 1.36);
    const fbX = Math.round(PAD + peg * 0.55 + pitch * L + peg * 0.5);
    geo = {
      peg,
      pitch,
      ox: PAD,
      oy: PAD,
      rowH,
      fbX,
      palY: Math.round(PAD + rowH * MAX_ROWS + peg * 1.1),
      palR: Math.round(Math.min(peg * 0.62, (W - PAD * 2) / (C * 2.2))),
      palX: 0,
      w: W,
      h: H,
    };
    const span = geo.palR * 2 * C + (C - 1) * geo.palR;
    geo.palX = Math.round((W - span) / 2) + geo.palR;
    draw();
  }

  function localPoint(ev) {
    const box = canvas.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  // Centre of a drawn peg: `row` 0..MAX_ROWS-1 top to bottom, `col` 0..L-1.
  function pegXY(row, col) {
    return {
      x: geo.ox + geo.peg / 2 + geo.pitch * col,
      y: geo.oy + row * geo.rowH + geo.rowH / 2,
    };
  }

  function down(ev) {
    if (!game) return;
    const p = localPoint(ev);
    // Palette first: it is the only control while a row is in progress, and a mistap must not
    // eat a peg.
    if (Math.abs(p.y - geo.palY) <= geo.palR * 1.6) {
      for (let c = 0; c < C; c++) {
        const cx = geo.palX + c * geo.palR * 3;
        if (Math.hypot(p.x - cx, p.y - geo.palY) <= geo.palR * 1.15) {
          if (onPalette) onPalette(c);
          ev.preventDefault();
          return;
        }
      }
    }
    const row = Math.floor((p.y - geo.oy) / geo.rowH);
    if (row >= 0 && row < MAX_ROWS) {
      const col = Math.floor((p.x - geo.ox) / geo.pitch);
      if (col >= 0 && col < L && row <= game.rows.length) {
        if (row === game.rows.length && game.draft.length) {
          if (onPeg) onPeg(col);
        } else if (row < game.rows.length && onRow) {
          onRow(row);
        }
        ev.preventDefault();
        return;
      }
      if (row < game.rows.length && onRow) {
        onRow(row);
        ev.preventDefault();
      }
    }
  }

  canvas.addEventListener('pointerdown', down);

  function peg(ctx, x, y, r, colour) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = r * 0.35;
    ctx.shadowOffsetY = r * 0.14;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.5, r * 0.15, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0.20)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function slot(ctx, x, y, r) {
    ctx.strokeStyle = SLOT_EDGE;
    ctx.lineWidth = Math.max(1, r * 0.14);
    ctx.setLineDash([r * 0.5, r * 0.42]);
    ctx.beginPath();
    ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // The 2x2 answer block, BLACK FIRST: the black pegs fill from the top-left, then the whites.
  // That order is the two-pass rule made visible (js/core/codes.js), and it is why the block is
  // drawn as four fixed cells rather than as a list — a duplicate colour can never look like a
  // positional hit.
  function feedback(ctx, x, y, r, black, white) {
    const cells = [[0, 0], [1, 0], [0, 1], [1, 1]];
    const order = [];
    for (let i = 0; i < black; i++) order.push(BLACK_PEG);
    for (let i = 0; i < white; i++) order.push(WHITE_PEG);
    ctx.fillStyle = SLOT;
    roundRect(ctx, x - r * 0.25, y - r * 0.25, r * 2.5 + r * 0.5, r * 2.5 + r * 0.5, r * 0.5);
    ctx.fill();
    for (let i = 0; i < 4; i++) {
      const [cx, cy] = cells[i];
      const px = x + cx * (r * 1.5);
      const py = y + cy * (r * 1.5);
      ctx.fillStyle = SLOT_EDGE;
      ctx.beginPath();
      ctx.arc(px, py, r * 0.62, 0, Math.PI * 2);
      ctx.fill();
      if (i < order.length) {
        ctx.fillStyle = order[i];
        ctx.beginPath();
        ctx.arc(px, py, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, geo.w, geo.h);
    ctx.fillStyle = ROW_BG;
    roundRect(ctx, 4, 4, geo.w - 8, geo.oy + geo.rowH * MAX_ROWS + 4, 10);
    ctx.fill();
    if (!game) return;
    const r = geo.peg / 2;
    ctx.font = `${Math.round(geo.peg * 0.42)}px ui-monospace, monospace`;
    ctx.textBaseline = 'middle';

    for (let row = 0; row < MAX_ROWS; row++) {
      const done = row < game.rows.length;
      const active = row === game.rows.length && !game.done;
      const y = geo.oy + row * geo.rowH + geo.rowH / 2;
      if (active) {
        ctx.fillStyle = ACTIVE;
        roundRect(ctx, geo.ox - 6, y - geo.rowH / 2 + 2, geo.fbX + geo.peg * 2.2 - geo.ox + 6, geo.rowH - 4, 8);
        ctx.fill();
        ctx.strokeStyle = ACTIVE_EDGE;
        ctx.lineWidth = 1;
        roundRect(ctx, geo.ox - 6, y - geo.rowH / 2 + 2, geo.fbX + geo.peg * 2.2 - geo.ox + 6, geo.rowH - 4, 8);
        ctx.stroke();
      }
      ctx.fillStyle = DIM;
      ctx.textAlign = 'right';
      ctx.fillText(String(row + 1), geo.ox - 7, y);
      ctx.textAlign = 'left';

      if (done) {
        const row0 = game.rows[row];
        const digits = space.digits;
        for (let col = 0; col < L; col++) {
          const p = pegXY(row, col);
          // The newest row grows in; older rows are already at full size.
          const t = row === game.rows.length - 1 ? 0.6 + 0.4 * anim : 1;
          peg(ctx, p.x, p.y, r * t, COLOR_SWATCH[digits[row0.guess * L + col]]);
        }
        feedback(ctx, geo.fbX, y - geo.peg * 0.62, geo.peg * 0.4, row0.black, row0.white);
        if (row0.repeat) {
          ctx.fillStyle = 'rgba(209,97,139,0.9)';
          ctx.fillText('重复', geo.fbX + geo.peg * 1.15, y);
        }
      } else if (active || row === game.rows.length) {
        for (let col = 0; col < L; col++) {
          const p = pegXY(row, col);
          if (col < game.draft.length) peg(ctx, p.x, p.y, r, COLOR_SWATCH[game.draft[col]]);
          else slot(ctx, p.x, p.y, r);
        }
      } else {
        for (let col = 0; col < L; col++) slot(ctx, pegXY(row, col).x, y, r * 0.82);
      }
    }

    // Palette: one swatch per colour, named on hover-free small screens by its first glyph.
    for (let c = 0; c < C; c++) {
      const x = geo.palX + c * geo.palR * 3;
      peg(ctx, x, geo.palY, geo.palR, COLOR_SWATCH[c]);
      ctx.fillStyle = DIM;
      ctx.textAlign = 'center';
      ctx.fillText(COLOR_NAMES[c][0], x, geo.palY + geo.palR * 1.9);
      ctx.textAlign = 'left';
    }
  }

  function tick() {
    raf = 0;
    anim = Math.min(1, anim + 0.12);
    draw();
    if (anim < 1) raf = window.requestAnimationFrame(tick);
  }

  return {
    setGame(g) {
      game = g;
      anim = 0;
      if (!raf) raf = window.requestAnimationFrame(tick);
      else draw();
    },
    measure,
    draw,
    // Client coordinates for a test to click. A row that is not on the board yet still has a
    // legal point — that is the row in progress.
    pegPoint(row, col) {
      const p = pegXY(row, col);
      const box = canvas.getBoundingClientRect();
      return { x: Math.round(box.left + p.x), y: Math.round(box.top + p.y), peg: geo.peg };
    },
    palettePoint(c) {
      const box = canvas.getBoundingClientRect();
      return {
        x: Math.round(box.left + geo.palX + c * geo.palR * 3),
        y: Math.round(box.top + geo.palY),
        r: geo.palR,
      };
    },
    geom() {
      return { ...geo, L, C, rows: MAX_ROWS };
    },
    destroy() {
      canvas.removeEventListener('pointerdown', down);
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
