// Расчёт и сглаживание скорости (ТЗ 3.2), тексты ошибок геолокации (ТЗ 5.2).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SpeedTracker,
  geoErrorText,
  GEO_OPTIONS,
  FIX_HISTORY,
  EMA_ALPHA,
} from '../../geo.js';

/** Фикс в формате GeolocationPosition. */
const fix = ({ lat = 50.1109, lon = 8.6821, speed = null, heading = null, accuracy = 8, t = 0 }) => ({
  coords: { latitude: lat, longitude: lon, accuracy, altitude: null, altitudeAccuracy: null, heading, speed },
  timestamp: t,
});

const near = (actual, expected, tolerance, label) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${label}: ожидалось ${expected} ± ${tolerance}, получено ${actual}`,
);

test('опции watchPosition соответствуют ТЗ 3.1', () => {
  assert.deepEqual({ ...GEO_OPTIONS }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
});

test('coords.speed переводится из м/с в км/ч', () => {
  const tracker = new SpeedTracker();
  tracker.add(fix({ speed: 10, t: 0 }));
  near(tracker.value, 36, 0.01, 'первое значение задаёт EMA');
  assert.equal(tracker.source, 'gps');
});

test('EMA сглаживает с коэффициентом 0.3', () => {
  const tracker = new SpeedTracker();
  tracker.add(fix({ speed: 0, t: 0 }));         // 0 км/ч
  tracker.add(fix({ speed: 100 / 3.6, t: 1000 })); // 100 км/ч
  // 0.3 * 100 + 0.7 * 0 = 30
  near(tracker.value, 30, 0.01, 'один шаг EMA');
  assert.equal(EMA_ALPHA, 0.3);
});

test('фолбэк по гаверсинусу при speed === null', () => {
  const tracker = new SpeedTracker();
  tracker.add(fix({ lon: 8.6821, speed: null, t: 0 }));
  // 0.0002° долготы на 50.11° ≈ 14.3 м за 1 с ≈ 51.5 км/ч
  const result = tracker.add(fix({ lon: 8.6823, speed: null, t: 1000 }));
  assert.equal(result.source, 'haversine');
  near(tracker.value, 51.5, 1.5, 'скорость по координатам');
});

test('фолбэк не применяется вне окна 0.5–5 с', () => {
  for (const dt of [400, 6000]) {
    const tracker = new SpeedTracker();
    tracker.add(fix({ lon: 8.6821, speed: null, t: 0 }));
    const result = tracker.add(fix({ lon: 8.6823, speed: null, t: dt }));
    assert.equal(result.updated, false, `dt = ${dt} мс не должен обновлять значение`);
    assert.equal(tracker.value, null);
  }
});

test('фолбэк не применяется при точности хуже 50 м', () => {
  const tracker = new SpeedTracker();
  tracker.add(fix({ lon: 8.6821, speed: null, accuracy: 60, t: 0 }));
  const result = tracker.add(fix({ lon: 8.6823, speed: null, accuracy: 60, t: 1000 }));
  assert.equal(result.updated, false);
});

test('при невыполнении условий прежнее значение сохраняется, а не обнуляется', () => {
  const tracker = new SpeedTracker();
  tracker.add(fix({ speed: 20, t: 0 }));      // 72 км/ч
  const before = tracker.value;
  // Плохой фикс: скорости нет, интервал слишком большой.
  const result = tracker.add(fix({ lon: 8.6823, speed: null, t: 100000 }));
  assert.equal(result.updated, false);
  assert.equal(tracker.value, before, 'ноль показывать нельзя');
});

test('значения ниже 3 км/ч подавляются до нуля', () => {
  const tracker = new SpeedTracker();
  tracker.add(fix({ speed: 0.5, t: 0 })); // 1.8 км/ч
  assert.equal(tracker.value, 0);
  assert.equal(tracker.display, 0);
});

test('нулевая скорость от GPS — валидное значение, а не отсутствие данных', () => {
  const tracker = new SpeedTracker();
  const result = tracker.add(fix({ speed: 0, t: 0 }));
  assert.equal(result.updated, true);
  assert.equal(tracker.value, 0);
});

test('до первого пригодного фикса значение отсутствует', () => {
  const tracker = new SpeedTracker();
  assert.equal(tracker.value, null);
  assert.equal(tracker.display, null);
  tracker.add(fix({ speed: null, t: 0 }));
  assert.equal(tracker.value, null, 'один фикс без скорости — данных всё ещё нет');
});

test('отображается целое число', () => {
  const tracker = new SpeedTracker();
  tracker.add(fix({ speed: 13.89, t: 0 })); // 50.004 км/ч
  assert.equal(tracker.display, 50);
  assert.equal(Number.isInteger(tracker.display), true);
});

test('история ограничена пятью фиксами', () => {
  const tracker = new SpeedTracker();
  for (let i = 0; i < 12; i += 1) tracker.add(fix({ speed: 10, t: i * 1000 }));
  assert.equal(tracker.fixes.length, FIX_HISTORY);
  assert.equal(FIX_HISTORY, 5);
  assert.equal(tracker.lastFix.timestamp, 11000);
});

test('сброс очищает состояние', () => {
  const tracker = new SpeedTracker();
  tracker.add(fix({ speed: 10, t: 0 }));
  tracker.reset();
  assert.equal(tracker.value, null);
  assert.equal(tracker.fixes.length, 0);
  assert.equal(tracker.source, null);
});

test('heading и accuracy извлекаются из фикса', () => {
  const tracker = new SpeedTracker();
  tracker.add(fix({ speed: 10, heading: 137.5, accuracy: 12, t: 0 }));
  assert.equal(tracker.lastFix.heading, 137.5);
  assert.equal(tracker.lastFix.accuracy, 12);

  tracker.add(fix({ speed: 10, heading: NaN, accuracy: NaN, t: 1000 }));
  assert.equal(tracker.lastFix.heading, null, 'NaN heading -> null');
  assert.equal(tracker.lastFix.accuracy, Infinity, 'NaN accuracy -> заведомо плохая точность');
});

test('тексты ошибок геолокации различаются по коду', () => {
  const texts = [1, 2, 3, 0].map((code) => geoErrorText({ code }));
  assert.equal(new Set(texts).size, 4, 'каждый код должен иметь свой текст');
  assert.match(texts[0], /запрещ/i);
  assert.match(texts[1], /недоступн/i);
  assert.match(texts[2], /айм-аут/i);
});
