// Кэш, лимиты запросов и бэкофф (ТЗ 3.6).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OverpassClient,
  WayCache,
  buildQuery,
  OVERPASS_URL,
  QUERY_RADIUS_M,
  REFETCH_DISTANCE_M,
  REFETCH_AGE_MS,
  MIN_REQUEST_INTERVAL_MS,
  PACING_INTERVAL_MS,
  REQUEST_BUDGET,
  REQUEST_WINDOW_MS,
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  BACKOFF_STEPS_MS,
} from '../../overpass.js';

const way = (id) => ({ type: 'way', id, tags: { highway: 'primary' }, geometry: [] });

/**
 * Клиент с подменёнными fetch и часами: время двигаем вручную,
 * чтобы проверять лимиты без реальных пауз.
 */
function client(options = {}) {
  const calls = [];
  const clock = { value: options.start ?? 1_000_000 };
  const instance = new OverpassClient({
    now: () => clock.value,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body });
      if (options.fail) throw new TypeError('Failed to fetch');
      if (options.abort) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return { ok: true, status: 200, json: async () => ({ elements: options.elements || [way(1)] }) };
    },
    ...options.client,
  });
  return { instance, calls, clock, advance: (ms) => { clock.value += ms; } };
}

test('константы соответствуют ТЗ 3.6', () => {
  assert.equal(OVERPASS_URL, 'https://overpass-api.de/api/interpreter');
  assert.equal(QUERY_RADIUS_M, 60);
  assert.equal(REFETCH_DISTANCE_M, 150);
  assert.equal(REFETCH_AGE_MS, 120000);
  assert.equal(MIN_REQUEST_INTERVAL_MS, 5000);
  assert.equal(CACHE_MAX_ENTRIES, 500);
  assert.equal(CACHE_TTL_MS, 600000);
  assert.deepEqual(BACKOFF_STEPS_MS, [5000, 10000, 20000, 40000, 60000]);
});

test('целевой темп запросов удерживает бюджет критерия 8.5', () => {
  // Не более 60 запросов за 10 минут — значит, не чаще одного в 10 с.
  assert.ok(PACING_INTERVAL_MS >= REQUEST_WINDOW_MS / REQUEST_BUDGET);
  assert.ok(PACING_INTERVAL_MS >= MIN_REQUEST_INTERVAL_MS);
  assert.equal(REQUEST_BUDGET, 60);
  assert.equal(REQUEST_WINDOW_MS, 600000);
});

test('запрос собирается по образцу из ТЗ 3.3', () => {
  const query = buildQuery(50.1109, 8.6821);
  assert.match(query, /^\[out:json\]\[timeout:10\];/);
  assert.match(query, /way\(around:60,50\.110900,8\.682100\)/);
  assert.match(query, /motorway\|motorway_link\|trunk\|trunk_link\|primary/);
  assert.match(query, /living_street/);
  assert.match(query, /out tags geom;$/);
});

test('кэш вытесняет по LRU и не превышает лимит', () => {
  const cache = new WayCache(3, 1000);
  for (const id of [1, 2, 3]) cache.put(way(id));
  // Обращение к записи делает её свежей.
  cache.put(way(1));
  cache.put(way(4));

  assert.equal(cache.size, 3);
  const ids = cache.values().map((w) => w.id).sort();
  assert.deepEqual(ids, [1, 3, 4], 'вытеснена самая давняя — 2');
});

test('кэш отдаёт только живые записи и чистит просроченные', () => {
  const cache = new WayCache(10, 1000);
  cache.put(way(1), 0);
  cache.put(way(2), 900);

  assert.equal(cache.values(950).length, 2);
  assert.equal(cache.values(1500).length, 1, 'первая протухла');
  assert.equal(cache.size, 1, 'просроченная запись удалена');
});

