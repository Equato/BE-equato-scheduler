import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Source tests only: a built dist/ would otherwise be collected too, and run
    // every test twice — once against a possibly stale build.
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    // Integration tests run against the shared local Postgres, Redis and storage.
    env: loadDotEnv(),
    testTimeout: 30_000,
    fileParallelism: false,
  },
});

function loadDotEnv(): Record<string, string> {
  try {
    return Object.fromEntries(
      (process.loadEnvFile ? (process.loadEnvFile('.env'), Object.entries(process.env)) : []).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}
