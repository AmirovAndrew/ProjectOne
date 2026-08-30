// matching.js — геометрия и упрощённый map matching: выбор сегмента дороги,
// фильтр по направлению движения, ранжирование кандидатов и гистерезис.

/** Средний радиус Земли, м. */
const EARTH_R = 6371008.8;

const DEG = Math.PI / 180;

/** Максимальное расстояние до отрезка, при котором дорога считается кандидатом (ТЗ 3.3.2). */
export const MAX_SNAP_DISTANCE_M = 40;
/** Допуск по направлению, градусы (ТЗ 3.3.3). */
export const HEADING_TOLERANCE_DEG = 50;
/** Скорость, ниже которой heading недостоверен и фильтр по направлению не применяется. */
export const HEADING_MIN_SPEED_KMH = 10;
/** Разница расстояний, внутри которой приоритет отдаётся классу дороги (ТЗ 3.3.4). */
export const CLASS_PRIORITY_WINDOW_M = 10;
/** Запас гистерезиса: насколько прежний выбор может быть хуже лучшего (ТЗ 3.3.5). */
export const HYSTERESIS_MARGIN_M = 15;

/** Ранг класса дороги: чем больше, тем «главнее» дорога. */
const ROAD_CLASS_RANK = {
  motorway: 12,
  motorway_link: 11,
  trunk: 10,
  trunk_link: 9,
  primary: 8,
  primary_link: 7,
  secondary: 6,
  secondary_link: 5,
  tertiary: 4,
  tertiary_link: 3,
  unclassified: 2,
  residential: 1,
  living_street: 0,
};

export function roadClassRank(tags) {
  const rank = ROAD_CLASS_RANK[(tags && tags.highway) || ''];
  return rank === undefined ? -1 : rank;
}

/**
 * Расстояние между двумя точками по формуле гаверсинуса.
 * a = sin²(Δφ/2) + cos φ1 · cos φ2 · sin²(Δλ/2); d = 2R · atan2(√a, √(1−a)).
 * Формула устойчива к малым расстояниям (в отличие от «сферического косинуса»).
 */
