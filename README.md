# Lexicona

Личный англо-русский словарь с тренировками. Свой словарь и свой прогресс у каждого
человека. Открывается в браузере на телефоне, планшете и компьютере. Аккаунты создаёт
владелец, открытой регистрации нет.

## Что внутри

- слова с несколькими переводами, транскрипцией, примером, заметкой и своими тегами;
- поиск и фильтр: несколько тегов означают «любой из выбранных»;
- подсказка перевода из локального словаря и, если его нет, из DeepL или DeepSeek;
- тренировки: выбор из шести, письменный ответ и сопоставление пар;
- направления EN → RU и RU → EN, своё число слов или все подходящие;
- после ошибки можно исправить ответ без второго штрафа;
- прогресс не ограничен 100% и зависит от выбранной сложности;
- занятия по расписанию повторений и свободная практика, которая расписание не меняет;
- незаконченное занятие можно продолжить;
- статистика первых ответов по дням;
- слово можно убрать из тренировок и вернуть, прогресс сохранится.

## Озвучка

В настройках для английского и русского отдельно выбираются источник и голос,
а также общая скорость и автоозвучка вопроса. По умолчанию звучат оба языка.
Снятый язык в словаре и на тренировке не произносится.
Кнопка «Проверить» в настройках по-прежнему произносит образец.

Серверные голоса — Kokoro на вашем компьютере, без внешнего сервиса озвучки.
В каталоге 28 английских голосов: 20 с американским произношением и 8 с британским,
женские и мужские. По умолчанию выбраны Heart для американского и Emma для британского.
Русский текст произносит голос браузера. Первая фраза после запуска ждёт загрузку модели.
Голос браузера зависит от устройства; сетевой голос может отправлять текст своему сервису,
это видно при выборе.

Kokoro работает в отдельном Python 3.13, потому что основной сервер использует Python 3.14.
Из корня проекта:

```sh
make kokoro-install
make voices
```

Вторая команда один раз скачивает около 354 МБ моделей в `backend/data/tts/kokoro`
при настройках по умолчанию. Образ Docker уже содержит это окружение Python.
Модели в контейнер ставятся отдельно, в каталог данных:

```sh
docker compose --profile lexicona exec app python -m lexicona.infrastructure.kokoro download
```

В настройках озвучки выберите серверный источник и английский голос. Сохранённый
голос прежнего каталога заменяется Heart или Emma того же акцента.

## Установка на телефон, планшет или компьютер

Откройте сайт по HTTPS и в настройках нажмите «Установка». На iPhone и iPad в Safari:
«Поделиться», затем «На экран Домой».

На Ubuntu Chrome из Flatpak сам не может записать ярлык. Один раз в терминале:

```sh
mkdir -p ~/.local/share/applications ~/.local/share/icons
flatpak override --user --filesystem=~/.local/share/applications:create --filesystem=~/.local/share/icons:create com.google.Chrome
pkill -f chrome || true
```

Полностью откройте Chrome снова и нажмите «Установка». Картинка после этого сохраняется,
но пункт меню Chrome часто не оставляет, а старый кэш значков её не видит: в меню
остаётся серая плитка. Сразу после установки выполните:

```sh
gtk-update-icon-cache -f -t ~/.local/share/icons/hicolor
ICON=$(find ~/.local/share/icons/hicolor/512x512/apps -name 'chrome-*-Default.png' -printf '%T@ %f\n' | sort -n | tail -1 | cut -d' ' -f2)
APP_ID=${ICON#chrome-}
APP_ID=${APP_ID%-Default.png}
cat > ~/.local/share/applications/chrome-${APP_ID}-Default.desktop <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Terminal=false
Name=Lexicona
Exec=/var/lib/flatpak/exports/bin/com.google.Chrome --profile-directory=Default --app-id=${APP_ID}
Icon=chrome-${APP_ID}-Default
StartupWMClass=crx_${APP_ID}
StartupNotify=true
EOF
update-desktop-database ~/.local/share/applications
```

Ярлык называется Lexicona. Он появляется в меню приложений: клавиша Super, затем поиск
«Lexicona». На рабочий стол Ubuntu его не кладёт. Если установлены и другие приложения
Chrome, команда берёт самый новый значок. Если имя пакета другое, его покажет
`flatpak list --app`.

## Как запустить у себя

Нужны [uv](https://docs.astral.sh/uv/) и Node.js 22+.

```sh
cd backend
uv sync
uv run alembic upgrade head
uv run lexicona-admin create-user me --admin
uv run uvicorn lexicona.main:create_app --factory --reload
```

Интерфейс в другом терминале:

```sh
cd frontend
npm install
npm run dev
```

Сайт разработки: http://localhost:5173. База лежит в `backend/data/lexicona.db`.
Словарь-подсказка собирается один раз командой `make dictionary`.

Ключи DeepL и OpenRouter необязательны. Без них работают локальный словарь и ручной
ввод. Имена переменных — в `.env.example`. Запросы к OpenRouter оплачиваются вашим ключом.

Проверка проекта: `make check`.

## Сервер

Один адрес на всех, аккаунт у каждого свой. База — файл `backend/data/lexicona.db` внутри проекта. Каталог `backend/data/` в git не входит, `git pull` его не затирает. Копия всего каталога проекта переносит базу на другой сервер. В `.env` укажите `LEXICONA_UID` и `LEXICONA_GID` как `id -u` и `id -g`, чтобы контейнер мог писать в эту папку.

Сайт открывается на порту `8443`: `https://<домен>:8443`. Caddy внутри контейнера слушает 443. Другой порт пишется в `.env`. Этот файл git не хранит, поэтому `git pull` его не затирает и `compose.yaml` после обновления менять не нужно.

```sh
LEXICONA_HTTPS_PORT=443
```

Без этой строки порт остаётся `8443`. После смены один раз выполните `docker compose --profile lexicona up -d` и откройте порт в файрволе. Следующие обновления репозитория порт не трогают.

В DNS одна A-запись: имя из `LEXICONA_DOMAIN` указывает на IP сервера.

```sh
LEXICONA_DOMAIN=lexicona.example.com
LEXICONA_TLS_DIR=/path/to/cert
LEXICONA_TLS_CERT=/path/to/cert/fullchain.pem
LEXICONA_TLS_KEY=/path/to/cert/privkey.pem
```

Это файлы Let's Encrypt. Имя в сертификате совпадает с доменом, оба пути лежат внутри `LEXICONA_TLS_DIR`. После замены файлов: `docker compose --profile lexicona restart caddy`.

```sh
docker compose --profile lexicona up -d --build
docker compose run --rm lexicona-admin create-user me --admin
```

Сайт в профиле `lexicona`: обычные `up`, `stop` и `down` его не запускают и не останавливают. Остановка: `docker compose --profile lexicona stop`. Команда `lexicona-admin` спрашивает пароль и лежит в своём профиле `lexicona-admin`, поэтому запуск сайта её не трогает.

## Лицензия

Код — MIT.

Словарь FreeDict+WikDict eng-rus 2025.11.23, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/legalcode): Karl Bartel, WikDict, Wiktionary.org через DBnary, FreeDict. [Архив](https://download.freedict.org/dictionaries/eng-rus/2025.11.23/freedict-eng-rus-2025.11.23.src.tar.xz).

```text
f3dadcc29d7df6e77edb13b98a2ba2c3fac002852eddd8b557637f0b13d39c39
```

Модель [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) распространяется по лицензии Apache 2.0; [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) — по лицензии MIT.
