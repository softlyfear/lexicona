import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { components } from '../src/shared/api/generated';
import {
  errors,
  parseError,
  userSchema,
  passwordSchema,
} from '../src/auth/wire';
const requestId = '11111111-1111-4111-8111-111111111111';
const schema = z
  .object({
    paths: z.record(
      z.string(),
      z.record(
        z.string(),
        z.object({
          responses: z.record(
            z.string(),
            z.object({
              'x-error-codes': z.record(z.string(), z.string()).optional(),
            }),
          ),
        }),
      ),
    ),
  })
  .parse(JSON.parse(readFileSync('../backend/openapi/auth-v1.json', 'utf8')));

describe('strict validation compensates for conservative generated transport types', () => {
  it('pins actual snapshot identity and demonstrates the generated enum/propertyNames fidelity gap without casts', () => {
    expect(
      createHash('sha256')
        .update(readFileSync('../backend/openapi/auth-v1.json'))
        .digest('hex'),
    ).toBe('b42cfcbcd9a2705da69d0933496bca6fd99ec6801ffe259c82f45966c9b995e8');
    const widened = {
      error: {
        code: 'unpublished_code',
        message: 'unpublished_message',
        fields: { unpublished_field: ['unpublished'] },
        request_id: requestId,
      },
    } satisfies components['schemas']['AuthErrorDTO'];
    expect(() => parseError('login', 422, widened)).toThrow();
    const body = {
      error: {
        code: 'validation_error',
        message: 'Проверьте поля формы.',
        fields: {},
        request_id: requestId,
      },
    };
    for (const messages of [
      [],
      ['Неверный тип.', 'Неверный тип.'],
      ['Неверный тип.', 'Обязательное поле.'],
    ])
      expect(() =>
        parseError('login', 422, {
          error: { ...body.error, fields: { login: messages } },
        }),
      ).toThrow();
    expect(
      parseError('login', 422, {
        error: {
          ...body.error,
          fields: { password: ['Обязательное поле.', 'Неверный тип.'] },
        },
      }).fields.password,
    ).toHaveLength(2);
    expect(() =>
      parseError('me', 401, {
        error: {
          ...body.error,
          code: 'auth_required',
          message: 'Требуется вход.',
          fields: { login: ['Неверный тип.'] },
        },
      }),
    ).toThrow();
  });
  it('matches every actual operation/status/code/message and rejects drift/extra fields', () => {
    for (const operation of ['csrf', 'login', 'logout', 'me'] as const) {
      const method =
        operation === 'login' || operation === 'logout' ? 'post' : 'get';
      const actual = schema.paths[`/api/v1/auth/${operation}`]?.[method];
      expect(actual).toBeDefined();
      const registry: Record<string, Record<string, string>> = {};
      for (const [status, response] of Object.entries(
        actual?.responses ?? {},
      )) {
        if (!response['x-error-codes']) continue;
        registry[status] = response['x-error-codes'];
        for (const [code, message] of Object.entries(
          response['x-error-codes'],
        )) {
          const body = {
            error: { code, message, fields: {}, request_id: requestId },
          };
          expect(parseError(operation, Number(status), body).code).toBe(code);
          expect(() =>
            parseError(operation, Number(status), {
              ...body,
              unexpected: true,
            }),
          ).toThrow();
          expect(() =>
            parseError(operation, Number(status), {
              error: { ...body.error, code: 'unpublished' },
            }),
          ).toThrow();
          expect(() =>
            parseError(operation, Number(status), {
              error: { ...body.error, message: '<html>untrusted</html>' },
            }),
          ).toThrow();
          expect(() =>
            parseError(operation, Number(status), {
              error: {
                ...body.error,
                fields: { private_key: ['Неверный тип.'] },
              },
            }),
          ).toThrow();
          expect(() =>
            parseError(operation, Number(status), {
              error: { ...body.error, fields: { login: ['untrusted'] } },
            }),
          ).toThrow();
        }
      }
      expect(errors[operation]).toEqual(registry);
    }
    expect(() => parseError('me', 202, {})).toThrow();
    expect(
      parseError('login', 422, {
        error: {
          code: 'validation_error',
          message: 'Проверьте поля формы.',
          fields: { login: ['Обязательное поле.'] },
          request_id: requestId,
        },
      }).fields.login,
    ).toEqual(['Обязательное поле.']);
  });
  it('rejects noncanonical IDs, extra user fields and unsafe integer transport versions', () => {
    const user = {
      id: requestId,
      login: 'member',
      display_name: 'Имя',
      role: 'user',
      version: 1,
    };
    expect(userSchema.parse(user)).toEqual(user);
    for (const invalid of [
      { ...user, id: requestId.toUpperCase().replace('4111', '1111') },
      { ...user, owner: requestId },
      { ...user, version: Number.MAX_SAFE_INTEGER + 1 },
      { ...user, display_name: '\u0000' },
    ])
      expect(userSchema.safeParse(invalid).success).toBe(false);
  });
  it('counts scalar password values, preserves whitespace/Unicode and rejects surrogates', () => {
    expect(passwordSchema.safeParse('😀'.repeat(12)).success).toBe(true);
    expect(passwordSchema.safeParse('😀'.repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse('😀'.repeat(6)).success).toBe(false);
    expect(passwordSchema.safeParse('\ud800'.repeat(12)).success).toBe(false);
    const unnormalized = ' e\u0301\n'.repeat(4);
    expect(passwordSchema.parse(unnormalized)).toBe(unnormalized);
  });
});
