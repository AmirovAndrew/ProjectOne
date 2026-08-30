# Тестовый стенд

Стенд лежит отдельной папкой со своим `package.json`: у самого приложения
зависимостей нет и быть не должно, а devDependencies нужны только для запуска
тестов. Из корня репозитория деплоится ровно то, что описано в ТЗ 7 — эта папка
на работу приложения не влияет.

## Запуск

```bash
cd tests
npm ci                      # ставит @playwright/test
npx playwright install chromium
npm test                    # модульные + браузерные тесты
```

Отдельно:

```bash
npm run test:unit           # только модульные, без браузера и без зависимостей
npm run test:e2e            # только браузерные
npm run test:e2e:ui         # интерактивный режим Playwright
npm run report              # HTML-отчёт последнего прогона
npm run serve               # поднять приложение на http://127.0.0.1:8099/
```

`npm run test:unit` работает на голом Node (`node --test`) — без установки чего
бы то ни было. Это удобно как быстрая проверка логики.

## Что где

```
tests/
  server.js               — статический сервер без зависимостей: раздаёт корень
                            репозитория так же, как это сделает GitHub Pages
  playwright.config.js    — два проекта: экран машины 1200×800 и телефон 412×915
  fixtures/ways.js        — синтетический ответ Overpass: полосы дорог вокруг
                            Франкфурта, по одной на каждый случай из ТЗ 3.4/3.5
  fixtures/harness.js     — фикстура `screen`: подмена geolocation и fetch,
                            «поездка» по азимуту, чтение состояния экрана
  unit/maxspeed.test.js   — разбор тега maxspeed, таблица implicit-значений
  unit/matching.test.js   — гаверсинус, азимут, проекция, выбор сегмента, гистерезис
  unit/geo.test.js        — расчёт скорости, фолбэк, EMA, история фиксов
  unit/overpass.test.js   — кэш (LRU/TTL), лимиты запросов, бэкофф
  e2e/acceptance.spec.js  — критерии приёмки из раздела 8 ТЗ
  e2e/states.spec.js      — состояния знака (ТЗ 3.4, 4) и состояния приложения (ТЗ 5)
  e2e/limits.spec.js      — запросы, кэш, сбои сети, работа в фоне, приватность
  e2e/layout.spec.js      — читаемость экрана; прогоняется и на машине, и на телефоне
```

## Как устроены браузерные тесты

Приложению подменяются ровно две вещи:

- `navigator.geolocation` — чтобы «ехать» без настоящего GPS;
- `window.fetch` — чтобы Overpass отвечал заранее известными дорогами и умел
  падать по команде (`offline`) или молчать до обрыва по тайм-ауту (`timeout`).

Всё остальное — настоящий код приложения, включая расчёт скорости, подбор
сегмента и отрисовку.

Фикстура `screen` даёт:

```js
await screen.open({ ways, network, clock });  // открыть приложение
await screen.start();                          // нажать «Старт»
await screen.fix({ lat, lon, speed, heading, accuracy, timestamp });
await screen.drive({ from, bearing, speedMs, seconds, gpsSpeed });
await screen.fail(1);                          // ошибка геолокации по коду
await screen.setNetwork('offline');
await screen.tick(30000);                      // продвинуть время
const state = await screen.read();             // всё состояние экрана одним объектом
```

По завершении каждого теста фикстура проверяет, что страница не выбросила ни
одной ошибки — это постоянная проверка критерия приёмки 8.6.

### Время

Тесты, которым важны лимиты запросов и устаревание данных, открывают приложение
с `clock: true` — это поддельные часы Playwright. Тогда `screen.tick(ms)`
двигает время по-настоящему (срабатывают таймеры приложения), и десять минут
поездки прогоняются за секунды. Без `clock` время не подделывается, а метки
времени фиксов задаются явно, чтобы расчёт скорости не зависел от того, сколько
реально длится прогон.

### Скорость и heading

`screen.drive()` по умолчанию отдаёт `coords.speed`. Чтобы проверить фолбэк по
гаверсинусу (ТЗ 3.2.2), передайте `gpsSpeed: false` — тогда приложение получит
`speed: null`, как это делает Chrome DevTools при подмене координат.

## Покрытие требований

| Требование ТЗ | Где проверяется |
|---|---|
| 3.1 опции `watchPosition`, история фиксов | `unit/geo.test.js` |
| 3.2 скорость, фолбэк, EMA, подавление дрейфа | `unit/geo.test.js`, `e2e/acceptance.spec.js` |
| 3.3 запрос, проекция, направление, ранжирование, гистерезис | `unit/matching.test.js`, `e2e/acceptance.spec.js`, `e2e/limits.spec.js` |
| 3.4 разбор `maxspeed` | `unit/maxspeed.test.js`, `e2e/states.spec.js` |
| 3.5 таблица implicit-значений, определение страны | `unit/maxspeed.test.js`, `e2e/states.spec.js` |
| 3.6 кэш, лимиты, бэкофф | `unit/overpass.test.js`, `e2e/limits.spec.js` |
| 4 читаемость, знак, индикация превышения, Wake Lock, фон | `e2e/layout.spec.js`, `e2e/states.spec.js`, `e2e/limits.spec.js` |
| 5 обязательные состояния, запрет устаревших данных | `e2e/states.spec.js` |
| 6 приватность: только Overpass, без `localStorage` | `e2e/limits.spec.js` |
| 8 критерии приёмки | `e2e/acceptance.spec.js` |

## В CI

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npm ci
  working-directory: tests
- run: npx playwright install --with-deps chromium
  working-directory: tests
- run: npm test
  working-directory: tests
```

При `CI=true` конфигурация включает один повтор упавшего теста и HTML-отчёт.
