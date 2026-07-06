import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().min(1),
  WEB_ORIGIN: z.string().min(1).default('http://localhost:3100'),

  WAHA_BASE_URL: z.string().min(1).optional(),
  WAHA_API_KEY: z.string().min(1).optional(),
  WAHA_WEBHOOK_HMAC_SECRET: z.string().min(1).optional(),

  // Agent (Phase 2). Key optional: without it the agent degrades to
  // observe-only (dev/storm tests). Model tiering per SPEC §5.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AGENT_ROUTER_MODEL: z.string().min(1).default('claude-haiku-4-5'),
  AGENT_BOOKING_MODEL: z.string().min(1).default('claude-opus-4-8'),

  // Observability & ops (Phase 7) — every one optional: the feature is
  // simply off when unset, so dev/test boot with zero extra config.
  SENTRY_DSN: z.string().min(1).optional(),
  BULL_BOARD_PASSWORD: z.string().min(8).optional(),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Passed to ConfigModule.forRoot({ validate }) — the app refuses to boot on bad env. */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}
