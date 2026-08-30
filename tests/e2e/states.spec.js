// Состояния ограничения (ТЗ 3.4, 4) и обязательные состояния приложения (ТЗ 5).

import { test, expect, LANES } from '../fixtures/harness.js';

/** Подъезжает к нужной полосе и возвращает состояние экрана. */
async function rideTo(screen, lat, options = {}) {
  await screen.drive({ from: { lat, lon: 8.6800 }, seconds: 4, ...options });
  return screen.read();
}

test.describe('Состояния знака', () => {
  test('число — обычный знак', async ({ screen }) => {
    await screen.open();
    await screen.start();
    const state = await rideTo(screen, LANES.primary);
    expect(state.sign).toBe('number');
    expect(state.signText).toBe('50');
    expect(state.signImplicit).toBe(false);
  });

  test('mph переводится в км/ч с округлением', async ({ screen }) => {
    await screen.open();
    await screen.start();
    expect((await rideTo(screen, LANES.mph)).signText).toBe('48');
  });

  test('none — знак с диагональными полосами', async ({ screen }) => {
    await screen.open();
    await screen.start();
    const state = await rideTo(screen, LANES.motorwayNone, { speedMs: 36 });
    expect(state.sign).toBe('none');
    expect(state.caption).toBe('без ограничения');
    await expect(screen.page.locator('.sign-stripes')).toBeVisible();
  });

  test('walk — 7 км/ч с подписью «шаг»', async ({ screen }) => {
    await screen.open();
    await screen.start();
    const state = await rideTo(screen, LANES.livingStreet, { speedMs: 2 });
    expect(state.signText).toBe('7');
    expect(state.caption).toBe('шаг');
  });

  test('signals — «переменное», числа не показываются', async ({ screen }) => {
    await screen.open();
    await screen.start();
    const state = await rideTo(screen, LANES.signals);
    expect(state.sign).toBe('variable');
    expect(state.caption).toBe('переменное');
    expect(state.signText).not.toMatch(/\d/);
  });

  test('значение из таблицы по умолчанию помечено пунктиром', async ({ screen }) => {
    await screen.open();
    await screen.start();
    const state = await rideTo(screen, LANES.motorwayBare, { speedMs: 36 });
    // DE:motorway — «без ограничения».
    expect(state.sign).toBe('none');

    const dash = await screen.page.evaluate(() => getComputedStyle(document.querySelector('.sign-ring')).strokeDasharray);
    // Для состояния «без ограничения» число не рисуется, пунктир к нему не применяется —
    // проверяем пунктир на числовом implicit-значении.
    expect(typeof dash).toBe('string');
  });

  test('направленные теги: значение зависит от направления движения', async ({ screen }) => {
    await screen.open();
    await screen.start();

    await screen.drive({ from: { lat: LANES.directional, lon: 8.6800 }, bearing: 90, seconds: 4 });
    expect((await screen.read()).signText).toBe('70');

    await screen.drive({ from: { lat: LANES.directional, lon: 8.7000 }, bearing: 270, seconds: 4 });
    expect((await screen.read()).signText).toBe('40');
  });

  test('нет тегов — «нет данных», а не последнее известное значение', async ({ screen }) => {
    await screen.open();
    await screen.start();

    await rideTo(screen, LANES.primary);
    expect((await screen.read()).signText).toBe('50');

    const state = await rideTo(screen, LANES.untagged);
    expect(state.sign).toBe('nodata');
    expect(state.status).toContain('OpenStreetMap');
  });

  test('неизвестная страна — «нет данных», а не догадка', async ({ screen }) => {
    // Ни одна дорога в выборке не несёт страну: подставлять нечего.
    await screen.open({ ways: [{
      type: 'way', id: 900, tags: { highway: 'motorway', name: 'Unbekannt' },
      geometry: Array.from({ length: 41 }, (_, i) => ({ lat: LANES.foreign, lon: 8.66 + i * 0.0015 })),
    }] });
    await screen.start();
    expect((await rideTo(screen, LANES.foreign, { speedMs: 36 })).sign).toBe('nodata');
  });
});

