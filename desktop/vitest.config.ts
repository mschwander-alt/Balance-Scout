import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20_000,
    environmentMatchGlobs: [['test/ui/**', 'jsdom']],
  },
});
