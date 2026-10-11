// strip.js — top-down drag strip renderer (canvas) and the overview minimap.
//
// World units are metres. x runs down the track (0 = starting line, the
// finish is at QUARTER_MILE); y runs across it from the top grass verge.
// The scene keeps its own photographic colours in both page themes.

import { QUARTER_MILE, EIGHTH_MILE } from './physics.js';

const LANE_W = 3.6;
const WALL_W = 0.55;
const VERGE_W = 3.2;
const SHUTDOWN = 260;                 // tarmac drawn past the finish
const CAMERA_ANCHOR = 0.64;           // focus car sits at 64 % of the width

const SCENE = {
  grassA: '#3f5a33', grassB: '#46633a',
  wall: '#b9bcbd', wallJoint: '#8f9395', wallTop: '#d4d6d6',
  asphalt: '#3b3e42', burnout: '#2b2e31',
  groove: 'rgba(12, 12, 14, 0.55)',
  line: 'rgba(245, 245, 240, 0.92)',
  beam: 'rgba(255, 240, 160, 0.55)',
  label: 'rgba(255, 255, 255, 0.92)',
  labelBg: 'rgba(20, 22, 24, 0.72)',
};

const MARKERS = [
  { x: 18.288, label: '60 FT' },
  { x: 100.584, label: '330 FT' },
  { x: EIGHTH_MILE, label: '1/8 MILE' },
  { x: 304.8, label: '1000 FT' },
  { x: QUARTER_MILE, label: 'FINISH 1/4' },
];

