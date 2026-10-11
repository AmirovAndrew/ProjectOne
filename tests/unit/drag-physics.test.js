// Модель разгона для сайта drag/: калибровка по опубликованным данным.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CARS } from '../../drag/data.js';
import {
  calibrate, timeToSpeed, elapsedTime, trapSpeed, trace, sample, QUARTER_MILE,
} from '../../drag/physics.js';

const models = new Map(CARS.map((car) => [car.id, calibrate(car)]));

test('у каждой машины уникальный id и полный набор полей', () => {
  const ids = new Set();
  for (const car of CARS) {
    assert.ok(!ids.has(car.id), `дубликат id ${car.id}`);
    ids.add(car.id);
    for (const key of ['name', 'variant', 'segment', 'drive', 'energy', 'kw', 'kg', 'top', 'cda', 'len', 'wid', 't100', 't100Src']) {
      assert.ok(car[key] !== undefined, `${car.id}: нет поля ${key}`);
    }
    assert.ok(['AWD', 'RWD', 'FWD'].includes(car.drive), `${car.id}: привод ${car.drive}`);
  }
});

test('модель воспроизводит опубликованное время 0–100 км/ч', () => {
  for (const car of CARS) {
    const t = timeToSpeed(models.get(car.id), 100);
    assert.ok(Math.abs(t - car.t100) < 0.01, `${car.id}: ${t.toFixed(3)} вместо ${car.t100}`);
  }
});

test('модель воспроизводит второй опорный замер (0–200 или 1/4 мили)', () => {
  for (const car of CARS.filter((c) => c.anchor)) {
    const p = models.get(car.id);
    const t = car.anchor.kmh ? timeToSpeed(p, car.anchor.kmh) : elapsedTime(p, car.anchor.metres);
    assert.ok(Math.abs(t - car.anchor.t) < 0.03, `${car.id}: ${t.toFixed(3)} вместо ${car.anchor.t}`);
  }
});

test('скорость на ловушке 1/4 мили близка к журнальным тестам (±6 %)', () => {
  for (const car of CARS.filter((c) => c.test?.trapMph && c.anchor?.metres)) {
    const kmh = trapSpeed(models.get(car.id));
    const published = car.test.trapMph * 1.609344;
    assert.ok(Math.abs(kmh / published - 1) < 0.06, `${car.id}: ${kmh.toFixed(1)} км/ч против ${published.toFixed(1)}`);
  }
});

test('параметры физически правдоподобны', () => {
  for (const car of CARS) {
    const p = models.get(car.id);
    assert.ok(p.A >= 0.45 * 9.81 && p.A < 1.8 * 9.81, `${car.id}: сцепление ${(p.A / 9.81).toFixed(2)} g`);
    // Удельная мощность на колёсах не больше заявленной пиковой.
    assert.ok(p.P * car.kg <= car.kw * 1000 * 1.0, `${car.id}: мощность на колёсах ${(p.P * car.kg / 1000).toFixed(0)} кВт`);
  }
});

test('трасса монотонна, а выборка интерполирует между точками', () => {
  const tr = trace(models.get('golfr'), QUARTER_MILE);
  for (let i = 1; i < tr.t.length; i++) {
    assert.ok(tr.v[i] >= tr.v[i - 1] - 1e-9);
    assert.ok(tr.x[i] >= tr.x[i - 1]);
  }
  const mid = sample(tr, 2.005);
  const a = sample(tr, 2.0), b = sample(tr, 2.01);
  assert.ok(mid.x >= a.x && mid.x <= b.x);
  assert.equal(sample(tr, 0).x, 0);
});
