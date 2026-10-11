// charts.js — speed-over-time line chart (SVG) and the 0–100 ranking (HTML bars).

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function niceStep(span, target) {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}

/**
 * Speed trace chart. `series`: [{ lane, name, short, tr, t100, tFinish }].
 * Returns { setCursor(t) } so the race loop can move the time cursor cheaply.
 */
export function renderTrace(container, legend, series, tooltip) {
  container.textContent = '';
  legend.textContent = '';
  const width = Math.max(300, container.clientWidth || 800);
  const height = width < 560 ? 240 : 320;
  const m = { top: 28, right: width < 560 ? 16 : 120, bottom: 38, left: 46 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;

  for (const s of series) {
    const item = document.createElement('span');
    item.style.setProperty('--lane-color', `var(--lane-${s.lane + 1})`);
    item.innerHTML = '<i></i>';
    item.append(`Lane ${s.lane + 1} · ${s.name}`);
    legend.appendChild(item);
  }

  const tMax = Math.max(4, ...series.map((s) => s.tFinish));
  const vMaxRaw = Math.max(120, ...series.map((s) => Math.max(...s.tr.v.slice(0, Math.ceil(s.tFinish / 0.01) + 1)) * 3.6));
  const xStep = niceStep(tMax, width < 560 ? 5 : 9);
  const xMax = Math.ceil(tMax / xStep) * xStep;
  const yStep = vMaxRaw > 220 ? 50 : 25;
  const yMax = Math.ceil(vMaxRaw / yStep) * yStep;
  const X = (t) => m.left + t / xMax * iw;
  const Y = (v) => m.top + ih - v / yMax * ih;

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Speed in km/h against time in seconds for each car in the race' }, container);

  // Grid and axes.
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    el('line', { class: 'grid', x1: m.left, x2: m.left + iw, y1: Y(v), y2: Y(v) }, svg);
    const t = el('text', { x: m.left - 8, y: Y(v) + 4, 'text-anchor': 'end' }, svg);
    t.textContent = v;
  }
  for (let t = 0; t <= xMax + 1e-9; t += xStep) {
    const lbl = el('text', { x: X(t), y: m.top + ih + 18, 'text-anchor': 'middle' }, svg);
    lbl.textContent = Number.isInteger(t) ? t : t.toFixed(1);
  }
  const xt = el('text', { class: 'axis-title', x: m.left + iw, y: height - 4, 'text-anchor': 'end' }, svg);
  xt.textContent = 'seconds since green';
  const yt = el('text', { class: 'axis-title', x: m.left - 8, y: 11, 'text-anchor': 'end' }, svg);
  yt.textContent = 'km/h';

  // 100 km/h reference.
  el('line', { class: 'ref', x1: m.left, x2: m.left + iw, y1: Y(100), y2: Y(100) }, svg);
  const refLbl = el('text', { class: 'ref-label', x: m.left + iw - 4, y: Y(100) - 6, 'text-anchor': 'end' }, svg);
  refLbl.textContent = '100 km/h';

  // Series.
  const ends = [];
  for (const s of series) {
    const color = `var(--lane-${s.lane + 1})`;
    const pts = [];
    const n = Math.min(s.tr.t.length - 1, Math.ceil(s.tFinish / 0.01));
    for (let i = 0; i <= n; i += 4) pts.push(`${X(s.tr.t[i]).toFixed(1)},${Y(s.tr.v[i] * 3.6).toFixed(1)}`);
    pts.push(`${X(s.tr.t[n]).toFixed(1)},${Y(s.tr.v[n] * 3.6).toFixed(1)}`);
    el('polyline', { class: 'series', points: pts.join(' '), style: `stroke:${color}` }, svg);
    ends.push({ s, x: X(s.tr.t[n]), y: Y(s.tr.v[n] * 3.6), color });
  }
  for (const s of series) {
    if (s.t100 <= xMax) el('circle', { class: 'marker', cx: X(s.t100), cy: Y(100), r: 4.5, style: `fill:var(--lane-${s.lane + 1})` }, svg);
  }

  // Direct labels at the line ends, nudged apart vertically.
  if (width >= 560) {
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) {
      if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    }
    for (const e of ends) {
      const t = el('text', { class: 'direct', x: e.x + 8, y: e.y + 4 }, svg);
      t.textContent = e.s.short;
    }
  }

  // Race-time cursor.
  const cursor = el('line', { class: 'cursor', x1: X(0), x2: X(0), y1: m.top, y2: m.top + ih, visibility: 'hidden' }, svg);

  // Hover: crosshair + tooltip with every car's speed at that moment.
  const hoverLine = el('line', { class: 'hover-line', y1: m.top, y2: m.top + ih, visibility: 'hidden' }, svg);
  const hit = el('rect', { x: m.left, y: m.top, width: iw, height: ih, fill: 'transparent' }, svg);
  const hide = () => { hoverLine.setAttribute('visibility', 'hidden'); tooltip.hidden = true; };
  hit.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width * width;
    const t = Math.max(0, Math.min(xMax, (px - m.left) / iw * xMax));
    hoverLine.setAttribute('x1', X(t));
    hoverLine.setAttribute('x2', X(t));
    hoverLine.setAttribute('visibility', 'visible');
    const rows = series.map((s) => {
      const i = Math.min(s.tr.t.length - 1, Math.round(t / 0.01));
      const done = t > s.tFinish;
      const v = done ? '—' : `${Math.round(s.tr.v[i] * 3.6)} km/h`;
      return `<div class="tt-row" style="--lane-color:var(--lane-${s.lane + 1})"><i></i>${s.short}: <b>${done ? 'finished' : v}</b></div>`;
    });
    tooltip.innerHTML = `<b>${t.toFixed(2)} s</b>${rows.join('')}`;
    tooltip.hidden = false;
    placeTooltip(tooltip, ev.clientX, ev.clientY);
  });
  hit.addEventListener('pointerleave', hide);

  return {
    setCursor(t) {
      if (t <= 0 || t > xMax) { cursor.setAttribute('visibility', 'hidden'); return; }
      cursor.setAttribute('x1', X(t));
      cursor.setAttribute('x2', X(t));
      cursor.setAttribute('visibility', 'visible');
    },
  };
}

