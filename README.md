# Lampa Plugins

Персональный маркетплейс плагинов для медиа-плеера [Lampa](https://lampa.mx) — авторства [@vahagn](https://t.me/vahagn).

## Установка (для пользователя Lampa)

Добавить в Lampa **одну** ссылку — _Настройки → Расширения → Добавить плагин_:

```
https://vahagn-99.github.io/lampa/plugins/store.js
```

Она добавляет пункт **«Мои плагины»** в настройки. Клик по нему открывает нативный UI магазина расширений Lampa, указывающий на наш `extensions.json`, — ставь / удаляй любой плагин оттуда. На первом запуске автоматически подтягивается `log-collector` (для сбора логов с телевизора).

Страница каталога: <https://vahagn-99.github.io/lampa/>

## Каталог

Источник истины — [`plugins.yml`](./plugins.yml). Для Lampa публикуется сгенерированный [`extensions.json`](./extensions.json). Лендинг `index.html` рендерит каталог из `extensions.json` динамически.

Категории и текущие плагины — смотри `plugins.yml` или страницу выше.

## Структура репозитория

Трекаемое (то, что реально ездит в GitHub Pages):

```
plugins/            # ровно один .js на плагин — канонический каталог
plugins.yml         # реестр: имя, категория, алиасы, автор, auto_install
extensions.json     # сгенерированный каталог для Lampa (из plugins.yml)
index.html          # лендинг, рендерит extensions.json
log-server.py       # dev-сервер для сбора логов с ТВ (stdlib-only)
Makefile            # дев-команды (см. `make help`)
```

Личный дев-инструментарий (gitignored, у каждого свой): `scripts/`, `lampa-source/`, `lampa-dev.sh`, `dev-session.json`, `.chrome-profile/`, `.claude/`, `openspec/`, `CLAUDE.md`.

## Добавить новый плагин

1. Положи файл `plugins/<name>.js` (ES5 IIFE; паттерн — в skill `lampa-plugin-development`).
2. В Claude Code запусти `/build-plugin <name>` — он спросит алиасы/категорию, зарегистрирует в `plugins.yml`, перегенерирует `extensions.json`, закоммитит и (по подтверждению) запушит.
3. После push плагин виден в сторе на ТВ при следующем открытии настроек расширений — никаких переустановок.

Вручную тоже можно: редактируешь `plugins.yml`, запускаешь `make catalog`, коммитишь `plugins.yml` + `extensions.json` + `plugins/<name>.js` одним коммитом.

## Дебаг на телевизоре

На ТВ нет DevTools. Для стрим-логов есть пара `plugins/log-collector.js` (клиент, ставится авто) + `log-server.py` (сервер на деве):

```bash
make logs            # HTTP на :9999, логи в ./logs
make logs-tls        # HTTPS с самоподписанным сертом (если Lampa по HTTPS)
```

На ТВ: _Настройки → Сборщик логов_ → включить, вставить выведенный URL. Файлы: `./logs/<prefix>/YYYY-MM-DD.log` + объединённый `all-YYYY-MM-DD.log`.

## Разработка

```bash
make help            # все доступные таргеты
make catalog         # перегенерировать extensions.json
make list            # показать реестр с категориями и алиасами
make serve           # превью index.html на :8000
make clean           # снести .playwright-mcp/ и .DS_Store
```

Плагины пишутся в ES5 (TV-WebView), одним файлом, без рантайм-зависимостей. Паттерн bootstrap, API `window.Lampa`, правила ES5 — в skills `lampa-plugin-development`, `lampa-plugin-rules`, `lampa-plugin-debugging`.

## Лицензия

Без явной лицензии. Используйте свободно, с оглядкой на сторонние сервисы (TheIntroDB, IntroDB, z01.online, KinoPub) и их лицензии.
