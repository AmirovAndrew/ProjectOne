// Геометрия и подбор сегмента дороги (ТЗ 3.3).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  haversineMeters,
  bearingDeg,
  angleDiffDeg,
  projectPointOnSegment,
  roadClassRank,
  SegmentMatcher,
  MAX_SNAP_DISTANCE_M,
  HYSTERESIS_MARGIN_M,
} from '../../matching.js';

const near = (actual, expected, tolerance, label) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${label}: ожидалось ${expected} ± ${tolerance}, получено ${actual}`,
);

/** Прямая по широте от lon0 до lon1. */
const line = (lat, lon0 = 8.6600, lon1 = 8.7200, points = 40) => {
  const geometry = [];
  for (let i = 0; i <= points; i += 1) geometry.push({ lat, lon: lon0 + ((lon1 - lon0) * i) / points });
  return geometry;
};
const way = (id, lat, tags) => ({ id, tags, geometry: line(lat) });

test('гаверсинус: известные расстояния', () => {
  near(haversineMeters({ lat: 50, lon: 8 }, { lat: 51, lon: 8 }), 111195, 50, 'градус широты');
  near(haversineMeters({ lat: 50, lon: 8 }, { lat: 50, lon: 8.001 }), 71.6, 0.5, '0.001° долготы на 50°');
  assert.equal(haversineMeters({ lat: 50, lon: 8 }, { lat: 50, lon: 8 }), 0);
  // Формула должна оставаться точной и на очень малых расстояниях.
  near(haversineMeters({ lat: 50, lon: 8 }, { lat: 50.0000001, lon: 8 }), 0.011, 0.002, 'сантиметры');
});

test('азимут отрезка', () => {
  near(bearingDeg({ lat: 50, lon: 8 }, { lat: 50.01, lon: 8 }), 0, 0.1, 'север');
  near(bearingDeg({ lat: 50, lon: 8 }, { lat: 50, lon: 8.01 }), 90, 0.1, 'восток');
  near(bearingDeg({ lat: 50, lon: 8 }, { lat: 49.99, lon: 8 }), 180, 0.1, 'юг');
  near(bearingDeg({ lat: 50, lon: 8 }, { lat: 50, lon: 7.99 }), 270, 0.1, 'запад');
});

test('разность азимутов приводится к [0, 180] через ноль', () => {
  assert.equal(angleDiffDeg(90, 90), 0);
  assert.equal(angleDiffDeg(0, 350), 10);
  assert.equal(angleDiffDeg(350, 0), 10);
  assert.equal(angleDiffDeg(10, 350), 20);
  assert.equal(angleDiffDeg(0, 180), 180);
  assert.equal(angleDiffDeg(-10, 10), 20);
});

test('проекция точки на отрезок', () => {
  const a = { lat: 50.1109, lon: 8.6821 };
  const b = { lat: 50.1109, lon: 8.6831 };

  // Точка ровно над серединой отрезка.
  const middle = projectPointOnSegment({ lat: 50.11095, lon: 8.6826 }, a, b);
  near(middle.t, 0.5, 0.01, 'параметр проекции');
  near(middle.distance, 5.56, 0.2, 'расстояние по нормали');

  // За краем отрезка параметр зажимается, расстояние считается до конца.
  const beyond = projectPointOnSegment({ lat: 50.1109, lon: 8.6841 }, a, b);
  assert.equal(beyond.t, 1);
  near(beyond.distance, 71.6, 1, 'до конца отрезка');

  const before = projectPointOnSegment({ lat: 50.1109, lon: 8.6811 }, a, b);
  assert.equal(before.t, 0);

  // Вырожденный отрезок не должен приводить к делению на ноль.
  const degenerate = projectPointOnSegment({ lat: 50.1110, lon: 8.6821 }, a, a);
  assert.ok(Number.isFinite(degenerate.distance));
});

test('ранг класса дороги', () => {
  assert.ok(roadClassRank({ highway: 'motorway' }) > roadClassRank({ highway: 'trunk' }));
  assert.ok(roadClassRank({ highway: 'trunk' }) > roadClassRank({ highway: 'primary' }));
  assert.ok(roadClassRank({ highway: 'primary' }) > roadClassRank({ highway: 'residential' }));
  assert.equal(roadClassRank({ highway: 'footway' }), -1);
});

test('отрезки дальше 40 м отбрасываются', () => {
  const matcher = new SegmentMatcher();
  const ways = [way(1, 50.1109, { highway: 'primary' })];
  // 0.0003° широты ≈ 33 м — попадает.
  assert.equal(matcher.match({ lat: 50.1109 + 0.0003, lon: 8.6821 }, ways, {}).id, 1);
  // 0.0005° ≈ 56 м — за порогом.
  assert.equal(matcher.match({ lat: 50.1109 + 0.0005, lon: 8.6821 }, ways, {}), null);
  assert.ok(MAX_SNAP_DISTANCE_M === 40);
});

test('фильтр по направлению: односторонняя дорога', () => {
  const matcher = new SegmentMatcher();
  const ways = [way(1, 50.1109, { highway: 'primary', oneway: 'yes' })];
  const point = { lat: 50.1109, lon: 8.6821 };

  const along = matcher.match(point, ways, { heading: 90, speedKmh: 60 });
  assert.equal(along.direction, 'forward');

  matcher.reset();
  // Встречное направление на oneway отбрасывается целиком.
  assert.equal(matcher.match(point, ways, { heading: 270, speedKmh: 60 }), null);

  matcher.reset();
  // Допуск ±50°: 130° — ещё в пределах, 145° — уже нет.
  assert.ok(matcher.match(point, ways, { heading: 139, speedKmh: 60 }));
  matcher.reset();
  assert.equal(matcher.match(point, ways, { heading: 145, speedKmh: 60 }), null);
});

test('двусторонняя дорога принимает оба направления', () => {
  const matcher = new SegmentMatcher();
  const ways = [way(1, 50.1109, { highway: 'primary' })];
  const point = { lat: 50.1109, lon: 8.6821 };

  assert.equal(matcher.match(point, ways, { heading: 90, speedKmh: 60 }).direction, 'forward');
  assert.equal(matcher.match(point, ways, { heading: 270, speedKmh: 60 }).direction, 'backward');
  // Поперёк дороги — не подходит ни одно направление.
  matcher.reset();
  assert.equal(matcher.match(point, ways, { heading: 0, speedKmh: 60 }), null);
});

test('на малой скорости и без heading фильтр направления не применяется', () => {
  const ways = [way(1, 50.1109, { highway: 'primary', oneway: 'yes' })];
  const point = { lat: 50.1109, lon: 8.6821 };

  // Встречное направление, но скорость ниже 10 км/ч — heading недостоверен.
  assert.ok(new SegmentMatcher().match(point, ways, { heading: 270, speedKmh: 4 }));
  assert.ok(new SegmentMatcher().match(point, ways, { heading: null, speedKmh: 90 }));
});

test('при разнице менее 10 м приоритет у более высокого класса дороги', () => {
  const matcher = new SegmentMatcher();
  // trunk в 15 м, residential в 8 м — разница 7 м, побеждает trunk.
  const ways = [
    way(1, 50.1109 + 0.000135, { highway: 'trunk' }),
    way(2, 50.1109 - 0.00007, { highway: 'residential' }),
  ];
  assert.equal(matcher.match({ lat: 50.1109, lon: 8.6821 }, ways, {}).id, 1);

  // Если разница больше 10 м, побеждает расстояние.
  const far = [
    way(3, 50.1109 + 0.00027, { highway: 'trunk' }),
    way(4, 50.1109 - 0.00002, { highway: 'residential' }),
  ];
  assert.equal(new SegmentMatcher().match({ lat: 50.1109, lon: 8.6821 }, far, {}).id, 4);
});

test('гистерезис удерживает прежний выбор в пределах 15 м', () => {
  const matcher = new SegmentMatcher();
  // Две одноклассовые улицы в 30 м друг от друга.
  const ways = [
    way(1, 50.1109, { highway: 'residential' }),
    way(2, 50.1109 - 0.00027, { highway: 'residential' }),
  ];
  const middle = 50.1109 - 0.000135;

  // Первый фикс ближе к первой улице — выбирается она.
  assert.equal(matcher.match({ lat: middle + 0.00005, lon: 8.6821 }, ways, {}).id, 1);
  // Сместились ближе ко второй, но в пределах запаса — выбор не меняется.
  assert.equal(matcher.match({ lat: middle - 0.00005, lon: 8.6821 }, ways, {}).id, 1);
  // Ушли далеко за запас — привязка честно переключается.
  assert.equal(matcher.match({ lat: 50.1109 - 0.00027, lon: 8.6821 }, ways, {}).id, 2);
  assert.ok(HYSTERESIS_MARGIN_M === 15);
});

test('потеря кандидатов сбрасывает состояние гистерезиса', () => {
  const matcher = new SegmentMatcher();
  const ways = [way(1, 50.1109, { highway: 'primary' })];
  assert.ok(matcher.match({ lat: 50.1109, lon: 8.6821 }, ways, {}));
  assert.equal(matcher.match({ lat: 50.2000, lon: 8.6821 }, ways, {}), null);
  assert.equal(matcher.previousId, null);
});

test('некорректные входные данные не роняют подбор', () => {
  const matcher = new SegmentMatcher();
  assert.equal(matcher.match(null, [], {}), null);
  assert.equal(matcher.match({ lat: 50, lon: 8 }, null, {}), null);
  assert.equal(matcher.match({ lat: 50, lon: 8 }, [{ id: 1, tags: {}, geometry: [] }], {}), null);
  assert.equal(matcher.match({ lat: 50, lon: 8 }, [{ id: 1, tags: {} }], {}), null);
});
