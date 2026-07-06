// Server-side Sentry — Phase 7 (SPEC §8). Next.js loads this once per server
// boot; env-gated so local dev without a DSN costs nothing. Errors carry
// stacks and ids only — never message content (iron rule #7).
import * as Sentry from '@sentry/nextjs';

export function register() {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
  });
}

export const onRequestError = Sentry.captureRequestError;
