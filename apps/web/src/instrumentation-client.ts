// Browser-side Sentry — Phase 7 (SPEC §8). Same rules as the server init:
// env-gated, no PII, low trace sampling. The dashboard shows conversation
// content on screen, so replays stay OFF — a session replay would ship
// LGPD-sensitive message content to a third party.
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
