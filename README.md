# Lampa Plugins

Коллекция плагинов для медиа-плеера [Lampa](https://lampa.mx) — авторства [@vahagn](https://t.me/vahagn).

Публикуемые плагины хостятся через **GitHub Pages** из папки [`docs/`](./docs). Установка в Lampa: _Настройки → Расширения → Добавить плагин_ → вставить URL.

## Актуальные плагины

| Плагин | Описание | URL |
|---|---|---|
| **KinoPub × AppleTV Bridge** | При клике на серию в списке эпизодов от `appleTV.js` открывает Z01 Online с KinoPub как источником по умолчанию. Требует `appleTV.js` и `z01.online/online.js` (Z01 Premium). | `https://vahagn-99.github.io/lampa/kinopub-bridge.js` |
| **Auto Skip** | Автоматический пропуск заставок, рекапов, титров и превью в сериалах. Источники сегментов: TheIntroDB, IntroDB. | `https://vahagn-99.github.io/lampa/autoskip.js` |

Удобная страничка со всеми URL: <https://vahagn-99.github.io/lampa/>

## Структура репозитория

```
docs/                       # опубликованные минифицированные версии (GitHub Pages source)
├── index.html              # landing с URL всех плагинов
├── kinopub-bridge.js       # → kino_pub/kinopub-appletv-bridge.min.js
└── autoskip.js             # → series_auto_skip/skip-intro.min.js

kino_pub/                   # исходник и минификация KinoPub × AppleTV Bridge
├── kinopub-appletv-bridge.js
└── kinopub-appletv-bridge.min.js

series_auto_skip/           # исходник и минификация Auto Skip
├── skip-intro.js
├── skip-intro.min.js
└── README.md

openspec/                   # спецификации изменений (OpenSpec workflow)
```

## Разработка

Подробности про конвенции, bootstrap-паттерны для Lampa-плагинов и workflow изменений — в [`CLAUDE.md`](./CLAUDE.md).

Минификация делается вручную: `npx terser <source>.js -c -m -o <source>.min.js` — минификатор не коммитится как зависимость. Файлы в `docs/` — копии минифицированных версий, обновляются при выпуске.

## Лицензия

Без явной лицензии; используйте свободно, с оглядкой на чужие зависимости и сторонние сервисы (TheIntroDB, IntroDB, z01.online, KinoPub).
