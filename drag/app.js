// app.js — wires the race: lane selection, start tree, animation loop,
// scoreboards, timing slips, charts and the data table.

import { CARS, DEFAULT_RACE } from './data.js';
import {
  calibrate, trace, sample, timeslip, timeToDistance,
  QUARTER_MILE, ROLLOUT, LAUNCH_RAMP, G,
} from './physics.js';
import { Strip } from './strip.js';
import { renderTrace, renderRanking } from './charts.js';

const LANES = 4;
const SHUTDOWN_DECEL = 5.5;        // m/s² once past the finish
const TREE = { pre: 0, stage: 450, amber: 1000, green: 1400 }; // ms, Pro tree (0.4 s)

const byId = new Map(CARS.map((c) => [c.id, c]));
const $ = (id) => document.getElementById(id);

// ── Calibration cache ──────────────────────────────────────────────────────
const models = new Map();
function model(id) {
  if (!models.has(id)) {
    const car = byId.get(id);
    const p = calibrate(car);
    const tr = trace(p, QUARTER_MILE + ROLLOUT + 1);
    const slip = timeslip(p);
    const tFinish = timeToDistance(p, QUARTER_MILE + ROLLOUT);
    const iF = Math.min(tr.t.length - 1, Math.round(tFinish / 0.01));
    models.set(id, { car, p, tr, slip, tFinish, vFinish: tr.v[iF] });
  }
  return models.get(id);
}

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  lanes: readHash() || [...DEFAULT_RACE],
  speed: 1,
  phase: 'idle',        // idle | staging | running | paused | finished
  t: 0,                 // race time since green, s
  stagingStart: 0,
  segment: 'All',
};

function readHash() {
  const raw = location.hash.slice(1);
  if (!raw) return null;
  const ids = raw.split('-').slice(0, LANES).map((s) => (byId.has(s) ? s : null));
  while (ids.length < LANES) ids.push(null);
  return ids.some(Boolean) ? ids : null;
}

function writeHash() {
  const token = state.lanes.map((id) => id || '_').join('-');
  try { history.replaceState(null, '', `#${token}`); } catch { /* sandboxed */ }
}

const runners = () => state.lanes.map((id) => (id ? model(id) : null));
const raceEnd = () => Math.max(0, ...runners().filter(Boolean).map((r) => r.tFinish)) + 1.6;
const laneColor = (i) => getComputedStyle(document.documentElement).getPropertyValue(`--lane-${i + 1}`).trim() || '#888';
const shortName = (car) => car.name.replace(/^(Volkswagen|Mercedes-AMG|Chevrolet|Lamborghini|Porsche|Toyota|Tesla|Hyundai|Ferrari|Bugatti|McLaren|Lucid|Rimac|Mazda|Honda|Dacia|Fiat|Lada|BMW|Xiaomi|Audi|Kia|BYD|Škoda)\s+/, '');

// ── Kinematics for display ─────────────────────────────────────────────────
// Cars stage with the front tyre 1 ft behind the beam, so display x is the
// model's distance minus rollout. Past the finish they brake in the shutdown.
function position(r, t) {
  if (t <= r.tFinish) {
    const s = sample(r.tr, t);
    return { x: s.x - ROLLOUT, v: s.v, a: s.a, finished: false };
  }
  const tau = Math.min(t - r.tFinish, r.vFinish / SHUTDOWN_DECEL);
  return {
    x: QUARTER_MILE + r.vFinish * tau - 0.5 * SHUTDOWN_DECEL * tau * tau,
    v: r.vFinish - SHUTDOWN_DECEL * tau,
    a: -SHUTDOWN_DECEL,
    finished: true,
  };
}

function smokeAmount(r, t, v) {
  if (t <= 0 || t > 1.8 || v > 28) return 0;
  const launch = 0.6 + 0.4 * Math.min(1, t / LAUNCH_RAMP);
  const gripLimited = r.p.A * launch < r.p.P / Math.max(v, 0.1);
  if (!gripLimited) return 0;
  const base = Math.min(1, Math.max(0.25, r.p.A / G - 0.5));
  return base * (r.car.energy === 'EV' ? 0.45 : 1) * (1 - t / 1.8);
}

