import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    alias: {
      obsidian: resolve(__dirname, 'test/mocks/obsidian.ts'),
    },
  },
});
