import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // Tests run against shared source, never a stale dist build.
      '@dalio/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
