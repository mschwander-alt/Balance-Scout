import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integrationstests teilen sich eine Test-Datenbank
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
