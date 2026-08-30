// Разбор тега maxspeed и таблица implicit-ограничений (ТЗ 3.4 и 3.5).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMaxspeedValue,
  resolveSpeedLimit,
  lookupImplicit,
  countryFromTags,
  IMPLICIT_LIMITS,
  WALK_KMH,
} from '../../maxspeed.js';

test('таблица разбора значений из ТЗ 3.4', () => {
  const rows = [
    ['50', { kind: 'number', kmh: 50 }],
    ['30 mph', { kind: 'number', kmh: 48 }],
    ['none', { kind: 'none', kmh: null }],
    ['walk', { kind: 'walk', kmh: WALK_KMH, label: 'шаг' }],
    ['signals', { kind: 'variable', kmh: null, label: 'переменное' }],
    ['variable', { kind: 'variable', kmh: null, label: 'переменное' }],
    ['DE:urban', { kind: 'number', kmh: 50 }],
  ];
  for (const [raw, expected] of rows) {
    const actual = parseMaxspeedValue(raw);
    assert.ok(actual, `не разобрано: ${raw}`);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(actual[key], value, `${raw} -> ${key}`);
    }
  }
});

test('единицы измерения и записи, встречающиеся в OSM', () => {
  assert.equal(parseMaxspeedValue('60 km/h').kmh, 60);
  assert.equal(parseMaxspeedValue('60kph').kmh, 60);
  assert.equal(parseMaxspeedValue('  70  ').kmh, 70);
  // Перечисление через ';' (разные полосы) — берём первое значение.
  assert.equal(parseMaxspeedValue('80;100').kmh, 80);
  // Региональный префикс.
  assert.equal(parseMaxspeedValue('DE-BW:rural').kmh, 100);
  // Зоны.
  assert.equal(parseMaxspeedValue('DE:zone30').kmh, 30);
  assert.equal(parseMaxspeedValue('DE:zone:30').kmh, 30);
});

test('нераспознанное значение не превращается в число', () => {
  for (const raw of ['', '   ', 'fast', 'RU:', 'abc:urban', null, undefined, '0', '-10']) {
    assert.equal(parseMaxspeedValue(raw), null, `должно быть null: ${JSON.stringify(raw)}`);
  }
});

test('таблица implicit-ограничений соответствует ТЗ 3.5', () => {
  assert.deepEqual(IMPLICIT_LIMITS.DE, {
    urban: 50, rural: 100, motorway: 'none', living_street: 'walk', bicycle_road: 30,
  });
  assert.deepEqual(IMPLICIT_LIMITS.AT, { urban: 50, rural: 100, motorway: 130, living_street: 'walk' });
  assert.deepEqual(IMPLICIT_LIMITS.FR, { urban: 50, rural: 80, motorway: 130 });
  assert.deepEqual(IMPLICIT_LIMITS.PL, { urban: 50, rural: 90, motorway: 140 });
  assert.deepEqual(IMPLICIT_LIMITS.RU, { urban: 60, rural: 90, motorway: 110, living_street: 20 });
});

test('спецзначения таблицы разворачиваются в состояния, а не в числа', () => {
  assert.equal(lookupImplicit('DE', 'motorway').kind, 'none');
  assert.equal(lookupImplicit('DE', 'living_street').kind, 'walk');
  assert.equal(lookupImplicit('AT', 'motorway').kmh, 130);
  assert.equal(lookupImplicit('XX', 'urban'), null);
  assert.equal(lookupImplicit('DE', 'highway'), null);
});

test('приоритет источников: maxspeed -> направленный тег -> zone:maxspeed', () => {
  const tags = {
    highway: 'secondary',
    maxspeed: '50',
    'maxspeed:forward': '70',
    'zone:maxspeed': 'DE:30',
  };
  assert.equal(resolveSpeedLimit(tags, 'forward').source, 'maxspeed');

  const noMain = { ...tags };
  delete noMain.maxspeed;
  assert.equal(resolveSpeedLimit(noMain, 'forward').kmh, 70);

  const onlyZone = { highway: 'secondary', 'zone:maxspeed': 'DE:30' };
  const zone = resolveSpeedLimit(onlyZone, 'forward');
  assert.equal(zone.kmh, 30);
  assert.equal(zone.source, 'zone:maxspeed');
});

test('направленные теги выбираются по направлению движения', () => {
  const tags = { highway: 'secondary', 'maxspeed:forward': '70', 'maxspeed:backward': '40' };
  assert.equal(resolveSpeedLimit(tags, 'forward').kmh, 70);
  assert.equal(resolveSpeedLimit(tags, 'backward').kmh, 40);
  // Направление неизвестно — берём хоть что-то, но не наугад из противоположного.
  assert.equal(resolveSpeedLimit(tags, 'unknown').kmh, 70);
});

test('страна берётся из тегов, а не угадывается', () => {
  assert.equal(countryFromTags({ 'addr:country': 'de' }), 'DE');
  assert.equal(countryFromTags({ maxspeed: 'AT:urban' }), 'AT');
  assert.equal(countryFromTags({ 'zone:maxspeed': 'FR:50' }), 'FR');
  assert.equal(countryFromTags({ highway: 'motorway' }), null);
});

test('без тегов и без известной страны — «нет данных»', () => {
  const result = resolveSpeedLimit({ highway: 'motorway' }, 'forward', null);
  assert.equal(result.kind, 'unknown');
  assert.equal(result.kmh, null);
});

test('однозначные типы дорог подставляются из таблицы при известной стране', () => {
  assert.equal(resolveSpeedLimit({ highway: 'motorway' }, 'forward', 'DE').kind, 'none');
  assert.equal(resolveSpeedLimit({ highway: 'motorway' }, 'forward', 'AT').kmh, 130);
  assert.equal(resolveSpeedLimit({ highway: 'living_street' }, 'forward', 'RU').kmh, 20);
  assert.equal(resolveSpeedLimit({ highway: 'residential' }, 'forward', 'RU').kmh, 60);
  // Деление на urban/rural по координатам невозможно — гадать нельзя.
  assert.equal(resolveSpeedLimit({ highway: 'primary' }, 'forward', 'DE').kind, 'unknown');
  assert.equal(resolveSpeedLimit({ highway: 'tertiary' }, 'forward', 'FR').kind, 'unknown');
});

test('подставленное значение помечено как implicit', () => {
  assert.equal(resolveSpeedLimit({ highway: 'residential', maxspeed: '30' }, 'forward', 'DE').implicit, false);
  assert.equal(resolveSpeedLimit({ highway: 'residential' }, 'forward', 'DE').implicit, true);
});
