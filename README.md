# Lampa Plugins

Персональный маркетплейс плагинов для медиа-плеера [Lampa](https://lampa.mx) — авторства [@vahagn](https://t.me/vahagn).

## Установка (для пользователя Lampa)

Добавить в Lampa **одну** ссылку — _Настройки → Расширения → Добавить плагин_:

```
https://vahagn-99.github.io/lampa/app/store.js
```

Она добавляет пункт **«Мои плагины»** в настройки. Клик по нему открывает нативный UI магазина расширений Lampa, указывающий на наш `storage/extensions.json`, — ставь / удаляй любой плагин оттуда. На первом запуске автоматически подтягивается `log-collector` (для сбора логов с телевизора).

Страница каталога: <https://vahagn-99.github.io/lampa/>

## Каталог

Источник истины — [`config/plugins.yml`](./config/plugins.yml). Для Lampa публикуется сгенерированный [`storage/extensions.json`](./storage/extensions.json). Лендинг `index.html` — статический, карточки плагинов добавляются руками.

## Структура репозитория

Трекаемое (то, что хостится через GitHub Pages):

```
app/
├── store.js              # главная точка входа (URL выше)
├── plugins/              # каталожные плагины — ровно один .js на файл
│   ├── autoskip.js
│   ├── kinopub-bridge.js
│   ├── lazy-resume.js
│   ├── lazy-resume-probe.js
│   └── torrserver-discovery.js
└── support/              # инфраструктурные плагины (не каталог)
    └── log-collector.js  # стрим логов на dev-машину, авто-устанавливается

config/
└── plugins.yml           # источник истины: реестр, категории, auto_install

storage/
├── extensions.json       # сгенерированный каталог для Lampa (make catalog)
├── .gitignore            # игнор только локальных файлов в storage/
├── dev-session.json      # [gitignored] локальный Chrome-session snapshot
└── logs/                 # [gitignored] вывод log-server.py (make logs)

log-server.py             # dev-сервер для сбора логов с ТВ (stdlib Python)
index.html                # статический лендинг
Makefile                  # дев-команды (см. `make help`)
README.md
```

Личный дев-инструментарий (gitignored): `scripts/` (`build-catalog.py`, `lampa-dev.sh`, `inject-session.mjs`), `vendor/lampa-source/`, `.chrome-profile/`, `.claude/`, `openspec/`, `CLAUDE.md`. Внутри `storage/` локальные `dev-session.json` и `logs/` игнорятся через `storage/.gitignore`.

## Добавить новый плагин

1. Положи файл `app/plugins/<name>.js` (ES5 IIFE; паттерн — в skill `lampa-plugin-development`).
2. В Claude Code запусти `/build-plugin <name>` — он спросит алиасы/категорию, зарегистрирует в `config/plugins.yml`, перегенерирует `storage/extensions.json`, закоммитит и (по подтверждению) запушит.
3. После push плагин виден в сторе на ТВ при следующем открытии настроек расширений — никаких переустановок.

Вручную: правишь `config/plugins.yml`, запускаешь `make catalog`, коммитишь `config/plugins.yml` + `storage/extensions.json` + `app/plugins/<name>.js` одним коммитом.

## Дебаг на телевизоре

На ТВ нет DevTools. Для стрим-логов есть пара `app/support/log-collector.js` (ставится авто) + `log-server.py` (сервер на деве):

```bash
make logs            # HTTP на :9999, логи в ./logs
make logs-tls        # HTTPS с самоподписанным сертом (если Lampa по HTTPS)
```

На ТВ: _Настройки → Сборщик логов_ → включить, вставить выведенный URL. Файлы: `./storage/logs/<prefix>/YYYY-MM-DD.log` + объединённый `all-YYYY-MM-DD.log`.

## Разработка

```bash
make help            # все доступные таргеты
make catalog         # перегенерировать storage/extensions.json
make list            # показать реестр с категориями и алиасами
make serve           # превью index.html на :8000
make lampa           # локальная Lampa с сохранённой сессией
make clean           # снести .playwright-mcp/ и .DS_Store
```

Плагины пишутся в ES5 (TV-WebView), одним файлом, без рантайм-зависимостей. Паттерн bootstrap, API `window.Lampa`, правила ES5 — в skills `lampa-plugin-development`, `lampa-plugin-rules`, `lampa-plugin-debugging`.

## Лицензия

Без явной лицензии. Используйте свободно, с оглядкой на сторонние сервисы (TheIntroDB, IntroDB, z01.online, KinoPub) и их лицензии.
