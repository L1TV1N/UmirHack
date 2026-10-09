import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // интеграционные тесты делят одну базу
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
