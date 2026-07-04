import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/config/env';

const valid = {
  DATABASE_URL: 'postgres://dalio:dalio@localhost:5432/dalio',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'a-32-plus-character-dev-secret-for-tests',
  BETTER_AUTH_URL: 'http://localhost:3000',
};

describe('validateEnv', () => {
  it('accepts a valid config and applies defaults', () => {
    const env = validateEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.WEB_ORIGIN).toBe('http://localhost:3100');
  });

  it('coerces PORT from string', () => {
    expect(validateEnv({ ...valid, PORT: '4000' }).PORT).toBe(4000);
  });

  it('rejects missing DATABASE_URL with a readable message', () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects a short BETTER_AUTH_SECRET', () => {
    expect(() => validateEnv({ ...valid, BETTER_AUTH_SECRET: 'short' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
});
