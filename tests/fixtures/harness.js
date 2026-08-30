// harness.js — фикстура «экран приложения».
//
// Приложению подменяются ровно две вещи: geolocation (чтобы «ехать» без GPS)
// и fetch к Overpass (чтобы отвечать заранее известными дорогами и уметь
// падать по требованию). Всё остальное — настоящий код приложения.

import { test as base, expect } from '@playwright/test';
import { WAYS } from './ways.js';

const EARTH_R = 6371008.8;
const DEG = Math.PI / 180;

/** Точка в `meters` метрах от `from` по азимуту `bearing` (сферическая формула). */
export function destination(from, bearing, meters) {
  const d = meters / EARTH_R;
  const b = bearing * DEG;
  const phi1 = from.lat * DEG;
  const lambda1 = from.lon * DEG;
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(b));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(phi1),
    Math.cos(d) - Math.sin(phi1) * Math.sin(phi2),
  );
  return { lat: phi2 / DEG, lon: ((lambda2 / DEG + 540) % 360) - 180 };
}

export const test = base.extend({
  /**
   * @type {import('@playwright/test').Fixture}
   * Даёт объект `screen` с методами управления «поездкой» и чтением экрана.
   * По завершении теста проверяет, что страница не выбросила ни одной ошибки
   * (критерий приёмки 8.6 — белого экрана быть не должно ни при каком раскладе).
   */
  screen: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push('console: ' + message.text());
    });

    let clockInstalled = false;

    const screen = {
      page,
      errors,

      /**
       * Открывает приложение.
       * @param {{ways?:Array, network?:'online'|'offline'|'timeout', clock?:boolean}} options
       */
      async open(options = {}) {
        const { ways = WAYS, network = 'online', clock = false } = options;
        if (clock) {
          await page.clock.install({ time: new Date('2026-01-01T10:00:00Z') });
          clockInstalled = true;
        }
        await page.addInitScript(([initialWays, initialNetwork]) => {
          window.__ways = initialWays;
          window.__network = initialNetwork;
          window.__fetchCount = 0;
          window.__fetchLog = [];
          window.__positionCallback = null;

          window.fetch = (url, options_) => {
            if (!String(url).includes('interpreter')) {
              return Promise.reject(new Error('неожиданный запрос: ' + url));
            }
            window.__fetchCount += 1;
            window.__fetchLog.push({ at: Date.now(), url: String(url), body: options_ && options_.body });

            if (window.__network === 'offline') {
              return Promise.reject(new TypeError('Failed to fetch'));
            }
            if (window.__network === 'timeout') {
              // Ответа нет: ждём, пока приложение само оборвёт запрос по AbortController.
              return new Promise((_, reject) => {
                const signal = options_ && options_.signal;
                if (!signal) return;
                signal.addEventListener('abort', () => {
                  const error = new Error('aborted');
                  error.name = 'AbortError';
                  reject(error);
                });
              });
            }
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({ elements: window.__ways }),
            });
          };

          Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
              watchPosition(callback, errorCallback) {
                window.__positionCallback = callback;
                window.__errorCallback = errorCallback;
                return 1;
              },
              clearWatch() {
                window.__positionCallback = null;
                window.__errorCallback = null;
              },
            },
          });

          window.__emit = (payload) => {
            if (!window.__positionCallback) return;
            window.__positionCallback(payload);
          };
        }, [ways, network]);

        await page.goto('/index.html');
        return screen;
      },

      /** Нажимает «Старт»/«Стоп». */
      async toggle() {
        await page.click('#toggle');
      },

      async start() {
        await expect(page.locator('#toggle')).toHaveText('Старт');
        await page.click('#toggle');
      },

      async stop() {
        await expect(page.locator('#toggle')).toHaveText('Стоп');
        await page.click('#toggle');
      },

      /** Отдаёт приложению один фикс геолокации. */
      async fix({ lat, lon, speed = null, heading = null, accuracy = 8, timestamp = null }) {
        await page.evaluate((coords) => {
          window.__emit({
            coords: {
              latitude: coords.lat,
              longitude: coords.lon,
              accuracy: coords.accuracy,
              altitude: null,
              altitudeAccuracy: null,
              heading: coords.heading,
              speed: coords.speed,
            },
            timestamp: coords.timestamp ?? Date.now(),
          });
        }, { lat, lon, speed, heading, accuracy, timestamp });
        await screen.settle();
      },

      /**
       * Отдаёт приложению ошибку геолокации.
       * Коды по спецификации: 1 — PERMISSION_DENIED, 2 — POSITION_UNAVAILABLE, 3 — TIMEOUT.
       */
      async fail(code, message = '') {
        await page.evaluate(([c, m]) => {
          window.__errorCallback && window.__errorCallback({ code: c, message: m });
        }, [code, message]);
        await screen.settle();
      },

      /**
       * «Едет» из точки по азимуту с постоянной скоростью, отдавая по фиксу в секунду.
       * @param {{from:{lat:number,lon:number}, bearing?:number, speedMs?:number,
       *          seconds:number, gpsSpeed?:boolean, accuracy?:number}} options
       */
      async drive(options) {
        const {
          from, bearing = 90, speedMs = 13.9, seconds,
          gpsSpeed = true, accuracy = 8, stepMs = 1000,
        } = options;
        // Метки времени задаём явно: расчёт скорости опирается на position.timestamp,
        // и тест не должен зависеть от того, сколько реально длится прогон.
        const start = await page.evaluate(() => Date.now());
        let point = { ...from };
        for (let step = 0; step < seconds; step += 1) {
          await screen.fix({
            lat: point.lat,
            lon: point.lon,
            speed: gpsSpeed ? speedMs : null,
            heading: bearing,
            accuracy,
            timestamp: start + step * stepMs,
          });
          await screen.tick(stepMs);
          point = destination(point, bearing, speedMs);
        }
        return point;
      },

      /**
       * Продвигает время. С поддельными часами время движется по-настоящему
       * (срабатывают таймеры приложения); без них — просто даём дорабатать промисам,
       * чтобы прогон не растягивался на реальные минуты.
       */
      async tick(ms) {
        if (clockInstalled) await page.clock.runFor(ms);
        else await screen.settle();
      },

      /**
       * Даёт приложению доработать цепочки промисов (ответ Overpass -> подбор
       * сегмента -> отрисовка). Через микрозадачи, а не setTimeout: с поддельными
       * часами setTimeout не сработает без явного runFor.
       */
      async settle() {
        for (let i = 0; i < 3; i += 1) {
          await page.evaluate(() => new Promise((resolve) => queueMicrotask(resolve)));
        }
      },

      async setNetwork(mode) {
        await page.evaluate((value) => { window.__network = value; }, mode);
      },

      async setWays(ways) {
        await page.evaluate((value) => { window.__ways = value; }, ways);
      },

      fetchCount() {
        return page.evaluate(() => window.__fetchCount);
      },

      fetchLog() {
        return page.evaluate(() => window.__fetchLog);
      },

      /** Полное состояние экрана одним объектом. */
      read() {
        return page.evaluate(() => {
          const text = (id) => document.getElementById(id).textContent.trim();
          const sign = document.getElementById('sign');
          return {
            speed: text('speedValue'),
            speedColor: getComputedStyle(document.getElementById('speedValue')).color,
            over: document.getElementById('speedValue').className.replace('speed-value', '').trim(),
            sign: sign.dataset.state,
            signImplicit: sign.dataset.implicit === 'true',
            signText: text('signText'),
            caption: text('signCaption'),
            status: text('status'),
            accuracy: text('metaAccuracy'),
            road: text('metaRoad'),
            source: text('metaSource'),
            offline: !document.getElementById('metaOffline').hidden,
            button: text('toggle'),
          };
        });
      },
    };

    await use(screen);

    expect(errors, 'страница не должна выбрасывать ошибок').toEqual([]);
  },
});

export { expect };
export { WAYS, LANES, FRANKFURT, line, at } from './ways.js';