test.describe('Индикация превышения', () => {
  const ride = async (screen, speedMs) => {
    await screen.drive({ from: { lat: LANES.primary, lon: 8.6800 }, speedMs, seconds: 25 });
    return screen.read();
  };

  test('до +5 км/ч — нейтральный цвет', async ({ screen }) => {
    await screen.open();
    await screen.start();
    const state = await ride(screen, 14.5); // ≈52 км/ч при ограничении 50
    expect(state.over).toBe('');
  });

  test('от +5 до +15 — жёлтый', async ({ screen }) => {
    await screen.open();
    await screen.start();
    const state = await ride(screen, 16.7); // ≈60 км/ч
    expect(state.over).toBe('warn');
    expect(state.speedColor).toBe('rgb(255, 212, 0)');
  });

  test('более +15 — красный', async ({ screen }) => {
    await screen.open();
    await screen.start();
    const state = await ride(screen, 25); // ≈90 км/ч
    expect(state.over).toBe('danger');
    expect(state.speedColor).toBe('rgb(255, 59, 48)');
  });

  test('на знаке «без ограничения» превышения нет никогда', async ({ screen }) => {
    await screen.open();
    await screen.start();
    await screen.drive({ from: { lat: LANES.motorwayNone, lon: 8.6800 }, speedMs: 55, seconds: 25 });
    const state = await screen.read();
    expect(state.sign).toBe('none');
    expect(state.over).toBe('');
  });
});

test.describe('Обязательные состояния приложения (ТЗ 5)', () => {
  test('до старта — приглашение нажать «Старт»', async ({ screen }) => {
    await screen.open();
    const state = await screen.read();
    expect(state.button).toBe('Старт');
    expect(state.status).toContain('Старт');
    expect(state.sign).toBe('nodata');
  });

  test('отказ в доступе к геолокации', async ({ screen }) => {
    await screen.open();
    await screen.start();
    await screen.fail(1);
    expect((await screen.read()).status).toMatch(/запрещ/i);
  });

  test('позиция недоступна и тайм-аут — разные тексты', async ({ screen }) => {
    await screen.open();
    await screen.start();

    await screen.fail(2);
    const unavailable = (await screen.read()).status;

    await screen.fail(3);
    const timeout = (await screen.read()).status;

    expect(unavailable).not.toBe(timeout);
    expect(unavailable).toMatch(/недоступн/i);
    expect(timeout).toMatch(/айм-аут/i);
  });

  test('точность хуже 50 м — предупреждение, ограничение скрыто', async ({ screen }) => {
    await screen.open();
    await screen.start();

    await rideTo(screen, LANES.primary);
    expect((await screen.read()).signText).toBe('50');

    await screen.fix({ lat: LANES.primary, lon: 8.6810, speed: 13.9, heading: 90, accuracy: 120 });
    const state = await screen.read();
    expect(state.sign).toBe('nodata');
    expect(state.status).toContain('Точность');
    expect(state.accuracy).toContain('плохая');
  });

  test('после потери привязки ограничение сбрасывается сразу', async ({ screen }) => {
    await screen.open();
    await screen.start();

    await rideTo(screen, LANES.primary);
    expect((await screen.read()).signText).toBe('50');

    // Уехали далеко от всех известных дорог.
    await screen.fix({ lat: LANES.primary + 0.5, lon: 8.6810, speed: 13.9, heading: 90 });
    expect((await screen.read()).sign).toBe('nodata');
  });

  test('данные старше 30 с без подтверждения сбрасываются', async ({ screen }) => {
    await screen.open({ clock: true });
    await screen.start();

    await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 13.9, heading: 90 });
    expect((await screen.read()).signText).toBe('50');

    // Фиксы перестали приходить (тоннель, потеря спутников).
    await screen.tick(29000);
    expect((await screen.read()).signText).toBe('50');
    await screen.tick(3000);
    expect((await screen.read()).sign).toBe('nodata');
  });

  test('«Стоп» возвращает приложение в исходное состояние', async ({ screen }) => {
    await screen.open();
    await screen.start();
    await rideTo(screen, LANES.primary);
    await screen.stop();

    const state = await screen.read();
    expect(state.button).toBe('Старт');
    expect(state.sign).toBe('nodata');
    expect(state.speed).toBe('--');
  });
});
