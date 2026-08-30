// app.js — точка входа и оркестрация: связывает геолокацию, Overpass,
// подбор сегмента и разбор ограничения с интерфейсом.

import { GeoWatcher, SpeedTracker, geoErrorText, POOR_ACCURACY_M } from './geo.js';
import { OverpassClient } from './overpass.js';
import { SegmentMatcher } from './matching.js';
import { resolveSpeedLimit, UNKNOWN } from './maxspeed.js';

/** Привязка к дороге старше этого возраста сбрасывается в «нет данных» (ТЗ 5). */
const MATCH_MAX_AGE_MS = 30000;
/** Период перерисовки: нужен для контроля устаревания даже без новых фиксов. */
const TICK_MS = 1000;
/** Пороги индикации превышения (ТЗ 4). */
const OVER_WARN_KMH = 5;
const OVER_DANGER_KMH = 15;

const dom = {
  screen: document.getElementById('screen'),
  toggle: document.getElementById('toggle'),
  speedValue: document.getElementById('speedValue'),
  sign: document.getElementById('sign'),
  signText: document.getElementById('signText'),
  signCaption: document.getElementById('signCaption'),
  status: document.getElementById('status'),
  metaAccuracy: document.getElementById('metaAccuracy'),
  metaRoad: document.getElementById('metaRoad'),
  metaOffline: document.getElementById('metaOffline'),
  metaSource: document.getElementById('metaSource'),
};

const watcher = new GeoWatcher();
const speed = new SpeedTracker();
const matcher = new SegmentMatcher();
const overpass = new OverpassClient();

const state = {
  running: false,
  geoError: null,
  limit: UNKNOWN,
  matchTs: 0,
  roadName: null,
  lastCountry: null, // последняя известная привязка к стране (ТЗ 3.5)
  tickTimer: null,
  wakeLock: null,
};

/* ------------------------------------------------------------------ */
/* Запуск и остановка                                                  */
/* ------------------------------------------------------------------ */

function start() {
  if (state.running) return;
  state.running = true;
  state.geoError = null;
  dom.screen.classList.add('running');
  dom.toggle.textContent = 'Стоп';

  // Разрешение запрашивается именно здесь — по явному действию пользователя.
  watcher.start(onPosition, onGeoError);
  requestWakeLock();

  state.tickTimer = setInterval(render, TICK_MS);
  render();
}

function stop() {
  if (!state.running) return;
  state.running = false;
  dom.screen.classList.remove('running');
  dom.toggle.textContent = 'Старт';

  watcher.stop();
  speed.reset();
  matcher.reset();
  releaseWakeLock();

  clearInterval(state.tickTimer);
  state.tickTimer = null;
  state.limit = UNKNOWN;
  state.matchTs = 0;
  state.roadName = null;
  render();
}

dom.toggle.addEventListener('click', () => (state.running ? stop() : start()));

/* ------------------------------------------------------------------ */
/* Обработка позиции                                                   */
/* ------------------------------------------------------------------ */

function onPosition(position) {
  state.geoError = null;
  speed.add(position);

  const fix = speed.lastFix;
  if (!fix) return;

  // При плохой точности привязка к дороге бессмысленна (ТЗ 5.3).
  if (fix.accuracy > POOR_ACCURACY_M) {
    matcher.reset();
    state.limit = UNKNOWN;
    state.roadName = null;
    state.matchTs = 0;
    render();
    return;
  }

  // Запрос к Overpass — асинхронно; ошибки внутри клиента не всплывают.
  overpass.update(fix.lat, fix.lon).then((updated) => {
    if (updated) matchAndRender();
    else render();
  });

  matchAndRender();
}

function matchAndRender() {
  const fix = speed.lastFix;
  if (!fix) {
    render();
    return;
  }

  const ways = overpass.getWays();
  const match = matcher.match(
    { lat: fix.lat, lon: fix.lon },
    ways,
    { heading: fix.heading, speedKmh: speed.value },
  );

  if (match) {
    const limit = resolveSpeedLimit(match.way.tags, match.direction, state.lastCountry);
    if (limit.country) state.lastCountry = limit.country;
    state.limit = limit;
    state.roadName = (match.way.tags && (match.way.tags.name || match.way.tags.ref)) || null;
    state.matchTs = Date.now();
  } else {
    // Привязка потеряна — показывать прежнее ограничение запрещено (ТЗ 5).
    state.limit = UNKNOWN;
    state.roadName = null;
    state.matchTs = 0;
  }

  render();
}

function onGeoError(error) {
  state.geoError = error;
  // POSITION_UNAVAILABLE и TIMEOUT — временные: watchPosition продолжает работу.
  if (error && error.code === 1) {
    matcher.reset();
    state.limit = UNKNOWN;
    state.matchTs = 0;
  }
  render();
}

/* ------------------------------------------------------------------ */
/* Отрисовка                                                           */
/* ------------------------------------------------------------------ */

function currentLimit(now) {
  // Данные без подтверждения дольше 30 с считаются устаревшими (ТЗ 5).
  if (!state.matchTs || now - state.matchTs > MATCH_MAX_AGE_MS) return UNKNOWN;
  return state.limit;
}

