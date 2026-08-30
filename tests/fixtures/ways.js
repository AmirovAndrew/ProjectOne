// ways.js — синтетический слепок ответа Overpass.
//
// Дороги расположены полосами по широте вокруг Франкфурта-на-Майне и тянутся
// с запада на восток, так что «поездка» с heading = 90° идёт вдоль дороги.
// Каждая полоса проверяет свой случай из ТЗ 3.4/3.5.

/** Опорная точка: Франкфурт-на-Майне. */
export const FRANKFURT = { lat: 50.1109, lon: 8.6821 };

/** Прямой отрезок по широте `lat` от `lon0` до `lon1`. */
export function line(lat, lon0 = 8.6600, lon1 = 8.7200, points = 40) {
  const geometry = [];
  for (let i = 0; i <= points; i += 1) {
    geometry.push({ lat, lon: lon0 + ((lon1 - lon0) * i) / points });
  }
  return geometry;
}

/** Широта полосы с указанным сдвигом от опорной точки. */
export const at = (offset) => FRANKFURT.lat + offset;

export const LANES = {
  primary: at(0),            // maxspeed=50
  residential: at(-0.0008),  // maxspeed=30, в 89 м южнее primary
  motorwayNone: at(0.0100),  // maxspeed=none
  motorwayBare: at(0.0200),  // без тега, implicit DE:motorway
  livingStreet: at(0.0300),  // maxspeed=DE:living_street -> шаг
  mph: at(0.0400),           // maxspeed=30 mph -> 48
  signals: at(0.0500),       // maxspeed=signals -> переменное
  untagged: at(0.0600),      // тегов нет -> нет данных
  directional: at(0.0700),   // maxspeed:forward / maxspeed:backward
  oneway: at(0.0750),        // oneway=yes, встречное направление отбрасывается
  twinA: at(0.0800),         // пара одноклассовых улиц в 30 м друг от друга
  twinB: at(0.0800 - 0.00027),
  classNear: at(0.0900),         // трасса и мелкая улица в пределах 10 м
  classFar: at(0.0900 - 0.00007),
  foreign: at(0.1000),       // страна неизвестна -> нет данных
};

export const WAYS = [
  w(101, LANES.primary, { highway: 'primary', name: 'Friedberger Landstraße', maxspeed: '50', 'addr:country': 'DE' }),
  w(102, LANES.residential, { highway: 'residential', name: 'Wohnstraße', maxspeed: '30' }),
  w(103, LANES.motorwayNone, { highway: 'motorway', name: 'A661', maxspeed: 'none', oneway: 'yes' }),
  w(104, LANES.motorwayBare, { highway: 'motorway', name: 'A5', oneway: 'yes', 'addr:country': 'DE' }),
  w(105, LANES.livingStreet, { highway: 'living_street', name: 'Spielstraße', maxspeed: 'DE:living_street' }),
  w(106, LANES.mph, { highway: 'trunk', name: 'B3', maxspeed: '30 mph' }),
  w(107, LANES.signals, { highway: 'tertiary', name: 'Baustelle', maxspeed: 'signals' }),
  w(108, LANES.untagged, { highway: 'tertiary', name: 'Ohne Tags' }),
  w(109, LANES.directional, { highway: 'secondary', name: 'Zweirichtung', 'maxspeed:forward': '70', 'maxspeed:backward': '40' }),
  w(110, LANES.oneway, { highway: 'primary', name: 'Einbahn', maxspeed: '60', oneway: 'yes' }),
  w(201, LANES.twinA, { highway: 'residential', name: 'Links', maxspeed: '30' }),
  w(202, LANES.twinB, { highway: 'residential', name: 'Rechts', maxspeed: '20' }),
  w(301, LANES.classNear, { highway: 'trunk', name: 'Hauptstraße', maxspeed: '80' }),
  w(302, LANES.classFar, { highway: 'residential', name: 'Nebenstraße', maxspeed: '30' }),
  w(401, LANES.foreign, { highway: 'motorway', name: 'Unbekanntes Land' }),
];

function w(id, lat, tags) {
  return { type: 'way', id, tags, geometry: line(lat) };
}
