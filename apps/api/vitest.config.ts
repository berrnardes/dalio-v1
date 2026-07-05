import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Storm tests boot containers + the full app: generous by design.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
  plugins: [
    // Vitest's default esbuild transform does NOT emit decorator metadata,
    // which the Nest DI container needs to resolve constructor injection —
    // integration tests that boot AppModule fail without SWC here.
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
      module: { type: 'es6' },
    }),
  ],
  resolve: {
    alias: {
      // Tests run against shared source, never a stale dist build.
      '@dalio/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