function renderSpeed(limit) {
  const value = speed.display;
  dom.speedValue.textContent = value === null ? '--' : String(value);

  dom.speedValue.classList.remove('warn', 'danger', 'stale');
  if (value === null) {
    dom.speedValue.classList.add('stale');
    return;
  }
  if (limit.kind !== 'number' && limit.kind !== 'walk') return;
  const over = value - limit.kmh;
  if (over > OVER_DANGER_KMH) dom.speedValue.classList.add('danger');
  else if (over > OVER_WARN_KMH) dom.speedValue.classList.add('warn');
}

function renderSign(limit, accuracyBad) {
  let signState = 'nodata';
  let text = '—';
  let caption = '';
  let label = 'Нет данных об ограничении';

  if (accuracyBad) {
    caption = 'низкая точность GPS';
  } else if (limit.kind === 'number' || limit.kind === 'walk') {
    signState = 'number';
    text = String(limit.kmh);
    caption = limit.label || (limit.implicit ? 'по умолчанию для страны' : '');
    label = `Ограничение ${limit.kmh} километров в час`;
  } else if (limit.kind === 'none') {
    signState = 'none';
    text = '';
    caption = 'без ограничения';
    label = 'Ограничение снято';
  } else if (limit.kind === 'variable') {
    signState = 'variable';
    text = '?';
    caption = 'переменное';
    label = 'Переменное ограничение';
  }

  dom.sign.dataset.state = signState;
  dom.sign.dataset.digits = String(text.length);
  dom.sign.dataset.implicit = String(Boolean(limit.implicit) && signState === 'number');
  dom.sign.setAttribute('aria-label', label);
  dom.signText.textContent = text;
  dom.signCaption.textContent = caption;
}

function renderStatus(now, accuracyBad) {
  let message = '';

  if (!state.running) {
    message = 'Нажмите «Старт», чтобы разрешить доступ к геолокации.';
  } else if (!watcher.supported) {
    message = 'Геолокация не поддерживается этим браузером.';
  } else if (state.geoError) {
    message = geoErrorText(state.geoError);
  } else if (!speed.lastFix) {
    message = 'Ожидание первой позиции…';
  } else if (accuracyBad) {
    message = `Точность GPS хуже ${POOR_ACCURACY_M} м — ограничение не показывается.`;
  } else if (!overpass.online) {
    message = overpass.lastError === 'timeout'
      ? 'Overpass не отвечает. Повтор запроса позже, скорость считается по GPS.'
      : 'Нет связи с Overpass. Скорость считается по GPS.';
  } else if (currentLimit(now).kind === 'unknown') {
    message = state.matchTs
      ? 'Для этого участка нет данных об ограничении в OpenStreetMap.'
      : 'Дорога не определена: нет данных OSM для этой точки.';
  }

  dom.status.textContent = message;
}

function renderMeta(now, accuracyBad) {
  const fix = speed.lastFix;
  dom.metaAccuracy.textContent = fix && Number.isFinite(fix.accuracy)
    ? `точность: ±${Math.round(fix.accuracy)} м${accuracyBad ? ' (плохая)' : ''}`
    : 'точность: —';

  const age = overpass.dataAge(now);
  if (Number.isFinite(age)) {
    const seconds = Math.round(age / 1000);
    const road = state.roadName ? `${state.roadName} · ` : '';
    dom.metaRoad.textContent = `дорога: ${road}обновлено ${seconds} с назад`;
  } else {
    dom.metaRoad.textContent = 'дорога: данные не загружены';
  }

  const offline = !overpass.online || (typeof navigator !== 'undefined' && navigator.onLine === false);
  dom.metaOffline.hidden = !offline;

  dom.metaSource.textContent = speed.source === 'haversine'
    ? 'скорость: расчёт по координатам'
    : (speed.source === 'gps' ? 'скорость: GPS' : '');
}

function render() {
  const now = Date.now();
  const fix = speed.lastFix;
  const accuracyBad = Boolean(fix && fix.accuracy > POOR_ACCURACY_M);
  const limit = accuracyBad ? UNKNOWN : currentLimit(now);

  renderSpeed(limit);
  renderSign(limit, accuracyBad);
  renderStatus(now, accuracyBad);
  renderMeta(now, accuracyBad);
}

/* ------------------------------------------------------------------ */
/* Wake Lock и видимость вкладки                                       */
/* ------------------------------------------------------------------ */

async function requestWakeLock() {
  // Отсутствие поддержки не должно приводить к ошибке (ТЗ 4).
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (_) {
    state.wakeLock = null;
  }
}

function releaseWakeLock() {
  if (!state.wakeLock) return;
  try { state.wakeLock.release(); } catch (_) { /* уже отпущен */ }
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  const hidden = document.visibilityState === 'hidden';
  // В фоне запросы к Overpass приостанавливаются (ТЗ 4).
  overpass.setPaused(hidden);
  if (!hidden && state.running) {
    requestWakeLock();
    render();
  }
});

window.addEventListener('online', render);
window.addEventListener('offline', render);

// Ни одна ошибка не должна приводить к белому экрану (критерий 8.6).
window.addEventListener('error', (event) => {
  dom.status.textContent = 'Внутренняя ошибка: ' + (event.message || 'неизвестно');
});
window.addEventListener('unhandledrejection', () => {
  dom.status.textContent = 'Внутренняя ошибка при обращении к данным дороги.';
});

render();
