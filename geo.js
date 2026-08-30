// geo.js — работа с Geolocation API, расчёт и сглаживание скорости.

import { haversineMeters } from './matching.js';

/** Опции watchPosition из ТЗ 3.1. */
export const GEO_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  maximumAge: 1000,
  timeout: 10000,
});

/** Сколько последних фиксов держим в памяти (ТЗ 3.1). */
export const FIX_HISTORY = 5;
/** Коэффициент экспоненциального сглаживания (ТЗ 3.2.3). */
export const EMA_ALPHA = 0.3;
/** Ниже этого значения показываем ноль — подавление дрейфа на стоянке (ТЗ 3.2.4). */
export const ZERO_THRESHOLD_KMH = 3;
/** Порог точности, выше которого фиксы не годятся для фолбэка (ТЗ 3.2.2). */
export const FALLBACK_MAX_ACCURACY_M = 50;
/** Допустимый интервал между фиксами для фолбэка, мс. */
export const FALLBACK_MIN_DT_MS = 500;
export const FALLBACK_MAX_DT_MS = 5000;
/** Точность хуже этой считается непригодной для показа ограничения (ТЗ 5.3). */
export const POOR_ACCURACY_M = 50;

/**
 * Расчёт скорости: приоритет у coords.speed, фолбэк — по расстоянию между
 * двумя последними фиксами. Сглаживание — EMA.
 */
export class SpeedTracker {
  constructor(options = {}) {
    this.alpha = options.alpha ?? EMA_ALPHA;
    this.historySize = options.historySize ?? FIX_HISTORY;
    this.fixes = [];
    this.ema = null;
    this.source = null; // 'gps' | 'haversine'
  }

  reset() {
    this.fixes = [];
    this.ema = null;
    this.source = null;
  }

  get lastFix() {
    return this.fixes.length ? this.fixes[this.fixes.length - 1] : null;
  }

  /**
   * Добавляет фикс и пересчитывает скорость.
   * @returns {{speedKmh:number|null, source:string|null, updated:boolean}}
   */
  add(position) {
    const c = position.coords;
    const fix = {
      lat: c.latitude,
      lon: c.longitude,
      accuracy: Number.isFinite(c.accuracy) ? c.accuracy : Infinity,
      heading: Number.isFinite(c.heading) ? c.heading : null,
      rawSpeed: Number.isFinite(c.speed) ? c.speed : null,
      timestamp: position.timestamp || Date.now(),
    };

    const previous = this.lastFix;
    this.fixes.push(fix);
    if (this.fixes.length > this.historySize) this.fixes.shift();

    let raw = null;
    let source = null;

    if (fix.rawSpeed !== null && fix.rawSpeed >= 0) {
      raw = fix.rawSpeed * 3.6; // м/с -> км/ч
      source = 'gps';
    } else if (previous) {
      const dt = fix.timestamp - previous.timestamp;
      const accuracyOk = fix.accuracy < FALLBACK_MAX_ACCURACY_M && previous.accuracy < FALLBACK_MAX_ACCURACY_M;
      if (dt >= FALLBACK_MIN_DT_MS && dt <= FALLBACK_MAX_DT_MS && accuracyOk) {
        const meters = haversineMeters(previous, fix);
        raw = (meters / (dt / 1000)) * 3.6;
        source = 'haversine';
      }
    }

    // Условия фолбэка не выполнены — прежнее значение сохраняем,
    // показывать ноль в этом случае запрещено (ТЗ 3.2.2).
    if (raw === null || !Number.isFinite(raw)) {
      return { speedKmh: this.value, source: this.source, updated: false };
    }

    this.ema = this.ema === null ? raw : this.alpha * raw + (1 - this.alpha) * this.ema;
    this.source = source;
    return { speedKmh: this.value, source, updated: true };
  }

  /** Сглаженное значение с подавлением дрейфа; null — данных ещё нет. */
  get value() {
    if (this.ema === null) return null;
    return this.ema < ZERO_THRESHOLD_KMH ? 0 : this.ema;
  }

  /** Целое значение для отображения. */
  get display() {
    const v = this.value;
    return v === null ? null : Math.round(v);
  }
}

/**
 * Тонкая обёртка над watchPosition. Разрешение запрашивается только при
 * явном вызове start() — то есть по нажатию кнопки «Старт» (ТЗ 3.1).
 */
export class GeoWatcher {
  constructor(options = GEO_OPTIONS) {
    this.options = options;
    this.watchId = null;
  }

  get supported() {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  }

  get active() {
    return this.watchId !== null;
  }

  start(onPosition, onError) {
    if (!this.supported) {
      onError({ code: 0, message: 'unsupported' });
      return false;
    }
    if (this.active) return true;
    this.watchId = navigator.geolocation.watchPosition(onPosition, onError, this.options);
    return true;
  }

  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
}

/** Человекочитаемый текст ошибки геолокации (ТЗ 5.2 — тексты различаются). */
export function geoErrorText(error) {
  switch (error && error.code) {
    case 1:
      return 'Доступ к геолокации запрещён. Разрешите его в настройках браузера и нажмите «Старт».';
    case 2:
      return 'Позиция недоступна: нет сигнала GPS. Ожидание спутников…';
    case 3:
      return 'Тайм-аут получения позиции. Пробуем ещё раз…';
    default:
      return 'Геолокация недоступна в этом браузере.';
  }
}