// ── Lane pickers ───────────────────────────────────────────────────────────
function buildPickers() {
  const host = $('lanes-picker');
  host.textContent = '';
  for (let i = 0; i < LANES; i++) {
    const box = document.createElement('div');
    box.className = 'lane-pick';
    box.style.setProperty('--lane-color', `var(--lane-${i + 1})`);
    const label = document.createElement('label');
    label.htmlFor = `lane-${i + 1}`;
    label.textContent = `Lane ${i + 1}`;
    const t100 = document.createElement('span');
    t100.className = 'lane-t100';
    const select = document.createElement('select');
    select.id = `lane-${i + 1}`;
    const empty = new Option('— Empty lane —', '');
    select.add(empty);
    const groups = new Map();
    for (const car of [...CARS].sort((a, b) => a.t100 - b.t100)) {
      if (!groups.has(car.segment)) {
        const g = document.createElement('optgroup');
        g.label = car.segment;
        groups.set(car.segment, g);
      }
      groups.get(car.segment).appendChild(new Option(`${car.name} (${car.t100.toFixed(2)} s)`, car.id));
    }
    // Keep segment groups ordered by their quickest car.
    for (const g of groups.values()) select.appendChild(g);
    select.value = state.lanes[i] || '';
    t100.textContent = state.lanes[i] ? `${byId.get(state.lanes[i]).t100.toFixed(2)} s` : '';
    select.addEventListener('change', () => setLane(i, select.value || null));
    box.append(label, t100, select);
    host.appendChild(box);
  }
}

function setLane(i, id) {
  const next = [...state.lanes];
  next[i] = id;
  if (!next.some(Boolean)) return buildPickers(); // keep at least one car
  state.lanes = next;
  writeHash();
  buildPickers();
  resetRace();
  refreshStatic();
}

// ── Scoreboards ────────────────────────────────────────────────────────────
const boardEls = [];
function buildBoards() {
  const host = $('boards');
  host.textContent = '';
  boardEls.length = 0;
  state.lanes.forEach((id, i) => {
    const board = document.createElement('article');
    board.className = 'board';
    board.style.setProperty('--lane-color', `var(--lane-${i + 1})`);
    if (!id) {
      board.classList.add('empty');
      board.innerHTML = `<div class="board-head"><span class="lane-dot">${i + 1}</span><span class="board-name">Empty lane</span></div>`;
      host.appendChild(board);
      boardEls.push(null);
      return;
    }
    const car = byId.get(id);
    board.innerHTML = `
      <div class="board-head"><span class="lane-dot">${i + 1}</span><span class="board-name"></span></div>
      <div class="board-speed"><b data-k="speed">0</b><span>km/h</span></div>
      <div class="speedo"><i data-k="bar"></i></div>
      <dl class="board-stats">
        <div><dt>Dist</dt><dd data-k="dist">0 m</dd></div>
        <div><dt>Accel</dt><dd data-k="g">0.00 g</dd></div>
        <div><dt>Claimed</dt><dd>${car.t100.toFixed(2)} s</dd></div>
      </dl>
      <div class="split" data-k="split">0–100 km/h: waiting</div>
      <span class="win-light" data-k="win" hidden>WIN</span>`;
    board.querySelector('.board-name').textContent = car.name;
    host.appendChild(board);
    const q = (k) => board.querySelector(`[data-k="${k}"]`);
    boardEls.push({ speed: q('speed'), bar: q('bar'), dist: q('dist'), g: q('g'), split: q('split'), win: q('win') });
  });
}

