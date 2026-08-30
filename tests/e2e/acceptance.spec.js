// Критерии приёмки из раздела 8 ТЗ.

import { test, expect, LANES, FRANKFURT } from '../fixtures/harness.js';

test.describe('Критерии приёмки', () => {
  test('8.1 — на подменённых координатах во Франкфурте определяется ограничение', async ({ screen }) => {
    await screen.open();
    await screen.start();

    // Chrome DevTools -> Sensors отдаёт координаты без speed и heading — именно так.
    await screen.fix({ lat: LANES.primary, lon: FRANKFURT.lon, speed: null, heading: null });

    const state = await screen.read();
    expect(state.sign).toBe('number');
    expect(state.signText).toBe('50');
    expect(state.road).toContain('Friedberger Landstraße');
  });

  test('8.2 — при переходе между дорогами ограничение меняется', async ({ screen }) => {
    await screen.open();
    await screen.start();

    await screen.drive({ from: { lat: LANES.primary, lon: 8.6800 }, seconds: 4 });
    expect((await screen.read()).signText).toBe('50');

    await screen.drive({ from: { lat: LANES.residential, lon: 8.6810 }, seconds: 5 });
    expect((await screen.read()).signText).toBe('30');
  });

  test('8.2 — на границе между дорогами знак не «мигает»', async ({ screen }) => {
    await screen.open();
    await screen.start();

    // Едем ровно между двумя одноклассовыми улицами (30 м друг от друга) и
    // «дрожим» на ±5.6 м: без гистерезиса ближайшая менялась бы на каждом фиксе.
    const middle = (LANES.twinA + LANES.twinB) / 2;
    const seen = [];
    for (let step = 0; step < 40; step += 1) {
      const jitter = (step % 2 === 0 ? 1 : -1) * 0.00005;
      await screen.fix({ lat: middle + jitter, lon: 8.6800 + step * 0.00002, speed: 13.9, heading: 90 });
      seen.push((await screen.read()).signText);
    }

    // Привязка должна состояться — иначе тест ничего не проверяет.
    expect(new Set(seen).size).toBeLessThanOrEqual(1);
    expect(['30', '20']).toContain(seen[0]);

    const switches = seen.filter((value, index) => index > 0 && value !== seen[index - 1]).length;
    expect(switches, 'знак не должен переключаться на дрожании').toBe(0);
  });

  test('8.3 — при coords.speed === null скорость выглядит правдоподобно', async ({ screen }) => {
    await screen.open();
    await screen.start();

    // 13.9 м/с ≈ 50 км/ч, скорость от GPS не приходит вовсе.
    await screen.drive({ from: { lat: LANES.primary, lon: 8.6800 }, seconds: 12, gpsSpeed: false });

    const state = await screen.read();
    expect(Number(state.speed)).toBeGreaterThan(45);
    expect(Number(state.speed)).toBeLessThan(55);
    expect(state.source).toContain('расчёт');
  });

  test('8.4 — без сети скорость показывается, офлайн заявлен явно', async ({ screen }) => {
    await screen.open({ network: 'offline' });
    await screen.start();

    await screen.drive({ from: { lat: LANES.primary, lon: 8.6800 }, seconds: 5 });

    const state = await screen.read();
    expect(Number(state.speed)).toBeGreaterThan(0);
    expect(state.offline).toBe(true);
    expect(state.status).toContain('Overpass');
    // Ограничение при этом не выдумывается.
    expect(state.sign).toBe('nodata');
  });

  test('8.5 — за 10 минут движения не более 60 запросов к Overpass', async ({ screen }) => {
    test.slow();
    await screen.open({ clock: true });
    await screen.start();

    // 36 м/с — 130 км/ч, худший случай: 150 м проходятся за 4.2 с.
    await screen.drive({ from: { lat: LANES.primary, lon: 8.6000 }, speedMs: 36, seconds: 600 });

    expect(await screen.fetchCount()).toBeLessThanOrEqual(60);
    // И при этом запросы всё-таки идут — иначе данные были бы мертвы.
    expect(await screen.fetchCount()).toBeGreaterThan(20);
  });

  test('8.6 — ошибки не приводят к белому экрану', async ({ screen }) => {
    await screen.open({ network: 'offline' });
    await screen.start();

    // Подряд: отказ в геолокации, мусорный ответ Overpass, плохая точность.
    await screen.fail(1);
    await screen.setWays([{ type: 'way', id: 1 }, null, { type: 'node', id: 2 }]);
    await screen.setNetwork('online');
    await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 10, heading: 90, accuracy: 400 });
    await screen.fix({ lat: LANES.primary, lon: 8.6801, speed: 10, heading: 90 });

    const state = await screen.read();
    // Всегда есть читаемое состояние: экран тёмный, кнопка на месте, статус не пуст.
    await expect(screen.page.locator('#toggle')).toBeVisible();
    await expect(screen.page.locator('#speedValue')).toBeVisible();
    expect(state.sign).toBe('nodata');
    const background = await screen.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe('rgb(10, 10, 10)');
    // Проверка «ни одной ошибки на странице» выполняется фикстурой при завершении теста.
  });
});
