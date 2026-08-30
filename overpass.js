// overpass.js — запросы к Overpass API, кэш дорог, rate limit и бэкофф.

import { haversineMeters } from './matching.js';

/** URL Overpass API. Вынесен в константу конфигурации (ТЗ 3.3). */
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Радиус выборки дорог вокруг точки, м. */
export const QUERY_RADIUS_M = 60;
/** Смещение, после которого нужен новый запрос (ТЗ 3.6). */
export const REFETCH_DISTANCE_M = 150;
/** Возраст данных, после которого нужен новый запрос (ТЗ 3.6). */
export const REFETCH_AGE_MS = 120000;
/** Жёсткий минимум между запросами (ТЗ 3.6). */
export const MIN_REQUEST_INTERVAL_MS = 5000;
/**
 * Целевой интервал запросов. 10 с даёт не более 60 запросов за 10 минут —
 * критерий приёмки 8.5. Пятисекундный минимум выше остаётся нижней границей
 * для повторов после ошибок.
 */
export const PACING_INTERVAL_MS = 10000;
/** Жёсткий бюджет: не более N запросов в скользящем окне (критерий 8.5). */
export const REQUEST_BUDGET = 60;
export const REQUEST_WINDOW_MS = 600000;

/** Кэш дорог (ТЗ 3.6). */
export const CACHE_MAX_ENTRIES = 500;
export const CACHE_TTL_MS = 600000;

/** Тайм-аут HTTP-запроса. */
export const REQUEST_TIMEOUT_MS = 12000;
/** Экспоненциальная задержка после ошибок (ТЗ 3.6). */
export const BACKOFF_STEPS_MS = [5000, 10000, 20000, 40000, 60000];

const HIGHWAY_FILTER = '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|'
  + 'secondary_link|tertiary|tertiary_link|unclassified|residential|living_street)$';

export function buildQuery(lat, lon, radius = QUERY_RADIUS_M) {
  const la = lat.toFixed(6);
  const lo = lon.toFixed(6);
  return `[out:json][timeout:10];\nway(around:${radius},${la},${lo})\n  ["highway"~"${HIGHWAY_FILTER}"];\nout tags geom;`;
}

/** Кэш way с TTL и вытеснением по LRU (Map хранит порядок вставки). */
export class WayCache {
  constructor(max = CACHE_MAX_ENTRIES, ttl = CACHE_TTL_MS) {
    this.max = max;
    this.ttl = ttl;
    this.entries = new Map();
  }

  put(way, now = Date.now()) {
    if (!way || way.id === undefined) return;
    // Переустановка ключа переносит запись в конец — это и есть «свежесть» LRU.
    if (this.entries.has(way.id)) this.entries.delete(way.id);
    this.entries.set(way.id, { way, ts: now });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  /** Живые (не протухшие) записи; попутно чистит просроченные. */
  values(now = Date.now()) {
    const result = [];
    for (const [id, entry] of this.entries) {
      if (now - entry.ts > this.ttl) {
        this.entries.delete(id);
        continue;
      }
      result.push(entry.way);
    }
    return result;
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * Клиент Overpass: решает, нужен ли запрос, соблюдает лимиты,
 * складывает ответы в кэш и держит состояние сети.
 */
export class OverpassClient {
  constructor(options = {}) {
    this.url = options.url || OVERPASS_URL;
    this.radius = options.radius ?? QUERY_RADIUS_M;
    this.cache = new WayCache(options.cacheMax, options.cacheTtl);
    this.distanceFn = options.distanceFn || haversineMeters;
    this.fetchImpl = options.fetchImpl || ((...args) => fetch(...args));

    this.paused = false;
    this.pending = false;
    this.online = true;
    this.lastQueryPoint = null;
    this.lastQueryTs = 0;
    this.lastSuccessTs = 0;
    this.lastRequestTs = 0;
    this.failures = 0;
    this.nextAllowedTs = 0;
    this.requestLog = [];
    this.lastError = null;
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
  }

  getWays(now = Date.now()) {
    return this.cache.values(now);
  }

  /** Сколько миллисекунд прошло с последнего успешного ответа. */
  dataAge(now = Date.now()) {
    return this.lastSuccessTs ? now - this.lastSuccessTs : Infinity;
  }

  /** Число запросов в скользящем окне; попутно подрезает журнал. */
  requestsInWindow(now = Date.now()) {
    this.requestLog = this.requestLog.filter((ts) => now - ts < REQUEST_WINDOW_MS);
    return this.requestLog.length;
  }

  /** Нужен ли новый запрос для этой точки (ТЗ 3.6). */
  shouldRequest(lat, lon, now = Date.now()) {
    if (this.paused || this.pending) return false;
    if (now < this.nextAllowedTs) return false;
    if (now - this.lastRequestTs < MIN_REQUEST_INTERVAL_MS) return false;
    if (this.requestsInWindow(now) >= REQUEST_BUDGET) return false;

    if (!this.lastQueryPoint) return true;

    const moved = this.distanceFn(this.lastQueryPoint, { lat, lon });
    const aged = now - this.lastQueryTs >= REFETCH_AGE_MS;
    if (!(moved > REFETCH_DISTANCE_M || aged)) return false;

    // Условие обновления выполнено, но выдерживаем целевой темп запросов.
    return now - this.lastRequestTs >= PACING_INTERVAL_MS;
  }

  /**
   * Выполняет запрос, если он нужен. Ошибки не пробрасываются наружу:
   * приложение обязано продолжать работать (ТЗ 3.6, критерий 8.6).
   * @returns {Promise<boolean>} true, если кэш обновился
   */
  async update(lat, lon, now = Date.now()) {
    if (!this.shouldRequest(lat, lon, now)) return false;
    return this.request(lat, lon);
  }

  async request(lat, lon) {
    const started = Date.now();
    this.pending = true;
    this.lastRequestTs = started;
    this.requestLog.push(started);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => controller && controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(buildQuery(lat, lon, this.radius)),
        signal: controller ? controller.signal : undefined,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);

      const json = await response.json();
      const elements = Array.isArray(json.elements) ? json.elements : [];
      const ts = Date.now();
      for (const element of elements) {
        if (element.type === 'way' && Array.isArray(element.geometry)) this.cache.put(element, ts);
      }

      this.online = true;
      this.failures = 0;
      this.nextAllowedTs = 0;
      this.lastError = null;
      this.lastQueryPoint = { lat, lon };
      this.lastQueryTs = ts;
      this.lastSuccessTs = ts;
      return true;
    } catch (error) {
      // Сеть или тайм-аут: помечаем офлайн и отступаем по экспоненте.
      this.online = false;
      this.lastError = error && error.name === 'AbortError' ? 'timeout' : 'network';
      const delay = BACKOFF_STEPS_MS[Math.min(this.failures, BACKOFF_STEPS_MS.length - 1)];
      this.failures += 1;
      this.nextAllowedTs = Date.now() + delay;
      return false;
    } finally {
      clearTimeout(timer);
      this.pending = false;
    }
  }
}
