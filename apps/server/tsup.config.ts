import { cp } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    main: 'src/main.ts',
    'migrate-cli': 'src/db/migrate-cli.ts',
    'seed-cli': 'src/db/seed/cli.ts',
    'create-admin-cli': 'src/db/create-admin-cli.ts',
    'emulate-cli': 'src/emulator/cli.ts',
    'emulate-pos-cli': 'src/emulator/pos-cli.ts',
    'emulate-onec-cli': 'src/emulator/onec-cli.ts',
    'emulate-setup-cli': 'src/emulator/setup-cli.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: ['@zapas/shared'],
  async onSuccess() {
    await cp('src/db/migrations', 'dist/migrations', { recursive: true });
  },
});
