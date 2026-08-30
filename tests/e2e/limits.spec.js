// Кэширование, лимиты запросов и поведение при сбоях сети (ТЗ 3.6, 4).

import { test, expect, LANES } from '../fixtures/harness.js';

test.describe('Запросы к Overpass', () => {
  test('запрос уходит на настроенный URL и содержит фильтр по highway', async ({ screen }) => {
    await screen.open();
    await screen.start();
    await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 13.9, heading: 90 });

    const log = await screen.fetchLog();
    expect(log.length).toBe(1);

    const body = decodeURIComponent(String(log[0].body).replace(/^data=/, '').replace(/\+/g, ' '));
    expect(body).toContain('[out:json][timeout:10]');
    expect(body).toContain('way(around:60,');
    expect(body).toContain('motorway|motorway_link|trunk');
    expect(body).toContain('out tags geom;');
    expect(log[0].url).toBe('https://overpass-api.de/api/interpreter');
  });

  test('стояние на месте не порождает новых запросов', async ({ screen }) => {
    await screen.open({ clock: true });
    await screen.start();

    for (let i = 0; i < 30; i += 1) {
      await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 0, heading: null });
      await screen.tick(1000);
    }
    // 30 с стоянки: смещения нет, порог возраста в 120 с не достигнут.
    expect(await screen.fetchCount()).toBe(1);
  });

  test('через 120 с данные обновляются даже без движения', async ({ screen }) => {
    await screen.open({ clock: true });
    await screen.start();

    await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 0, heading: null });
    expect(await screen.fetchCount()).toBe(1);

    await screen.tick(125000);
    await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 0, heading: null });
    expect(await screen.fetchCount()).toBe(2);
  });

  test('смещение менее 150 м нового запроса не вызывает', async ({ screen }) => {
    await screen.open({ clock: true });
    await screen.start();

    await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 5, heading: 90 });
    expect(await screen.fetchCount()).toBe(1);

    // ~100 м на восток, с запасом по времени, чтобы упирались именно в расстояние.
    await screen.tick(30000);
    await screen.fix({ lat: LANES.primary, lon: 8.6814, speed: 5, heading: 90 });
    expect(await screen.fetchCount()).toBe(1);

    // А вот 200 м на восток — уже за порогом.
    await screen.tick(30000);
    await screen.fix({ lat: LANES.primary, lon: 8.6828, speed: 5, heading: 90 });
    expect(await screen.fetchCount()).toBe(2);
  });

  test('кэш продолжает работать, пока новый ответ не пришёл', async ({ screen }) => {
    await screen.open({ clock: true });
    await screen.start();

    await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 13.9, heading: 90 });
    expect((await screen.read()).signText).toBe('50');

    // Сеть пропала — но дороги уже в кэше, подбор сегмента идёт локально.
    await screen.setNetwork('offline');
    for (let i = 1; i <= 30; i += 1) {
      await screen.fix({ lat: LANES.primary, lon: 8.6800 + i * 0.0004, speed: 13.9, heading: 90 });
      await screen.tick(1000);
    }

    const state = await screen.read();
    expect(await screen.fetchCount(), 'запрос был и не удался').toBeGreaterThan(1);
    expect(state.offline).toBe(true);
    // Главное: ограничение продолжает показываться из кэша.
    expect(state.signText).toBe('50');
  });
});

test.describe('Ошибки сети', () => {
  test('тайм-аут запроса обрывается и помечается отдельно', async ({ screen }) => {
    await screen.open({ clock: true, network: 'timeout' });
    await screen.start();

    await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 13.9, heading: 90 });
    // Ответа нет; приложение само обрывает запрос по AbortController.
    await screen.tick(13000);

    const state = await screen.read();
    expect(state.offline).toBe(true);
    expect(state.status).toContain('не отвечает');
  });

  test('после ошибки повтор идёт с экспоненциальной задержкой', async ({ screen }) => {
    await screen.open({ clock: true, network: 'offline' });
    await screen.start();

    // Первый запрос — сразу, он падает.
    await screen.fix({ lat: LANES.primary, lon: 8.6000, speed: 36, heading: 90 });
    expect(await screen.fetchCount()).toBe(1);

    // Пауза 5 с ещё не истекла — повтора нет, хотя мы уехали далеко.
    await screen.tick(3000);
    await screen.fix({ lat: LANES.primary, lon: 8.6100, speed: 36, heading: 90 });
    expect(await screen.fetchCount()).toBe(1);

    // После бэкоффа — повтор.
    await screen.tick(9000);
    await screen.fix({ lat: LANES.primary, lon: 8.6200, speed: 36, heading: 90 });
    expect(await screen.fetchCount()).toBe(2);
  });

  test('связь восстановилась — данные и знак возвращаются', async ({ screen }) => {
    await screen.open({ clock: true, network: 'offline' });
    await screen.start();

    await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 13.9, heading: 90 });
    expect((await screen.read()).offline).toBe(true);

    await screen.setNetwork('online');
    await screen.tick(20000);
    await screen.fix({ lat: LANES.primary, lon: 8.6830, speed: 13.9, heading: 90 });

    const state = await screen.read();
    expect(state.offline).toBe(false);
    expect(state.signText).toBe('50');
  });
});

test.describe('Фон и энергосбережение', () => {
  test('в фоне запросы к Overpass приостанавливаются', async ({ screen }) => {
    await screen.open({ clock: true });
    await screen.start();

    await screen.fix({ lat: LANES.primary, lon: 8.6000, speed: 36, heading: 90 });
    const before = await screen.fetchCount();

    // Уходим в фон.
    await screen.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    for (let i = 1; i <= 20; i += 1) {
      await screen.fix({ lat: LANES.primary, lon: 8.6000 + i * 0.005, speed: 36, heading: 90 });
      await screen.tick(1000);
    }
    expect(await screen.fetchCount()).toBe(before);

    // Возвращаемся — запросы возобновляются.
    await screen.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await screen.fix({ lat: LANES.primary, lon: 8.6600, speed: 36, heading: 90 });
    expect(await screen.fetchCount()).toBeGreaterThan(before);
  });

  test('отсутствие Wake Lock API не ломает запуск', async ({ screen }) => {
    await screen.open();
    await screen.page.evaluate(() => {
      delete navigator.wakeLock;
    });
    await screen.start();
    await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 13.9, heading: 90 });
    expect((await screen.read()).signText).toBe('50');
  });
});

test.describe('Приватность', () => {
  test('координаты уходят только в Overpass, localStorage не используется', async ({ screen }) => {
    await screen.open();
    await screen.start();
    await screen.drive({ from: { lat: LANES.primary, lon: 8.6800 }, seconds: 6 });

    // Фикстура отклоняет любой запрос не на interpreter, и такой отказ всплыл бы
    // в списке ошибок страницы; дополнительно убеждаемся, что счётчик совпадает.
    const log = await screen.fetchLog();
    expect(log.length).toBe(await screen.fetchCount());

    const stored = await screen.page.evaluate(() => ({
      local: Object.keys(localStorage).length,
      session: Object.keys(sessionStorage).length,
    }));
    expect(stored).toEqual({ local: 0, session: 0 });
  });
});
