// Детектор моргания: чистая логика без DOM, камеры и звука.
// На вход — «степень закрытости» глаз 0…1 по кадрам, на выход — события.

export const DEFAULTS = Object.freeze({
  closeThreshold: 0.5,  // выше — глаз считается закрытым
  hysteresis: 0.15,     // открытым глаз снова считается ниже closeThreshold − hysteresis
  refractoryMs: 150,    // минимальный интервал между двумя срабатываниями
  maxBlinkMs: 800,      // дольше — это уже «закрыл глаза», а не моргание
});

// Счёт закрытости из blendshapes MediaPipe (eyeBlinkLeft / eyeBlinkRight).
// mode: 'both' — нужны оба глаза (обычное моргание), 'any' — достаточно одного (подмигивание).
export function blinkScore(categories, mode = 'both') {
  let left = 0;
  let right = 0;
  for (const c of categories || []) {
    if (c.categoryName === 'eyeBlinkLeft') left = c.score;
    else if (c.categoryName === 'eyeBlinkRight') right = c.score;
  }
  return mode === 'any' ? Math.max(left, right) : Math.min(left, right);
}

export class BlinkDetector {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.closed = false;
    this.closedAt = 0;
    this.lastTriggerAt = -Infinity;
    this.count = 0;
  }

  setOptions(options) {
    Object.assign(this.options, options);
  }

  // Возвращает 'close' в момент закрытия глаз (сюда вешается звук),
  // 'blink' / 'long' при открытии, иначе null.
  update(score, now) {
    const { closeThreshold, hysteresis, refractoryMs, maxBlinkMs } = this.options;
    const openThreshold = Math.max(0, closeThreshold - hysteresis);

    if (!this.closed) {
      if (score >= closeThreshold && now - this.lastTriggerAt >= refractoryMs) {
        this.closed = true;
        this.closedAt = now;
        this.lastTriggerAt = now;
        return 'close';
      }
      return null;
    }

    if (score <= openThreshold) {
      this.closed = false;
      if (now - this.closedAt > maxBlinkMs) return 'long';
      this.count += 1;
      return 'blink';
    }
    return null;
  }

  // Лицо пропало из кадра — состояние «закрыто» сбрасывается без события.
  lost() {
    this.closed = false;
  }
}