test('первый запрос уходит сразу, повторный — не раньше целевого интервала', async () => {
  const { instance, calls, advance } = client();

  assert.equal(await instance.update(50.1109, 8.6821), true);
  assert.equal(calls.length, 1);

  // Уехали на километр, но времени прошло мало.
  advance(3000);
  assert.equal(instance.shouldRequest(50.1200, 8.6821), false);

  advance(PACING_INTERVAL_MS);
  assert.equal(instance.shouldRequest(50.1200, 8.6821), true);
});

test('без достаточного смещения и до истечения возраста запроса нет', async () => {
  const { instance, advance } = client();
  await instance.update(50.1109, 8.6821);

  advance(60000);
  // ~100 м — меньше порога в 150 м.
  assert.equal(instance.shouldRequest(50.1118, 8.6821), false);
  // ~220 м — уже достаточно.
  assert.equal(instance.shouldRequest(50.1129, 8.6821), true);

  // Стоим на месте, но прошло больше 120 с.
  advance(REFETCH_AGE_MS);
  assert.equal(instance.shouldRequest(50.1109, 8.6821), true);
});

test('бюджет в 60 запросов на окно 10 минут соблюдается жёстко', async () => {
  const { instance, clock, advance } = client();
  const start = clock.value;
  instance.lastQueryPoint = { lat: 50.1109, lon: 8.6821 };
  instance.lastQueryTs = start;

  // Забиваем журнал бюджета.
  instance.requestLog = Array.from({ length: REQUEST_BUDGET }, (_, i) => start + i * 1000);
  instance.lastRequestTs = start;

  advance(REQUEST_BUDGET * 1000 + PACING_INTERVAL_MS);
  assert.equal(instance.shouldRequest(50.2000, 8.6821), false, 'бюджет исчерпан');

  // Когда окно освободилось, запросы снова разрешены.
  advance(REQUEST_WINDOW_MS);
  assert.equal(instance.shouldRequest(50.2000, 8.6821), true);
});

test('ошибка сети переводит клиент в офлайн и включает бэкофф', async () => {
  const { instance, clock } = client({ fail: true });

  assert.equal(await instance.update(50.1109, 8.6821), false);
  assert.equal(instance.online, false);
  assert.equal(instance.lastError, 'network');
  assert.equal(instance.failures, 1);
  assert.equal(instance.nextAllowedTs, clock.value + BACKOFF_STEPS_MS[0], 'назначен повтор через 5 с');
});

test('тайм-аут отличается от сетевой ошибки', async () => {
  const { instance } = client({ abort: true });
  await instance.update(50.1109, 8.6821);
  assert.equal(instance.lastError, 'timeout');
});

test('задержки повторов растут 5 -> 10 -> 20 -> 40 -> 60 и дальше не увеличиваются', async () => {
  const { instance, clock } = client({ fail: true });
  const delays = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await instance.request(50.1109, 8.6821);
    delays.push(instance.nextAllowedTs - clock.value);
  }
  assert.deepEqual(delays, [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
});

test('успешный ответ сбрасывает бэкофф и наполняет кэш', async () => {
  const { instance } = client({ elements: [way(1), way(2), { type: 'node', id: 9 }] });
  instance.failures = 3;
  instance.online = false;

  await instance.request(50.1109, 8.6821);

  assert.equal(instance.online, true);
  assert.equal(instance.failures, 0);
  assert.equal(instance.nextAllowedTs, 0);
  // Узлы в кэш не попадают — только way с геометрией.
  assert.deepEqual(instance.getWays().map((w) => w.id).sort(), [1, 2]);
});

test('в фоне запросы не выполняются', async () => {
  const { instance, calls } = client();
  instance.setPaused(true);
  assert.equal(await instance.update(50.1109, 8.6821), false);
  assert.equal(calls.length, 0);

  instance.setPaused(false);
  assert.equal(await instance.update(50.1109, 8.6821), true);
  assert.equal(calls.length, 1);
});

test('параллельные вызовы не порождают двойного запроса', async () => {
  const { instance, calls } = client();
  const [first, second] = await Promise.all([
    instance.update(50.1109, 8.6821),
    instance.update(50.1109, 8.6821),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(first !== second, true, 'ровно один вызов обновил кэш');
});