function updateBoards(t) {
  const rs = runners();
  const finishers = rs.filter(Boolean);
  const winner = finishers.length > 1 ? finishers.reduce((a, b) => (a.tFinish <= b.tFinish ? a : b)) : null;
  const topSpeed = Math.max(...finishers.map((r) => r.vFinish)) * 3.6;
  rs.forEach((r, i) => {
    const b = boardEls[i];
    if (!r || !b) return;
    const pos = position(r, t);
    const kmh = pos.v * 3.6;
    b.speed.textContent = Math.round(kmh);
    b.bar.style.width = `${Math.min(100, kmh / topSpeed * 100)}%`;
    b.dist.textContent = pos.finished ? 'Finish' : `${Math.max(0, pos.x).toFixed(0)} m`;
    b.g.textContent = `${(pos.a / G).toFixed(2)} g`;
    if (pos.finished) {
      b.split.textContent = `1/4 mile: ${r.slip.quarterET.toFixed(2)} s @ ${Math.round(r.slip.quarterTrap)} km/h`;
      b.split.classList.add('hit');
    } else if (t >= r.slip.t100) {
      b.split.textContent = `0–100 km/h: ${r.slip.t100.toFixed(2)} s`;
      b.split.classList.add('hit');
    } else {
      b.split.textContent = '0–100 km/h: …';
      b.split.classList.remove('hit');
    }
    b.win.hidden = !(winner === r && t >= r.tFinish);
  });
}

// ── Timing slips ───────────────────────────────────────────────────────────
function renderSlips() {
  const host = $('slips');
  host.textContent = '';
  const rs = runners();
  const finishers = rs.filter(Boolean);
  const winner = finishers.length > 1 ? finishers.reduce((a, b) => (a.tFinish <= b.tFinish ? a : b)) : null;
  rs.forEach((r, i) => {
    if (!r) return;
    const s = r.slip;
    const mph = (kmh) => (kmh / 1.609344).toFixed(1);
    const slip = document.createElement('article');
    slip.className = 'slip';
    const pub = r.car.test
      ? `<p class="pub">Tested: ${r.car.test.et.toFixed(2)} s${r.car.test.trapMph ? ` @ ${r.car.test.trapMph} mph` : ''}</p>`
      : '';
    slip.innerHTML = `
      <h3>Lane ${i + 1} · ${shortName(r.car)}<small>${r.car.variant}</small></h3>
      <dl>
        <dt>R/T</dt><dd>0.000</dd>
        <dt>60'</dt><dd>${s.t60ft.toFixed(3)}</dd>
        <dt>330'</dt><dd>${s.t330ft.toFixed(3)}</dd>
        <dt>1/8 ET</dt><dd>${s.eighthET.toFixed(3)}</dd>
        <dt>1/8 km/h</dt><dd>${s.eighthTrap.toFixed(1)}</dd>
        <dt>1000'</dt><dd>${s.t1000ft.toFixed(3)}</dd>
        <dt>1/4 ET</dt><dd>${s.quarterET.toFixed(3)}</dd>
        <dt>1/4 km/h</dt><dd>${s.quarterTrap.toFixed(1)}</dd>
        <dt>1/4 mph</dt><dd>${mph(s.quarterTrap)}</dd>
        <span class="rule"></span>
        <dt>0–100 km/h</dt><dd>${s.t100.toFixed(2)}</dd>
        <dt>0–200 km/h</dt><dd>${Number.isFinite(s.t200) && s.t200 < 60 ? s.t200.toFixed(2) : '—'}</dd>
      </dl>
      ${pub}
      ${winner === r ? '<p class="winner">*** WIN ***</p>' : ''}`;
    host.appendChild(slip);
  });
}

// ── Speed chart & ranking ──────────────────────────────────────────────────
let traceChart = null;
function refreshTrace() {
  const series = runners().map((r, lane) => r && ({
    lane, name: r.car.name, short: shortName(r.car), tr: r.tr, t100: r.slip.t100, tFinish: r.tFinish,
  })).filter(Boolean);
  traceChart = renderTrace($('trace'), $('trace-legend'), series, $('tooltip'));
  traceChart.setCursor(state.t);
}