/** Deterministic PRNG so the asphalt texture is identical on every load. */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeAsphalt(ctxFactory) {
  const size = 192;
  const c = ctxFactory(size);
  const g = c.getContext('2d');
  g.fillStyle = SCENE.asphalt;
  g.fillRect(0, 0, size, size);
  const rnd = mulberry32(7);
  for (let i = 0; i < 2600; i++) {
    const v = rnd();
    const shade = v < 0.5 ? `rgba(0,0,0,${0.08 + rnd() * 0.12})` : `rgba(255,255,255,${0.03 + rnd() * 0.06})`;
    g.fillStyle = shade;
    g.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
  }
  return c;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class Strip {
  constructor(canvas, mini) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = mini;
    this.mctx = mini.getContext('2d');
    this.laneCount = 4;
    this.camX = 0;
    this.particles = [];
    this.rnd = mulberry32(42);
    this.asphalt = makeAsphalt((size) => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      return c;
    });
    this.pattern = this.ctx.createPattern(this.asphalt, 'repeat');
    this.resize();
  }

  get heightMetres() {
    return 2 * VERGE_W + 2 * WALL_W + this.laneCount * LANE_W;
  }

  laneCenter(i) {
    return VERGE_W + WALL_W + (i + 0.5) * LANE_W;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.canvas.clientWidth || 800;
    // Pixels per metre: as close as the width allows, ~70 m of strip on screen.
    this.scale = Math.max(8, Math.min(17, cssW / 70));
    const cssH = Math.round(this.heightMetres * this.scale);
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;

    const mW = this.mini.clientWidth || cssW;
    const mH = this.mini.clientHeight || 34;
    this.mini.width = Math.round(mW * dpr);
    this.mini.height = Math.round(mH * dpr);
    this.mW = mW;
    this.mH = mH;
  }

  /** Screen x (CSS px) of a world x. */
  sx(x) {
    return (x - this.camX) * this.scale + this.cssW * CAMERA_ANCHOR;
  }

  get viewLeft() { return this.camX - (this.cssW * CAMERA_ANCHOR) / this.scale; }
  get viewRight() { return this.camX + (this.cssW * (1 - CAMERA_ANCHOR)) / this.scale; }

  clearSmoke() { this.particles.length = 0; }

  /** Tyre smoke while a car is at the traction limit in the first metres. */
  emitSmoke(lane, car, dt) {
    const yc = this.laneCenter(lane);
    const rearAxle = car.x - car.len * 0.82;
    const rate = car.smoke * 70 * dt; // particles per frame
    let n = Math.floor(rate) + (this.rnd() < rate % 1 ? 1 : 0);
    while (n-- > 0 && this.particles.length < 500) {
      const side = this.rnd() < 0.5 ? -1 : 1;
      this.particles.push({
        x: rearAxle - this.rnd() * 0.4,
        y: yc + side * car.wid * 0.38 + (this.rnd() - 0.5) * 0.3,
        vx: car.v * (0.15 + this.rnd() * 0.15),
        vy: (this.rnd() - 0.5) * 1.6,
        r: 0.35 + this.rnd() * 0.3,
        life: 0,
        max: 0.9 + this.rnd() * 1.1,
      });
    }
  }

  stepSmoke(dt) {
    for (const p of this.particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.exp(-dt * 2.5);
      p.vy *= Math.exp(-dt * 1.5);
      p.r += dt * 1.6;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
  }

  /**
   * Draws a frame.
   * state.cars: per-lane { x, v, len, wid, color, smoke, braking, number, name } or null
   * state.focusX / focusV: where the camera should be and how fast it moves
   * state.dt: scene time since the last frame (s); state.snap: jump the camera
   */
  draw(state) {
    const { cars } = state;
    if (cars.length !== this.laneCount) {
      this.laneCount = cars.length;
      this.resize();
    }

    // Camera: feed-forward on the focus car's speed plus exponential catch-up,
    // so it locks onto a car doing 300 km/h without lag and glides when the
    // focus changes.
    const dt = Math.max(0, Math.min(0.1, state.dt || 0));
    if (state.snap) this.camX = state.focusX;
    else this.camX += (state.focusV || 0) * dt + (state.focusX - this.camX) * (1 - Math.exp(-dt * 5));

    if (state.snap) this.clearSmoke();
    cars.forEach((c, i) => { if (c && c.smoke > 0 && dt > 0) this.emitSmoke(i, c, dt); });
    this.stepSmoke(dt);

    const ctx = this.ctx;
    const s = this.scale;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    this.drawGround(ctx, s);
    this.drawMarkings(ctx, s);
    this.drawSmoke(ctx, s);
    cars.forEach((c, i) => { if (c) this.drawCar(ctx, s, c, i); });
    this.drawOffscreen(ctx, s, cars);
    this.drawMini(cars);
  }

  drawGround(ctx, s) {
    const W = this.cssW;
    const lanesTop = VERGE_W + WALL_W;
    const lanesH = this.laneCount * LANE_W;
    const left = this.viewLeft;
    const right = this.viewRight;

    // Mowed grass bands, 8 m wide: the strongest cue for speed at a glance.
    const band = 8;
    for (let b = Math.floor(left / band) * band; b < right; b += band) {
      ctx.fillStyle = (Math.floor(b / band) % 2 === 0) ? SCENE.grassA : SCENE.grassB;
      const x0 = this.sx(b);
      ctx.fillRect(x0, 0, band * s + 1, this.cssH);
    }

    // Asphalt (only where the strip exists: from the burnout box to shutdown).
    const tStart = -40, tEnd = QUARTER_MILE + SHUTDOWN;
    const ax0 = Math.max(0, this.sx(tStart));
    const ax1 = Math.min(W, this.sx(tEnd));
    if (ax1 > ax0) {
      ctx.save();
      const off = (-this.camX * s) % this.asphalt.width;
      ctx.translate(off, 0);
      ctx.fillStyle = this.pattern;
      ctx.fillRect(ax0 - off, lanesTop * s, ax1 - ax0, lanesH * s);
      ctx.restore();

      // Burnout box: water-darkened tarmac behind the line.
      const bx0 = this.sx(-32), bx1 = this.sx(-7);
      if (bx1 > 0 && bx0 < W) {
        const grad = ctx.createLinearGradient(bx0, 0, bx1, 0);
        grad.addColorStop(0, 'rgba(20,24,28,0)');
        grad.addColorStop(0.3, 'rgba(20,24,28,0.55)');
        grad.addColorStop(1, 'rgba(20,24,28,0.25)');
        ctx.fillStyle = grad;
        ctx.fillRect(bx0, lanesTop * s, bx1 - bx0, lanesH * s);
      }

      // Rubbered groove: two dark tyre tracks per lane, heaviest at the launch.
      for (let i = 0; i < this.laneCount; i++) {
        const yc = this.laneCenter(i);
        for (const side of [-1, 1]) {
          const y = (yc + side * 0.8) * s;
          const gx0 = this.sx(-5), gx1 = this.sx(330);
          if (gx1 < 0 || gx0 > W) continue;
          const grad = ctx.createLinearGradient(gx0, 0, gx1, 0);
          grad.addColorStop(0, 'rgba(10,10,12,0.75)');
          grad.addColorStop(0.08, 'rgba(10,10,12,0.55)');
          grad.addColorStop(1, 'rgba(10,10,12,0)');
          ctx.fillStyle = grad;
          ctx.fillRect(gx0, y - 0.3 * s, gx1 - gx0, 0.6 * s);
        }
      }
    }

    // Concrete guard walls with 12 ft segment joints.
    for (const top of [VERGE_W, lanesTop + lanesH]) {
      const x0 = Math.max(0, this.sx(tStart - 20)), x1 = Math.min(W, this.sx(tEnd + 40));
      if (x1 <= x0) continue;
      ctx.fillStyle = SCENE.wall;
      ctx.fillRect(x0, top * s, x1 - x0, WALL_W * s);
      ctx.fillStyle = SCENE.wallTop;
      ctx.fillRect(x0, (top + WALL_W * 0.3) * s, x1 - x0, WALL_W * 0.4 * s);
      ctx.fillStyle = SCENE.wallJoint;
      const seg = 3.6576;
      for (let x = Math.ceil(left / seg) * seg; x < right; x += seg) {
        if (x < tStart - 20 || x > tEnd + 40) continue;
        ctx.fillRect(this.sx(x), top * s, Math.max(1, 0.08 * s), WALL_W * s);
      }
    }
  }

  drawMarkings(ctx, s) {
    const W = this.cssW;
    const lanesTop = VERGE_W + WALL_W;
    const lanesH = this.laneCount * LANE_W;
    const lanesBottom = lanesTop + lanesH;
    const tEnd = QUARTER_MILE + SHUTDOWN;
    const onScreen = (x, pad = 60) => this.sx(x) > -pad && this.sx(x) < W + pad;

    // Lane lines: solid white between lanes and along the walls.
    const lx0 = Math.max(0, this.sx(-40)), lx1 = Math.min(W, this.sx(tEnd));
    if (lx1 > lx0) {
      ctx.fillStyle = SCENE.line;
      for (let i = 0; i <= this.laneCount; i++) {
        const y = (lanesTop + i * LANE_W) * s;
        const inset = i === 0 ? 0.25 : i === this.laneCount ? -0.25 : 0;
        ctx.fillRect(lx0, y + inset * s - 0.06 * s, lx1 - lx0, Math.max(1, 0.12 * s));
      }
    }

    // Starting line and stage beams.
    if (onScreen(0)) {
      const x = this.sx(0);
      ctx.fillStyle = SCENE.line;
      ctx.fillRect(x - 0.15 * s, lanesTop * s, 0.3 * s, lanesH * s);
      ctx.fillStyle = SCENE.beam;
      ctx.fillRect(this.sx(-0.18) - 0.5, lanesTop * s, 1, lanesH * s);
      this.boardLabel(ctx, x, (VERGE_W - 1.6) * s, 'START', s);
    }

    // Timing beams, boards and the finish line.
    for (const m of MARKERS) {
      if (!onScreen(m.x, 200)) continue;
      const x = this.sx(m.x);
      if (m.x === QUARTER_MILE) {
        const sq = 0.6;
        for (let r = 0; r < 2; r++) {
          for (let k = 0; k * sq < lanesH; k++) {
            ctx.fillStyle = (r + k) % 2 === 0 ? '#f4f4f0' : '#141414';
            ctx.fillRect(x + (r - 1) * sq * s, (lanesTop + k * sq) * s, sq * s + 0.5, Math.min(sq, lanesH - k * sq) * s + 0.5);
          }
        }
      } else {
        ctx.fillStyle = SCENE.beam;
        ctx.fillRect(x - 0.5, lanesTop * s, 1, lanesH * s);
      }
      // Beam posts on both walls.
      ctx.fillStyle = '#e8c23a';
      ctx.fillRect(x - 0.2 * s, (VERGE_W - 0.25) * s, 0.4 * s, 0.4 * s);
      ctx.fillRect(x - 0.2 * s, (lanesBottom + WALL_W - 0.15) * s, 0.4 * s, 0.4 * s);
      this.boardLabel(ctx, x, (VERGE_W - 1.6) * s, m.label, s);
    }

    // Metric distance boards on the bottom verge, every 50 m.
    ctx.font = `600 ${Math.max(9, Math.min(12, s * 0.75))}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const y = (lanesBottom + WALL_W + VERGE_W * 0.5) * s;
    for (let d = 50; d <= QUARTER_MILE + 200; d += 50) {
      if (!onScreen(d)) continue;
      const x = this.sx(d);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x - 0.5, (lanesBottom + WALL_W) * s, 1, 0.6 * s);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(`${d} m`, x, y);
    }
  }

  boardLabel(ctx, x, y, text, s) {
    ctx.font = `700 ${Math.max(10, Math.min(14, s * 0.9))}px "Saira Condensed", "Arial Narrow", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 10;
    const h = Math.max(14, Math.min(20, s * 1.25));
    ctx.fillStyle = SCENE.labelBg;
    roundRect(ctx, x - w / 2, y - h / 2, w, h, 3);
    ctx.fill();
    ctx.fillStyle = SCENE.label;
    ctx.fillText(text, x, y + 1);
  }

  drawSmoke(ctx, s) {
    for (const p of this.particles) {
      const x = this.sx(p.x);
      if (x < -80 || x > this.cssW + 80) continue;
      const k = 1 - p.life / p.max;
      const r = p.r * s;
      const grad = ctx.createRadialGradient(x, p.y * s, 0, x, p.y * s, r);
      grad.addColorStop(0, `rgba(225,228,230,${0.42 * k})`);
      grad.addColorStop(1, 'rgba(225,228,230,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, p.y * s, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Top-down car, drawn to scale with its front bumper at c.x. */
  drawCar(ctx, s, c, lane) {
    const L = c.len * s, Wd = c.wid * s;
    const front = this.sx(c.x);
    const rear = front - L;
    if (front < -10 || rear > this.cssW + 10) return;
    const yc = this.laneCenter(lane) * s;
    const top = yc - Wd / 2;

    ctx.save();
    // Shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(ctx, rear + 0.12 * s, top + 0.18 * s, L, Wd, Wd * 0.22);
    ctx.fill();

    // Tyres.
    const tyreL = 0.68 * s, tyreW = 0.28 * s;
    ctx.fillStyle = '#121314';
    for (const ax of [rear + L * 0.18, rear + L * 0.79]) {
      ctx.fillRect(ax - tyreL / 2, top - tyreW * 0.25, tyreL, tyreW);
      ctx.fillRect(ax - tyreL / 2, top + Wd - tyreW * 0.75, tyreL, tyreW);
    }

    // Body with a cross-car gradient for some shape.
    const grad = ctx.createLinearGradient(0, top, 0, top + Wd);
    grad.addColorStop(0, shade(c.color, -0.25));
    grad.addColorStop(0.5, shade(c.color, 0.12));
    grad.addColorStop(1, shade(c.color, -0.3));
    ctx.fillStyle = grad;
    roundRect(ctx, rear, top, L, Wd, Wd * 0.24);
    ctx.fill();

    // Greenhouse: rear window, roof, windscreen.
    const gx0 = rear + L * 0.26, gx1 = rear + L * 0.7;
    const gInset = Wd * 0.12;
    ctx.fillStyle = 'rgba(16,22,28,0.88)';
    roundRect(ctx, gx0, top + gInset, gx1 - gx0, Wd - 2 * gInset, Wd * 0.18);
    ctx.fill();
    ctx.fillStyle = shade(c.color, -0.05);
    roundRect(ctx, gx0 + L * 0.08, top + gInset * 1.5, (gx1 - gx0) - L * 0.2, Wd - 3 * gInset, Wd * 0.12);
    ctx.fill();
    ctx.fillStyle = 'rgba(150,180,205,0.35)';
    ctx.fillRect(gx1 - L * 0.11, top + gInset * 1.4, L * 0.08, Wd - 2.8 * gInset);

    // Lane number on the roof, like a race number.
    if (s >= 9) {
      const rx = (gx0 + gx1) / 2 - L * 0.02;
      const r = Math.min(Wd * 0.2, L * 0.07);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(rx, yc, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = `700 ${Math.round(r * 1.5)}px "Saira Condensed", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(c.number), rx, yc + r * 0.08);
    }

    // Lights.
    ctx.fillStyle = '#fff6d8';
    ctx.fillRect(front - 0.18 * s, top + Wd * 0.1, 0.14 * s, Wd * 0.18);
    ctx.fillRect(front - 0.18 * s, top + Wd * 0.72, 0.14 * s, Wd * 0.18);
    ctx.fillStyle = c.braking ? '#ff2a2a' : '#8a1414';
    ctx.fillRect(rear + 0.03 * s, top + Wd * 0.1, 0.14 * s, Wd * 0.2);
    ctx.fillRect(rear + 0.03 * s, top + Wd * 0.7, 0.14 * s, Wd * 0.2);
    if (c.braking) {
      ctx.fillStyle = 'rgba(255,40,40,0.25)';
      ctx.beginPath(); ctx.arc(rear, yc, Wd * 0.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /** Edge tags for cars outside the view, with the gap in metres. */
  drawOffscreen(ctx, s, cars) {
    const left = this.viewLeft, right = this.viewRight;
    const lead = Math.max(...cars.filter(Boolean).map((c) => c.x));
    ctx.font = `600 ${Math.max(10, Math.min(12, s * 0.8))}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textBaseline = 'middle';
    cars.forEach((c, i) => {
      if (!c) return;
      const y = this.laneCenter(i) * s;
      let text = null, atLeft = true;
      if (c.x < left) { text = `◀ ${c.short}  −${Math.round(lead - c.x)} m`; }
      else if (c.x - c.len > right) { text = `${c.short} ▶`; atLeft = false; }
      if (!text) return;
      const w = ctx.measureText(text).width + 14;
      const h = Math.max(16, s * 1.3);
      const x = atLeft ? 6 : this.cssW - 6 - w;
      ctx.fillStyle = 'rgba(16,18,20,0.82)';
      roundRect(ctx, x, y - h / 2, w, h, 3);
      ctx.fill();
      ctx.fillStyle = c.color;
      ctx.fillRect(atLeft ? x : x + w - 3, y - h / 2, 3, h);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(text, x + 8, y + 1);
    });
  }

  drawMini(cars) {
    const ctx = this.mctx;
    const W = this.mW, H = this.mH;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#1b1e21';
    ctx.fillRect(0, 0, W, H);
    const pad = 12;
    const span = QUARTER_MILE + 40;
    const mx = (x) => pad + (x + 10) / (span + 10) * (W - 2 * pad);

    // Track and markers.
    const top = 7, h = H - 14;
    ctx.fillStyle = '#3b3e42';
    ctx.fillRect(mx(-10), top, mx(span) - mx(-10), h);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (const m of [0, ...MARKERS.map((mm) => mm.x)]) ctx.fillRect(mx(m) - 0.5, top - 3, 1, h + 6);
    ctx.fillStyle = '#f4f4f0';
    ctx.fillRect(mx(QUARTER_MILE) - 1, top - 3, 2, h + 6);

    // Camera window.
    ctx.strokeStyle = 'rgba(242,173,43,0.9)';
    ctx.lineWidth = 1;
    const v0 = Math.max(mx(-10), mx(this.viewLeft)), v1 = Math.min(mx(span), mx(this.viewRight));
    if (v1 > v0) ctx.strokeRect(v0 + 0.5, top - 4.5, v1 - v0 - 1, h + 9);

    // Cars, one row per lane.
    const n = cars.length;
    cars.forEach((c, i) => {
      if (!c) return;
      const y = top + h * (i + 0.5) / n;
      const x = mx(Math.min(span, c.x));
      ctx.fillStyle = '#1b1e21';
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c.color;
      ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2); ctx.fill();
    });
  }
}

/** Lightens (k > 0) or darkens (k < 0) a hex colour. */
export function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  const t = k < 0 ? 0 : 255, p = Math.abs(k);
  r = Math.round(r + (t - r) * p); g = Math.round(g + (t - g) * p); b = Math.round(b + (t - b) * p);
  return `rgb(${r},${g},${b})`;
}
