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

В настройках выбираются языки, голос, скорость и автоозвучка вопроса. По умолчанию
звучат английский и русский. Снятый язык в словаре и на тренировке не произносится.
Кнопка «Проверить» в настройках по-прежнему произносит образец.

Серверные голоса работают на вашем компьютере, без внешнего сервиса озвучки.
В каталоге 23 голоса: американский и британский английский и русский, женские
и мужские, плюс небинарный американский голос Sam. Модели, около 1,5 GB,
ставятся один раз:

```sh
make voices
```

В Docker тот же шаг внутри уже запущенного контейнера:

```sh
docker compose exec app python -m lexicona.tts download
```

Первая фраза после запуска сервера ждёт загрузку голоса. Следующие фразы этого голоса
начинаются быстрее: модель остаётся в памяти. Голос браузера зависит от устройства;
сетевой голос может отправлять текст своему сервису, это видно при выборе.

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

На сервере с Docker:

```sh
cp .env.example .env
docker compose up -d --build
docker compose exec app lexicona-admin create-user me --admin
```

В `.env` укажите домен. Caddy сам получает сертификат. База хранится в томе `data`.

## Лицензия

Код — MIT. Словарь FreeDict+WikDict eng-rus 2025.11.23 —
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/legalcode):
Karl Bartel, WikDict, Wiktionary.org через DBnary, FreeDict.
[Архив](https://download.freedict.org/dictionaries/eng-rus/2025.11.23/freedict-eng-rus-2025.11.23.src.tar.xz),
SHA256 `f3dadcc29d7df6e77edb13b98a2ba2c3fac002852eddd8b557637f0b13d39c39`.

Голоса Piper распространяются на своих условиях. Карточка каждого голоса сохраняется
рядом с моделью. См. [лицензию Piper](https://github.com/OHF-Voice/piper1-gpl/blob/main/COPYING)
и [каталог моделей](https://huggingface.co/rhasspy/piper-voices).