const SEGMENTS = ['All', ...new Set(CARS.map((c) => c.segment))];
function buildSegments() {
  const host = $('segments');
  host.textContent = '';
  for (const seg of SEGMENTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = seg;
    b.setAttribute('aria-pressed', String(seg === state.segment));
    b.addEventListener('click', () => {
      state.segment = seg;
      buildSegments();
      refreshRanking();
    });
    host.appendChild(b);
  }
}

function refreshRanking() {
  const cars = state.segment === 'All' ? CARS : CARS.filter((c) => c.segment === state.segment);
  renderRanking($('ranking'), cars, state.lanes, (lane, id) => {
    setLane(lane, state.lanes[lane] === id ? null : id);
  }, $('tooltip'));
}

function refreshStatic() {
  buildBoards();
  renderSlips();
  refreshTrace();
  refreshRanking();
  updateBoards(state.t);
  scrubMax();
}

// ── Data table (models fill in progressively) ──────────────────────────────
function buildTable() {
  const tbody = $('data-table').querySelector('tbody');
  tbody.textContent = '';
  const link = (src) => (src.url ? `<a href="${src.url}" target="_blank" rel="noopener">${src.label}</a>` : src.label);
  const rows = new Map();
  for (const car of [...CARS].sort((a, b) => a.t100 - b.t100)) {
    const tr = document.createElement('tr');
    const srcs = [`0–100: ${link(car.t100Src)}`];
    if (car.anchor) srcs.push(`${car.anchor.kmh ? '0–200' : '1/4 mile'}: ${link(car.anchor.src)}`);
    if (car.test && (!car.anchor || car.test.src !== car.anchor.src)) srcs.push(`Test: ${link(car.test.src)}`);
    const tested = car.test
      ? `${car.test.et.toFixed(2)}${car.test.trapMph ? ` @ ${Math.round(car.test.trapMph * 1.609344)}` : ''}`
      : '—';
    tr.innerHTML = `
      <td><b></b><small></small></td>
      <td class="num">${car.t100.toFixed(2)}</td>
      <td class="num">${car.kw}</td>
      <td class="num">${car.kg}</td>
      <td class="num">${(car.kg / car.kw).toFixed(2)}</td>
      <td class="num pending" data-k="60">…</td>
      <td class="num pending" data-k="qm">…</td>
      <td class="num">${tested}</td>
      <td class="src">${srcs.join('<br>')}</td>`;
    tr.querySelector('b').textContent = car.name;
    tr.querySelector('small').textContent = `${car.variant} · ${car.drive} · ${car.energy}`;
    tbody.appendChild(tr);
    rows.set(car.id, tr);
  }
  // Calibrate one car per idle slice so the page stays responsive.
  const queue = [...rows.keys()];
  const next = () => {
    const id = queue.shift();
    if (!id) return;
    const { slip } = model(id);
    const tr = rows.get(id);
    const c60 = tr.querySelector('[data-k="60"]');
    const cqm = tr.querySelector('[data-k="qm"]');
    c60.textContent = slip.t60ft.toFixed(2);
    cqm.textContent = `${slip.quarterET.toFixed(2)} @ ${Math.round(slip.quarterTrap)}`;
    c60.classList.remove('pending');
    cqm.classList.remove('pending');
    setTimeout(next, 0);
  };
  setTimeout(next, 50);
}

// ── Start tree ─────────────────────────────────────────────────────────────
const bulbs = (kind) => document.querySelectorAll(`[data-bulb="${kind}"]`);
function setTree(elapsedMs) {
  const on = (kind, value) => bulbs(kind).forEach((b) => b.classList.toggle('on', value));
  const racing = elapsedMs >= TREE.green;
  on('pre', elapsedMs >= TREE.pre);
  on('stage', elapsedMs >= TREE.stage);
  on('amber', elapsedMs >= TREE.amber && !racing);
  on('green', racing);
}
function treeOff() { document.querySelectorAll('.bulb').forEach((b) => b.classList.remove('on')); }

// ── Race control ───────────────────────────────────────────────────────────
const strip = new Strip($('strip'), $('mini'));
let snapCamera = true;

