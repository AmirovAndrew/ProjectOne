// Читаемость экрана (ТЗ 4). Прогоняется в обоих проектах: экран машины и телефон.

import { test, expect, LANES } from '../fixtures/harness.js';

test.describe('Читаемость', () => {
  test.beforeEach(async ({ screen }) => {
    await screen.open();
    await screen.start();
    await screen.fix({ lat: LANES.primary, lon: 8.6800, speed: 36, heading: 90 });
  });

  test('фон тёмный', async ({ screen }) => {
    const background = await screen.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe('rgb(10, 10, 10)');
  });

  test('скорость — не менее 180 px моноширинными цифрами', async ({ screen }) => {
    const style = await screen.page.evaluate(() => {
      const element = document.getElementById('speedValue');
      const computed = getComputedStyle(element);
      return {
        fontSize: parseFloat(computed.fontSize),
        numeric: computed.fontVariantNumeric,
      };
    });
    expect(style.fontSize).toBeGreaterThanOrEqual(180);
    expect(style.numeric).toContain('tabular-nums');
  });

  test('ширина числа не меняется при смене разрядов', async ({ screen }) => {
    const widthOf = (text) => screen.page.evaluate((value) => {
      const element = document.getElementById('speedValue');
      element.textContent = value;
      return element.getBoundingClientRect().width;
    }, text);

    // Одинаковое число знаков должно давать одинаковую ширину — иначе цифры «прыгают».
    expect(await widthOf('111')).toBeCloseTo(await widthOf('888'), 1);
    expect(await widthOf('11')).toBeCloseTo(await widthOf('00'), 1);
  });

  test('знак ограничения — круг не менее 200 px', async ({ screen }) => {
    const box = await screen.page.locator('#sign').boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(200);
    expect(box.height).toBeGreaterThanOrEqual(200);
    expect(box.width).toBeCloseTo(box.height, 0);
  });

  test('знак: белый круг, красная окантовка, чёрная цифра', async ({ screen }) => {
    const colors = await screen.page.evaluate(() => ({
      face: getComputedStyle(document.querySelector('.sign-face')).fill,
      ring: getComputedStyle(document.querySelector('.sign-ring')).stroke,
      text: getComputedStyle(document.querySelector('.sign-text')).fill,
    }));
    expect(colors.face).toBe('rgb(255, 255, 255)');
    expect(colors.ring).toBe('rgb(212, 0, 0)');
    expect(colors.text).toBe('rgb(0, 0, 0)');
  });

  test('число любой разрядности умещается в белый круг', async ({ screen }) => {
    // Внутренний белый круг: r = 42 − 14/2 = 35, то есть диаметр 70 единиц viewBox.
    const widthOf = (digits, value) => screen.page.evaluate(([d, v]) => {
      document.getElementById('sign').dataset.digits = d;
      document.getElementById('signText').textContent = v;
      return document.getElementById('signText').getBBox().width;
    }, [digits, value]);

    for (const [digits, value] of [['1', '7'], ['2', '50'], ['3', '130']]) {
      expect(await widthOf(digits, value), `значение ${value}`).toBeLessThanOrEqual(62);
    }
    // Двух- и трёхзначные значения должны выглядеть одинаково крупно.
    expect(await widthOf('3', '130')).toBeCloseTo(await widthOf('2', '50'), 0);
  });

  test('дисклеймер виден постоянно', async ({ screen }) => {
    const disclaimer = screen.page.locator('.disclaimer');
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toContainText(/справочн/i);
    await expect(disclaimer).toContainText(/знак/i);
  });

  test('в подвале есть точность, время обновления и место под офлайн', async ({ screen }) => {
    await expect(screen.page.locator('#metaAccuracy')).toContainText('точность');
    await expect(screen.page.locator('#metaRoad')).toContainText('обновлено');
    await expect(screen.page.locator('#metaOffline')).toBeHidden();
  });

  test('кнопка после запуска уменьшается', async ({ screen }) => {
    const fontSize = () => screen.page.evaluate(
      () => parseFloat(getComputedStyle(document.getElementById('toggle')).fontSize),
    );

    // Размер меняется плавно; отключаем переход, чтобы мерить установившиеся значения.
    await screen.page.addStyleTag({ content: '* { transition: none !important; }' });

    const running = await fontSize();
    await screen.stop();
    const idle = await fontSize();

    expect(running, 'после запуска кнопка должна уменьшиться').toBeLessThan(idle);
  });

  test('страница не прокручивается по горизонтали', async ({ screen }) => {
    const overflow = await screen.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('нет мигающих элементов и звуков', async ({ screen }) => {
    const animated = await screen.page.evaluate(() => [...document.querySelectorAll('*')]
      .filter((element) => getComputedStyle(element).animationName !== 'none')
      .map((element) => element.id || String(element.className)));
    expect(animated, 'ключевых анимаций быть не должно').toEqual([]);

    const sound = await screen.page.evaluate(() => ({
      media: document.querySelectorAll('audio, video').length,
      audioContext: typeof window.__audioUsed === 'undefined' ? 0 : 1,
    }));
    expect(sound).toEqual({ media: 0, audioContext: 0 });
  });
});
