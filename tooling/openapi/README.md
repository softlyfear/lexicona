# OpenAPI → TypeScript (build-time only)

Изолированный package: `openapi-typescript` **7.13.0** со своим TypeScript
**5.9.3**. Frontend остаётся на TypeScript **6.0.3**. Pins/locks не меняются,
новой runtime generator dependency в приложении нет.

## Actual source и установка

Источник — экспорт **реального** backend `backend/openapi/auth-v1.json`.
Принятый phase2A содержит csrf/login/me/logout и два legacy health routes,
не будущие register/admin-invites. Sole backend owner управляет schema/wire.
Output принадлежит frontend: `frontend/src/shared/api/generated.ts`.

Node **22.23.3**, npm **10.9.9**. Из корня clone:

```sh
npm ci --prefix frontend
npm ci --prefix tooling/openapi
npm run generate --prefix tooling/openapi
npm run check --prefix tooling/openapi
```

Нужны **оба** locked environments: generator использует собственный CLI,
canonical formatter и strict build исполняются из frontend. Никаких floating
`npx`, global installs, `--force`, overrides или lock updates. `.npmrc`
сохраняет strict engines/peers и выключенные dependency lifecycle scripts.
Приватная мастерская/Hermes/чужая домашняя папка для этих команд не нужны.

## Canonical generation и drift

Raw upstream output не соответствует принятому Prettier frontend. Поэтому
`frontend/tooling/generate.ts` запускает pinned CLI без enum/runtime flags,
затем pinned frontend Prettier с явным `.prettierrc.json` **в памяти**.
`generate` пишет только успешно полученные canonical bytes. `check` генерирует
те же bytes и **только сравнивает**: missing/stale/invalid source/output —
nonzero; существующий target не переписывается. CLI/formatter failure не
оставляет partially generated output. `tooling:build` создаёт ignored build
артефакты frontend; это не изменение проверяемого generated source.

Этот frontend-owned executable helper включён в strict/native inventory и
whole-file100/100, а не исключён как сторонний generator. Его tests реально
исполняют pinned CLI/formatter на actual schema: deterministic generation,
read-only positive/negative drift, missing output, malformed source и cleanup.

## Fidelity boundary

Generated TS — **консервативные transport types**, не полный JSON Schema
validator. У pinned CLI фактически расширяются `$ref`-sibling error-code enums
и `propertyNames` enum для error fields. Ни full inherited type fidelity,
ни exact-object validation не заявлены. `frontend/src/auth/wire.ts` строго
валидирует Zod closed DTO, operation/status/code/message, allowlisted field
names/messages и canonical primitives. Tests сверяют registry со всеми actual
schema responses и показывают отвергаемые widened generated types **без casts**.
Schema drift требует review backend/frontend, не молчаливой правки wire.

Actual generated output проверяется отдельно AST и transpile/emit inventory:
только interfaces/type aliases, без executable units. Это explicit type-only
N/A для конкретного файла, **не blanket exemption** для generated/frontend.

После генерации обязательны frontend strict/lint/format/tests/whole100/build и
real API/browser gates по `frontend/README.md`. `generate/check` не заменяют их.

## Dependency notices

`npm ls --all` и `npm audit --include=dev` запускаются из этого package.
Locks фиксируют graph/integrity, но нулевой audit не доказывает отсутствие
неизвестных vulnerabilities или legal/distribution acceptance. При поставке
самого toolchain сохраняйте upstream licenses/notices, включая TypeScript
`ThirdPartyNoticeText.txt`. У `change-case` 5.4.4 MIT notice отсутствует в npm
tarball, но получен из exact upstream commit
`8aaff31471c918d3eac2b40939c601bee37375dd` (`LICENSE`). У `uri-js-replace` 1.0.1
MIT заявлен в metadata, отдельный upstream license text не найден и здесь
не придумывается. `node_modules` и toolchain не входят в Git.
