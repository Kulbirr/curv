import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    // Each test file runs in its own worker: the DB singleton in
    // src/lib/db can be pointed at a temp file per file safely.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/test-support/**',
        'src/types/**',
        // UI components: covered by logic tests on their extracted
        // helpers; full component tests need a browser harness.
        'src/components/**',
        'src/pages/**/*.tsx',
        'src/contexts/**',
        'src/hooks/**',
        'src/icons/**',
      ],
    },
  },
});