export function placeTooltip(tip, x, y) {
  const pad = 14;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + pad, top = y + pad;
  if (left + w > window.innerWidth - 8) left = x - w - pad;
  if (top + h > window.innerHeight - 8) top = y - h - pad;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

/**
 * 0–100 ranking. One row per car on a fixed 0–15 s scale so filtering never
 * rescales the bars. Cars on the strip take their lane colour.
 */
export function renderRanking(container, cars, lanes, onLane, tooltip) {
  container.textContent = '';
  const scaleMax = 15;
  const sorted = [...cars].sort((a, b) => a.t100 - b.t100);
  for (const car of sorted) {
    const lane = lanes.indexOf(car.id);
    const row = document.createElement('div');
    row.className = 'rank-row';

    const name = document.createElement('div');
    name.className = 'rank-name';
    name.innerHTML = `<b></b><small></small>`;
    name.querySelector('b').textContent = car.name;
    name.querySelector('small').textContent = car.variant;

    const bar = document.createElement('div');
    bar.className = 'rank-bar';
    const fill = document.createElement('i');
    fill.style.width = `calc((100% - 96px) * ${(car.t100 / scaleMax).toFixed(4)})`;
    if (lane >= 0) {
      fill.style.setProperty('--bar-color', `var(--lane-${lane + 1})`);
      fill.style.setProperty('--bar-opacity', '1');
    }
    const value = document.createElement('span');
    value.textContent = `${car.t100.toFixed(2)} s`;
    bar.append(fill, value);
    if (lane >= 0) {
      const tag = document.createElement('em');
      tag.textContent = `Lane ${lane + 1}`;
      bar.append(tag);
    }

    bar.addEventListener('pointermove', (ev) => {
      tooltip.innerHTML = `<b>${car.name}</b><br>${car.variant}<br>0–100 km/h: <b>${car.t100.toFixed(2)} s</b><br>${car.kw} kW · ${car.kg} kg · ${car.drive}`;
      tooltip.hidden = false;
      placeTooltip(tooltip, ev.clientX, ev.clientY);
    });
    bar.addEventListener('pointerleave', () => { tooltip.hidden = true; });

    const buttons = document.createElement('div');
    buttons.className = 'lane-buttons';
    for (let i = 0; i < 4; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lane-btn';
      b.style.setProperty('--lane-color', `var(--lane-${i + 1})`);
      b.textContent = i + 1;
      b.setAttribute('aria-pressed', String(lane === i));
      b.setAttribute('aria-label', `Put ${car.name} in lane ${i + 1}`);
      b.title = `Lane ${i + 1}`;
      b.addEventListener('click', () => onLane(i, car.id));
      buttons.appendChild(b);
    }

    row.append(name, bar, buttons);
    container.appendChild(row);
  }
}
