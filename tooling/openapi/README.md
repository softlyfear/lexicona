# OpenAPI → TypeScript (build-time only)

Изолированный tool package: `openapi-typescript` **7.13.0** использует свой
TypeScript **5.9.3**, удовлетворяющий peer `^5.x`. Frontend остаётся на
TypeScript **6.0.3**; его dependencies, lock и quality gates не меняются.
Никакого runtime generator dependency в приложении и плавающего `npx` нет.

## Установка

Требования: Node `>=22.23.3 <23`, npm `>=10.9.9 <11`; проверенный runtime —
Node **22.23.3** / npm **10.9.9**. Из корня clone:

```bash
cd tooling/openapi
npm ci
```

`.npmrc` включает strict engines/peers и отключает dependency lifecycle
scripts. У locked graph нет install/preinstall/postinstall hooks. `npm ci`
устанавливает собственные devDependencies (не используйте `--omit=dev`);
frontend install для генератора не нужен. Lock фиксирует весь generator graph
и registry integrity; не заменяйте его frontend lock, `--force`,
`--legacy-peer-deps` или overrides. Локальные cache/user/global npm configs
могут быть заданы стандартными переменными npm; приватная мастерская, Hermes,
чужая домашняя папка или глобальный generator не нужны.

## Source prerequisite и команды

**Actual auth API пока не экспортирован и не заморожен.** Sole backend owner
должен сначала предоставить reviewed export реального приложения в
`backend/openapi/auth-v1.json`; не подставляйте demo/synthetic schema.
Output принадлежит frontend: `frontend/src/shared/api/generated.ts`.
Этот package сам не создаёт API и не подтверждает его routes/DTO/headers.

После готовности source, из `tooling/openapi`:

```bash
npm run generate
npm run check
npm ls --all
npm audit --include=dev
```

Scripts вызывают локальный pinned CLI напрямую; пути считаются от package
root (npm запускает scripts там). `generate` пишет output; `check` только
сравнивает с результатом генерации: up-to-date — exit **0**, stale или
отсутствующий output — nonzero. Отсутствующий/некорректный source — ошибка,
**не PASS**. Не вызывайте генерацию до предоставления actual source и не
передавайте remote schema/credentials. Повторная генерация должна давать
те же bytes; изменение source требует regeneration и review diff.

По умолчанию генерация type-only: не добавлять enum/value/runtime flags.
Types не заменяют runtime DTO validation, не обеспечивают exact-object
validation и сами по себе не доказывают API correctness. После реальной
генерации обязательны frontend TS6 strict typecheck и существующие
lint/format/tests/coverage/build/API/E2E gates по frontend README; эти scripts
не запускают и не ослабляют их. Synthetic compatibility/drift/TS6 проверки
не являются actual auth generation или auth acceptance.

## Inventory и сторонние notices

First-party файлы package: `package.json`, `package-lock.json`, `.npmrc`, этот
README. Собственных executable wrappers/modules нет: scripts декларативно
вызывают сторонний CLI. Для этой metadata/docs-only поставки **0 first-party
executable units**, поэтому line/branch coverage N/A именно для этих файлов,
не исключение для всего tooling. При добавлении исполняемого first-party
кода нужны RED→GREEN, tests и 100% executable lines/branches. Type-only
характер будущего actual generated output нужно проверить отдельно.

Manifest/lock не включают `node_modules` или распространяемый toolchain.
Dependency license metadata и нулевой audit не означают legal/distribution
acceptance или отсутствие неизвестных vulnerabilities. При поставке самого
toolchain сохраняйте upstream licenses/notices, включая TypeScript
`ThirdPartyNoticeText.txt`. У `change-case` 5.4.4 MIT notice отсутствует в
npm tarball, но получен из exact upstream commit
`8aaff31471c918d3eac2b40939c601bee37375dd` (`LICENSE`). У `uri-js-replace`
1.0.1 заявлен MIT в metadata, но отдельный upstream license text не найден;
он не придумывается здесь. Bundled-components/legal review и разрешение
распространять toolchain этим package не заявлены.