function resetRace() {
  state.phase = 'idle';
  state.t = 0;
  treeOff();
  snapCamera = true;
  $('scrub').value = 0;
  $('run').textContent = 'Launch';
}

function launch() {
  resetRace();
  state.phase = 'staging';
  state.stagingStart = performance.now();
  $('run').textContent = 'Restart';
}

function scrubMax() { $('scrub').dataset.end = raceEnd(); }

$('run').addEventListener('click', launch);
$('reset').addEventListener('click', () => { resetRace(); draw(0); });
$('scrub').addEventListener('input', (ev) => {
  const end = raceEnd();
  state.t = Number(ev.target.value) / 1000 * end;
  state.phase = state.t >= end ? 'finished' : 'paused';
  setTree(TREE.green);
  snapCamera = true;
  $('run').textContent = 'Replay';
});
$('speed').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-speed]');
  if (!b) return;
  state.speed = Number(b.dataset.speed);
  for (const x of $('speed').querySelectorAll('button')) x.setAttribute('aria-checked', String(x === b));
});
window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && !ev.target.closest('input, select, button, textarea')) {
    ev.preventDefault();
    launch();
  }
});

// ── Frame ──────────────────────────────────────────────────────────────────
function draw(sceneDt) {
  const rs = runners();
  const t = state.t;
  const cars = rs.map((r, i) => {
    if (!r) return null;
    const pos = position(r, t);
    return {
      x: pos.x, v: pos.v, len: r.car.len, wid: r.car.wid,
      color: laneColor(i), number: i + 1, short: shortName(r.car),
      smoke: state.phase === 'running' ? smokeAmount(r, t, pos.v) : 0,
      braking: pos.finished && pos.v > 0.5,
      finished: pos.finished,
    };
  });

  // Camera follows the leading car that is still racing; afterwards it rests
  // just past the finish line.
  const racing = cars.filter((c) => c && !c.finished);
  let focusX, focusV;
  if (state.phase === 'idle' || state.phase === 'staging' || t === 0) { focusX = 12; focusV = 0; }
  else if (racing.length) {
    const lead = racing.reduce((a, b) => (a.x >= b.x ? a : b));
    focusX = lead.x; focusV = lead.v;
  } else { focusX = QUARTER_MILE + 28; focusV = 0; }

  strip.draw({ cars, focusX, focusV, dt: sceneDt, snap: snapCamera });
  snapCamera = false;

  const clockT = Math.min(t, Math.max(...rs.filter(Boolean).map((r) => r.tFinish)));
  $('clock').textContent = clockT.toFixed(3);
  updateBoards(t);
  traceChart?.setCursor(t);
}

let last = performance.now();
function frame(now) {
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let sceneDt = 0;

  if (state.phase === 'staging') {
    const elapsed = now - state.stagingStart;
    setTree(elapsed);
    if (elapsed >= TREE.green) {
      state.phase = 'running';
      state.t = (elapsed - TREE.green) / 1000 * state.speed;
    }
  } else if (state.phase === 'running') {
    sceneDt = realDt * state.speed;
    state.t += sceneDt;
    const end = raceEnd();
    if (state.t >= end) {
      state.t = end;
      state.phase = 'finished';
      $('run').textContent = 'Replay';
    }
    $('scrub').value = Math.round(state.t / end * 1000);
  }

  draw(sceneDt);
  requestAnimationFrame(frame);
}

// ── Boot ───────────────────────────────────────────────────────────────────
buildPickers();
buildSegments();
refreshStatic();
buildTable();
writeHash();

let resizeTimer = 0;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    strip.resize();
    snapCamera = true;
    refreshTrace();
  }, 80);
}).observe(document.querySelector('.strip-frame'));

// Re-read lane colours when the theme flips.
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => refreshTrace());

window.addEventListener('hashchange', () => {
  const lanes = readHash();
  if (!lanes) return;
  state.lanes = lanes;
  buildPickers();
  resetRace();
  refreshStatic();
});

requestAnimationFrame(frame);
