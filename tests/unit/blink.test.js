import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlinkDetector, blinkScore } from '../../blink/detector.js';

const cats = (left, right) => [
  { categoryName: 'eyeBlinkLeft', score: left },
  { categoryName: 'eyeLookUpLeft', score: 0.9 },
  { categoryName: 'eyeBlinkRight', score: right },
];

test('blinkScore: оба глаза — минимум, любой — максимум', () => {
  assert.equal(blinkScore(cats(0.8, 0.3), 'both'), 0.3);
  assert.equal(blinkScore(cats(0.8, 0.3), 'any'), 0.8);
  assert.equal(blinkScore([], 'both'), 0);
  assert.equal(blinkScore(undefined), 0);
});

test('обычное моргание: close при закрытии, blink при открытии', () => {
  const d = new BlinkDetector();
  assert.equal(d.update(0.1, 0), null);
  assert.equal(d.update(0.7, 33), 'close');
  assert.equal(d.update(0.8, 66), null);
  assert.equal(d.update(0.2, 150), 'blink');
  assert.equal(d.count, 1);
});

test('гистерезис: колебания около порога не дают повторных срабатываний', () => {
  const d = new BlinkDetector({ closeThreshold: 0.5, hysteresis: 0.15 });
  assert.equal(d.update(0.55, 0), 'close');
  assert.equal(d.update(0.45, 30), null);
  assert.equal(d.update(0.52, 60), null);
  assert.equal(d.update(0.30, 90), 'blink');
});

test('рефрактерный период глушит дребезг', () => {
  const d = new BlinkDetector({ refractoryMs: 150 });
  assert.equal(d.update(0.9, 0), 'close');
  assert.equal(d.update(0.0, 40), 'blink');
  assert.equal(d.update(0.9, 80), null);
  assert.equal(d.update(0.0, 120), null);
  assert.equal(d.update(0.9, 200), 'close');
});

test('долгое закрытие не считается морганием', () => {
  const d = new BlinkDetector({ maxBlinkMs: 800 });
  assert.equal(d.update(0.9, 0), 'close');
  assert.equal(d.update(0.0, 1500), 'long');
  assert.equal(d.count, 0);
});

test('потеря лица сбрасывает закрытое состояние', () => {
  const d = new BlinkDetector();
  d.update(0.9, 0);
  d.lost();
  assert.equal(d.closed, false);
  assert.equal(d.update(0.0, 50), null);
  assert.equal(d.count, 0);
});
