// maxspeed.js — разбор тега maxspeed и таблица implicit-ограничений.
//
// Модуль ничего не знает про геометрию и сеть: на вход — теги выбранного way,
// направление движения по нему и последняя известная страна, на выход —
// нормализованное состояние ограничения.

/** Коэффициент перевода миль в час в километры в час. */
export const MPH_TO_KMH = 1.609344;

/** Скорость пешехода, которой соответствует значение `walk`. */
export const WALK_KMH = 7;

/**
 * Таблица implicit-ограничений по странам (ТЗ 3.5).
 * Структура плоская и легко расширяется: код страны -> категория -> значение.
 * Значение: число (км/ч), 'none' (без ограничения) или 'walk' (шаг).
 */
export const IMPLICIT_LIMITS = {
  DE: { urban: 50, rural: 100, motorway: 'none', living_street: 'walk', bicycle_road: 30 },
  AT: { urban: 50, rural: 100, motorway: 130, living_street: 'walk' },
  FR: { urban: 50, rural: 80, motorway: 130 },
  PL: { urban: 50, rural: 90, motorway: 140 },
  RU: { urban: 60, rural: 90, motorway: 110, living_street: 20 },
};

/** Состояние «нет данных» — единственный разрешённый ответ при неопределённости. */
export const UNKNOWN = Object.freeze({ kind: 'unknown', kmh: null, label: null, source: null, implicit: false });

function make(kind, kmh, label, source, implicit) {
  return Object.freeze({ kind, kmh, label: label || null, source, implicit: Boolean(implicit) });
}

/**
 * Разбирает одно значение тега maxspeed / zone:maxspeed.
 * Возвращает объект состояния либо null, если значение не распознано.
 */
export function parseMaxspeedValue(raw, source = 'maxspeed') {
  if (raw == null) return null;
  // В OSM встречается перечисление через ';' (разные полосы/условия) — берём первое.
  const value = String(raw).split(';')[0].trim().toLowerCase();
  if (!value) return null;

  if (value === 'none' || value === 'unlimited') return make('none', null, null, source, false);
  if (value === 'walk' || value === 'walking' || value === 'schritt') {
    return make('walk', WALK_KMH, 'шаг', source, false);
  }
  if (value === 'signals' || value === 'variable') {
    return make('variable', null, 'переменное', source, false);
  }

  // Чистое число — по умолчанию км/ч.
  let m = /^(\d+(?:[.,]\d+)?)$/.exec(value);
  if (m) return numeric(Number(m[1].replace(',', '.')), source, false);

  // Явные единицы измерения.
  m = /^(\d+(?:[.,]\d+)?)\s*mph$/.exec(value);
  if (m) return numeric(Number(m[1].replace(',', '.')) * MPH_TO_KMH, source, false);

  m = /^(\d+(?:[.,]\d+)?)\s*(?:km\/h|kmh|kph|km\/ч)$/.exec(value);
  if (m) return numeric(Number(m[1].replace(',', '.')), source, false);

  m = /^(\d+(?:[.,]\d+)?)\s*knots?$/.exec(value);
  if (m) return numeric(Number(m[1].replace(',', '.')) * 1.852, source, false);

  // Префикс страны: DE:urban, AT:motorway, DE-BW:rural, DE:zone30, DE:zone:30 ...
  m = /^([a-z]{2})(?:-[a-z0-9]+)?:(.+)$/.exec(value);
  if (m) {
    const country = m[1].toUpperCase();
    const rest = m[2].trim();

    // Зоны вида zone30 / zone:30 / 30 — это просто число.
    const zone = /^zone[:\s]?(\d+)$/.exec(rest) || /^(\d+)$/.exec(rest);
    if (zone) return numeric(Number(zone[1]), source, true);

    const resolved = lookupImplicit(country, rest.replace(/[\s-]/g, '_'));
    if (resolved) return { ...resolved, source, implicit: true };
    return null;
  }

  return null;
}

