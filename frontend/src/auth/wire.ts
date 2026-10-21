import { z } from 'zod';
import type { components } from '../shared/api/generated';
import type { Operation } from './admission';

export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const principalSchema = z.union([
  z.literal('anonymous'),
  z.templateLiteral(['user:', uuidSchema]),
]);
export const tokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const passwordSchema = z
  .string()
  .refine(
    (value) =>
      !/[\p{Cs}]/u.test(value) &&
      Array.from(value).length >= 12 &&
      Array.from(value).length <= 128,
    'Пароль: от 12 до 128 символов.',
  );
export const loginSchema = z.strictObject({
  login: z
    .string()
    .regex(/^[A-Za-z0-9_]{3,32}$/, 'Логин: 3–32 латинских буквы, цифры или _.')
    .transform((value) => value.toLowerCase()),
  password: passwordSchema,
});
export const userSchema = z.strictObject({
  id: uuidSchema,
  login: z.string().regex(/^[a-z0-9_]{3,32}$/),
  display_name: z
    .string()
    .refine(
      (value) =>
        Array.from(value).length >= 1 &&
        Array.from(value).length <= 80 &&
        !/[\p{Cc}\p{Cs}]/u.test(value),
    ),
  role: z.enum(['user', 'admin']),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}) satisfies z.ZodType<components['schemas']['UserDTO']>;
export type User = z.infer<typeof userSchema>;
export const meSchema = z.strictObject({
  user: userSchema,
}) satisfies z.ZodType<components['schemas']['MeDTO']>;
export const csrfSchema = z.strictObject({
  csrf_token: tokenSchema,
  authenticated: z.boolean(),
}) satisfies z.ZodType<components['schemas']['CsrfDTO']>;
export const authSchema = z.strictObject({
  user: userSchema,
  csrf_token: tokenSchema,
}) satisfies z.ZodType<components['schemas']['AuthDTO']>;
export const logoutSchema = z.strictObject({
  csrf_token: tokenSchema,
  authenticated: z.literal(false),
}) satisfies z.ZodType<components['schemas']['LogoutDTO']>;

const common = {
  401: { auth_required: 'Требуется вход.' },
  404: { not_found: 'Ресурс не найден.' },
  405: { method_not_allowed: 'Метод не поддерживается.' },
  408: { request_timeout: 'Время ожидания запроса истекло.' },
  422: { validation_error: 'Проверьте поля формы.' },
  429: { rate_limited: 'Слишком много попыток. Повторите позже.' },
  431: { request_headers_too_large: 'Заголовки запроса слишком большие.' },
  500: { internal_error: 'Внутренняя ошибка сервиса.' },
  503: {
    db_busy: 'База данных занята. Повторите позже.',
    service_unavailable: 'Сервис временно недоступен.',
  },
};
const unsafe = {
  ...common,
  400: {
    invalid_request: 'Некорректный запрос.',
    invalid_json: 'Некорректный JSON.',
  },
  403: { csrf_failed: 'Проверка безопасности не пройдена.' },
  412: { principal_mismatch: 'Аккаунт изменился. Обновите страницу.' },
  413: { request_too_large: 'Запрос слишком большой.' },
  415: { unsupported_media_type: 'Неподдерживаемый формат запроса.' },
};
/** Frozen phase2A registry, checked against actual OpenAPI including $ref siblings. */
export const errors: Record<
  Operation,
  Record<string, Record<string, string>>
> = {
  me: common,
  csrf: { ...common, 403: unsafe[403] },
  logout: unsafe,
  login: {
    ...unsafe,
    401: { ...common[401], invalid_credentials: 'Неверный логин или пароль.' },
    409: { already_authenticated: 'Сначала выйдите из текущего аккаунта.' },
    503: { ...common[503], auth_busy: 'Сервис занят. Повторите позже.' },
  },
};
const fieldMessages = z.enum([
  'Обязательное поле.',
  'Неверный тип.',
  'Недопустимый формат.',
  'Недопустимая длина.',
  'Лишние поля запрещены.',
  'Недопустимое значение.',
]);
const messages = z
  .array(fieldMessages)
  .min(1)
  .refine(
    (items) =>
      JSON.stringify(items) ===
      JSON.stringify(
        fieldMessages.options.filter((message) => items.includes(message)),
      ),
  );
const errorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    request_id: uuidSchema,
    fields: z.strictObject({
      login: messages.optional(),
      password: messages.optional(),
      _request: messages.optional(),
    }),
  }),
});
export function parseError(
  operation: Operation,
  status: number,
  input: unknown,
) {
  const { error } = errorSchema.parse(input);
  const expected = errors[operation][status]?.[error.code];
  if (
    !expected ||
    expected !== error.message ||
    (status !== 422 && Object.keys(error.fields).length !== 0)
  )
    throw new Error('Invalid error response');
  return error;
}
