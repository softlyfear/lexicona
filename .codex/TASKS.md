# Активные задачи

Один тикет — законченный вертикальный срез. TRAIN-001 принят и перенесён в архив.
TRAIN-002 остаётся planned до коммита TRAIN-001 оркестратором.
Статусы: planned → implementation → review → acceptance → done.
Попытка увеличивается при возврате на доработку. Закрытое переносится в TASKS-archive.md.

## TRAIN-002 — карточки с раскрытием и самооценкой

- Статус: planned (начать только после принятого и закоммиченного TRAIN-001).
- Попытка: 1.
- Пользовательский результат: тренировать карточки EN→RU и RU→EN,
  раскрывать оборот и выбирать самооценку без ложной объективной точности.
- Зависимость: серверный snapshot/не-choice ответы из TRAIN-001.

### Контракты и AC

1. `POST /api/training/sessions` дополнить `mode="cards"` для обоих направлений.
   Доступность от одного слова, порядок/size/owner/difficulty как input.
   Публичный item до раскрытия: только id, prompt, options: [] без оборота.
   Оборот — frozen snapshot переводов (EN→RU) либо headword (RU→EN).
2. Новый `POST /api/training/items/{id}/reveal` только для cards:
   ответ `{expected_answers: string[]}` из snapshot. Зафиксировать раскрытие на сервере;
   повтор раскрытия идемпотентен, прогресс не меняется. Это штатное раскрытие карточки,
   а не hint. Не-карточный режим → 422, чужой/удалённый item → 404.
3. `POST /api/training/items/{id}/answer` для cards принимает только
   `{grade: "again"|"hard"|"good"|"easy"}`. До раскрытия → 422 без записи оценки.
   Ответ `{grade, expected_answers: string[], delta: int, progress: int}`.
   again = choice error; hard = 0; good/easy = choice correct по frozen difficulty.
   Самооценка не создаёт объективное `correct=true`; UI/итог не называют её точностью.
4. Только первая оценка закрывает item; смена grade при повторе и параллельные оценки
   возвращают уже записанный grade и не меняют прогресс повторно. Clamp 0–100.
   Смысловая правка после старта даёт delta 0; раскрытие и оценка используют прежний
   snapshot, не показывают новые ответы под старым prompt. Без оценки эффекта нет.
5. Новые поля reveal timestamp и grade (если требуются) — следующая Alembic-миграция;
   старые choice/input-сессии и контракты не ломаются. Owner/CSRF/no-store на reveal и
   answer; UI не решает/не посылает delta и не хранит snapshot в localStorage.
6. UI: карточки и переключатель EN↔RU; сначала «Показать ответ», затем оборот и четыре
   доступно подписанные кнопки самооценки. До reveal оценивание недоступно, пока запрос
   выполняется повторное действие блокируется. После grade показать delta/progress и
   «Далее»; итог — число оценённых карточек без «правильных ответов»/процента точности.
   Сетевая ошибка reveal/grade допускает повтор без выдуманного успешного результата.
   Завершение до оценки не начисляет прогресс, режимы choice/input не регрессируют.

### Владельцы и порядок

1. `backend-agent`: `backend/src/lexicona/routers/training.py`, `backend/src/lexicona/models.py`,
   новая миграция `backend/migrations/versions/*_card_training.py`; целевые backend-тесты.
2. `frontend-agent`: `frontend/src/api.ts`, `frontend/src/pages/TrainingPage.tsx`,
   при необходимости `frontend/src/pages/pages.module.css`.
3. `tests-agent`: `backend/tests/test_training_cards.py` или test_training.py,
   `frontend/src/pages/TrainingCards.test.tsx` или TrainingPage.test.tsx, api.test.ts при нужде.
4. `code-reviewer` → `architect` → коммит оркестратора.

### Приёмочные проверки

- API: обе стороны и один word, оборот не утёк до reveal; reveal повтор не начисляет;
  оценка до reveal/неверная grade/чужая форма запрещена; все 4 grade и frozen difficulty;
  no double score/параллельные оценки, meaningful/cosmetic edit;
  owner-scoping и отсутствие CSRF отдельно для нового reveal endpoint.
- UI: reveal→grade→next→итог, не объективная метрика, pending/error/retry,
  обе стороны и регрессии choice/input. `make check`, включая migration drift.
- Вне scope: SRS/history/расписание, дополнительная статистика, hints/skip, остальные режимы.

## Внешнее решение

История пересоздана локально. Force push новой main в GitHub не выполняется
до отдельного явного разрешения пользователя; origin сохранён.
