import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', 'seed-cli': 'src/seed-cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: false,
  sourcemap: true,
  noExternal: ['@zapas/shared'],
});