function numeric(kmh, source, implicit) {
  if (!Number.isFinite(kmh) || kmh <= 0) return null;
  return make('number', Math.round(kmh), null, source, implicit);
}

/**
 * Достаёт значение из таблицы implicit-ограничений.
 * Возвращает состояние либо null, если страна или категория неизвестны.
 */
export function lookupImplicit(country, category) {
  if (!country || !category) return null;
  const table = IMPLICIT_LIMITS[String(country).toUpperCase()];
  if (!table) return null;
  const key = String(category).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(table, key)) return null;
  const value = table[key];
  if (value === 'none') return make('none', null, null, 'implicit', true);
  if (value === 'walk') return make('walk', WALK_KMH, 'шаг', 'implicit', true);
  if (typeof value === 'number') return make('number', value, null, 'implicit', true);
  return null;
}

/**
 * Страна по тегам way. Догадки по координатам намеренно не делаются (ТЗ 3.5):
 * либо явный тег, либо префикс в значении maxspeed/zone:maxspeed.
 */
export function countryFromTags(tags) {
  if (!tags) return null;
  const explicit = tags['addr:country'] || tags['is_in:country_code'] || tags['is_in:country'];
  if (explicit && /^[a-z]{2}$/i.test(String(explicit).trim())) {
    return String(explicit).trim().toUpperCase();
  }
  for (const key of ['maxspeed', 'maxspeed:forward', 'maxspeed:backward', 'zone:maxspeed', 'source:maxspeed']) {
    const raw = tags[key];
    if (!raw) continue;
    const m = /^\s*([a-z]{2})(?:-[a-z0-9]+)?:/i.exec(String(raw));
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/**
 * Категория implicit-ограничения по типу дороги.
 * Возвращается только для однозначных случаев: делить дороги на urban/rural
 * по координатам нельзя, поэтому для primary/secondary/tertiary и т.п.
 * ответа нет — это честное «нет данных».
 */
function implicitCategory(tags) {
  const highway = tags && tags.highway;
  if (highway === 'motorway' || highway === 'motorway_link') return 'motorway';
  if (highway === 'living_street') return 'living_street';
  if (highway === 'residential') return 'urban';
  if (tags && tags.bicycle_road === 'yes') return 'bicycle_road';
  return null;
}

/**
 * Итоговое ограничение для выбранного сегмента.
 *
 * @param {object} tags            теги way из Overpass
 * @param {'forward'|'backward'|'unknown'} direction направление движения по way
 * @param {string|null} fallbackCountry последняя известная страна
 * @returns {{kind:string,kmh:number|null,label:string|null,source:string|null,implicit:boolean,country:string|null}}
 */
export function resolveSpeedLimit(tags, direction = 'unknown', fallbackCountry = null) {
  const t = tags || {};
  const country = countryFromTags(t) || fallbackCountry || null;

  // 1. Основной тег.
  let result = parseMaxspeedValue(t.maxspeed, 'maxspeed');

  // 2. Направленные теги — в соответствии с выбранным направлением.
  if (!result) {
    const order = direction === 'backward'
      ? ['maxspeed:backward', 'maxspeed:forward']
      : ['maxspeed:forward', 'maxspeed:backward'];
    // Противоположный тег берём только если направление неизвестно.
    const keys = direction === 'unknown' ? order : [order[0]];
    for (const key of keys) {
      result = parseMaxspeedValue(t[key], key);
      if (result) break;
    }
  }

  // 3. Зональное ограничение.
  if (!result) result = parseMaxspeedValue(t['zone:maxspeed'], 'zone:maxspeed');

  // 4. Implicit-таблица — только при известной стране и однозначном типе дороги.
  if (!result && country) {
    const category = implicitCategory(t);
    if (category) result = lookupImplicit(country, category);
  }

  if (!result) return { ...UNKNOWN, country };
  return { ...result, country };
}
