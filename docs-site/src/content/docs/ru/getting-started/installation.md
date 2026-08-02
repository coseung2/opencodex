---
title: Установка
description: Установите прокси opencodex (ocx) и необходимые компоненты и убедитесь, что он запускается.
---

`@coseung2/opencodex` устанавливает два эквивалентных прокси-команды, `ocx` и `opencodex`, а также
вспомогательную команду `ocx-notch` только для Windows x64. Обе прокси-команды запускают один и тот же
небольшой локальный HTTP-сервер на Bun. Запросы к моделям идут к провайдеру, выбранному маршрутизацией;
опциональные сайдкары для vision и веб-поиска также могут использовать ваш вход в ChatGPT.

## Предварительные требования

| Требование | Зачем |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx` работает на рантайме Bun, но рантайм автоматически поставляется в комплекте при `npm install` — устанавливать Bun самостоятельно **не нужно**. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App или SDK) | Клиент, перед которым работает opencodex. opencodex записывает данные в `$CODEX_HOME/config.toml` (по умолчанию `~/.codex/config.toml`). |
| Аккаунт провайдера или API-ключ | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, OpenAI-совместимая конечная точка или ваш вход в ChatGPT. |

## Установка

```bash
npm install -g @coseung2/opencodex@next
```

:::note[npm заблокировал postinstall-скрипт bun?]
Свежие версии npm могут блокировать postinstall-скрипт bun (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`),
из-за чего встроенный рантайм Bun остаётся неподготовленным. Переустановите
пакет, разрешив скрипт bun, — и обязательно указывайте имя пакета: в
сокращённой подсказке npm его нет, и без него вместо пакета переустановится
текущий каталог:

```bash
npm install -g --allow-scripts=bun @coseung2/opencodex@next

# если изначально устанавливали через sudo, продолжайте использовать sudo:
sudo npm install -g --allow-scripts=bun @coseung2/opencodex@next
```
:::

Убедитесь, что оба псевдонима команды доступны в `PATH`:

```bash
ocx --version
opencodex --version
```

На Windows x64 команда `ocx-notch` запускает нативный Notch, включённый в тот же npm-пакет.
На Linux, macOS и Windows не-x64 только эта команда завершается с явной ошибкой о неподдерживаемой
платформе; `ocx` и `opencodex` продолжают работать.

### Каналы релизов

Форк coseung2 начинает выпуск версий `2.8.0-cs.*` в канале `next`. До явного повышения до
стабильного релиза оставайтесь на этом канале. Канал upstream `preview` не является каналом
релизов этого пакета:

```bash
npm install -g @coseung2/opencodex@next
ocx update --tag next
```

## Запуск из исходного кода

Чтобы работать над самим opencodex:

```bash
git clone https://github.com/coseung2/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # запускает API прокси в режиме разработки (src/cli/index.ts start)
bun run dev:gui     # запускает dev-сервер панели управления (в другом терминале)
```

`bun run dev` остаётся псевдонимом для `bun run dev:proxy`. API прокси предоставляет `/healthz`,
`/v1/responses` и `/api/*`; `GET /` отдаёт упакованную панель управления только после того, как
`bun run build:gui` создаст `gui/dist`. Пока вы работаете над панелью управления, запускайте
фронтенд отдельно командой `bun run dev:gui`.

## Что создаётся

Состояние opencodex хранится в `$OPENCODEX_HOME` (по умолчанию `~/.opencodex`). Файлы интеграции
с Codex находятся в `$CODEX_HOME` (по умолчанию `~/.codex`).

| Путь | Назначение |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | Ваши провайдеры, провайдер по умолчанию, порт и параметры. |
| `$OPENCODEX_HOME/ocx.pid` | PID запущенного прокси (защита от повторного запуска). |
| `$OPENCODEX_HOME/runtime-port.json` | Текущие PID, имя хоста и порт, включая автоматически выбранный запасной порт. |
| `$OPENCODEX_HOME/auth.json` | Сохранённые учётные данные OAuth (после `ocx login`). |
| `$OPENCODEX_HOME/catalog-backup*.json` | Резервные копии каталога моделей Codex, создаваемые перед тем, как opencodex его изменит. |
| `$CODEX_HOME/config.toml` | На loopback-адресе opencodex добавляет корневой `openai_base_url`, отмеченный собственным маркером; при привязке не к loopback используются `model_provider = "opencodex"` и `[model_providers.opencodex]`, чтобы Codex мог отправлять заголовок API-аутентификации. |
| `$CODEX_HOME/opencodex.config.toml` | Резервный/справочный профиль, записываемый рядом с основной конфигурацией Codex. |
| `$CODEX_HOME/opencodex-catalog.json` | Синхронизированный каталог нативных и маршрутизируемых моделей, используемый Codex. |

:::note
opencodex никогда не удаляет вашу конфигурацию Codex. Каждое внедрение обратимо — `ocx stop`,
`ocx restore` или `ocx eject` убирают ровно те строки, которые добавил opencodex, и восстанавливают
нативный Codex.
:::

## Далее

Переходите к разделу [Быстрый старт](/ru/getting-started/quickstart/), чтобы настроить
первого провайдера, или прочитайте [Как это работает](/ru/getting-started/how-it-works/),
чтобы разобраться в архитектуре.