export function haversineMeters(a, b) {
  const phi1 = a.lat * DEG;
  const phi2 = b.lat * DEG;
  const dPhi = (b.lat - a.lat) * DEG;
  const dLambda = (b.lon - a.lon) * DEG;
  const s = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Начальный азимут (истинный пеленг) отрезка a→b в градусах [0, 360).
 * θ = atan2(sin Δλ · cos φ2, cos φ1 · sin φ2 − sin φ1 · cos φ2 · cos Δλ)
 */
export function bearingDeg(a, b) {
  const phi1 = a.lat * DEG;
  const phi2 = b.lat * DEG;
  const dLambda = (b.lon - a.lon) * DEG;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Модуль разности двух азимутов, приведённый к диапазону [0, 180]. */
export function angleDiffDeg(a, b) {
  return Math.abs(((a - b) % 360 + 540) % 360 - 180);
}

/**
 * Проекция точки p на отрезок a—b.
 *
 * На расстояниях в десятки метров сферой можно пренебречь: переводим точки
 * в локальную плоскую систему (равнопромежуточная проекция с центром в p),
 * где по оси X — метры на восток с поправкой cos(φ), по Y — метры на север.
 * Дальше — обычная школьная проекция: t = (ap · ab) / |ab|², зажатая в [0, 1].
 */
export function projectPointOnSegment(p, a, b) {
  const lat0 = p.lat * DEG;
  const kx = EARTH_R * DEG * Math.cos(lat0); // метров в градусе долготы
  const ky = EARTH_R * DEG;                  // метров в градусе широты

  const ax = (a.lon - p.lon) * kx;
  const ay = (a.lat - p.lat) * ky;
  const bx = (b.lon - p.lon) * kx;
  const by = (b.lat - p.lat) * ky;

  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;

  // Вырожденный отрезок (две одинаковые точки) — расстояние до самой точки.
  if (len2 === 0) return { distance: Math.hypot(ax, ay), t: 0 };

  let t = -(ax * abx + ay * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  const px = ax + abx * t;
  const py = ay + aby * t;
  return { distance: Math.hypot(px, py), t };
}

/** Ближайший к точке отрезок геометрии way. */
function nearestSegment(point, geometry) {
  let best = null;
  for (let i = 0; i < geometry.length - 1; i += 1) {
    const a = geometry[i];
    const b = geometry[i + 1];
    const { distance, t } = projectPointOnSegment(point, a, b);
    if (!best || distance < best.distance) {
      best = { distance, t, index: i, a, b };
    }
  }
  return best;
}

function onewayKind(tags) {
  const v = String((tags && tags.oneway) || '').trim().toLowerCase();
  if (v === 'yes' || v === 'true' || v === '1') return 'forward';
  if (v === '-1' || v === 'reverse') return 'backward';
  // Автомагистрали по умолчанию односторонние даже без явного тега.
  if (tags && (tags.highway === 'motorway' || tags.highway === 'motorway_link')) return 'forward';
  if (tags && tags.junction === 'roundabout') return 'forward';
  return null;
}

/**
 * Подбор сегмента дороги с гистерезисом.
 * Состояние (предыдущий выбор) хранится внутри — это принципиально для
 * подавления «мигания» ограничения на развязках и перекрёстках.
 */
export class SegmentMatcher {
  constructor(options = {}) {
    this.maxDistance = options.maxDistance ?? MAX_SNAP_DISTANCE_M;
    this.tolerance = options.tolerance ?? HEADING_TOLERANCE_DEG;
    this.hysteresis = options.hysteresis ?? HYSTERESIS_MARGIN_M;
    this.previousId = null;
  }

  reset() {
    this.previousId = null;
  }

  /**
   * @param {{lat:number,lon:number}} point текущая позиция
   * @param {Array} ways массив way из Overpass ({id, tags, geometry})
   * @param {{heading:number|null, speedKmh:number|null}} motion
   * @returns {null|{way:object, id:number, distance:number, direction:'forward'|'backward'|'unknown', bearing:number}}
   */
  match(point, ways, motion = {}) {
    if (!point || !Array.isArray(ways) || ways.length === 0) {
      this.previousId = null;
      return null;
    }

    const heading = Number.isFinite(motion.heading) ? motion.heading : null;
    const speedKmh = Number.isFinite(motion.speedKmh) ? motion.speedKmh : 0;
    // heading от GPS достоверен только в движении (ТЗ 3.3.3).
    const useHeading = heading !== null && speedKmh >= HEADING_MIN_SPEED_KMH;

    const candidates = [];
    for (const way of ways) {
      const geometry = way && way.geometry;
      if (!Array.isArray(geometry) || geometry.length < 2) continue;

      const seg = nearestSegment(point, geometry);
      if (!seg || seg.distance > this.maxDistance) continue;

      const bearing = bearingDeg(seg.a, seg.b);
      const diffForward = angleDiffDeg(heading ?? bearing, bearing);
      const diffBackward = 180 - diffForward;
      const oneway = onewayKind(way.tags);

      let direction = 'unknown';
      if (useHeading) {
        if (oneway === 'forward') {
          if (diffForward > this.tolerance) continue;
          direction = 'forward';
        } else if (oneway === 'backward') {
          if (diffBackward > this.tolerance) continue;
          direction = 'backward';
        } else {
          if (Math.min(diffForward, diffBackward) > this.tolerance) continue;
          direction = diffForward <= diffBackward ? 'forward' : 'backward';
        }
      } else if (oneway === 'forward') {
        direction = 'forward';
      } else if (oneway === 'backward') {
        direction = 'backward';
      }

      candidates.push({
        way,
        id: way.id,
        distance: seg.distance,
        bearing,
        direction,
        rank: roadClassRank(way.tags),
      });
    }

    if (candidates.length === 0) {
      this.previousId = null;
      return null;
    }

    // Ранжирование: сначала по расстоянию проекции; если разница меньше 10 м —
    // приоритет более высокому классу дороги (ТЗ 3.3.4).
    candidates.sort((x, y) => x.distance - y.distance);
    const nearest = candidates[0];
    let best = nearest;
    for (const c of candidates) {
      if (c.distance - nearest.distance >= CLASS_PRIORITY_WINDOW_M) break;
      if (c.rank > best.rank) best = c;
    }

    // Гистерезис: прежний выбор сохраняется, пока он не хуже лучшего на 15 м.
    if (this.previousId !== null) {
      const previous = candidates.find((c) => c.id === this.previousId);
      if (previous && previous.distance <= best.distance + this.hysteresis) {
        best = previous;
      }
    }

    this.previousId = best.id;
    return best;
  }
}
