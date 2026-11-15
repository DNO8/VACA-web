import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: './tests',
  testMatch: ['d1/**/*.spec.ts', 'e2e/stellar-contracts.spec.ts'],
  outputDir: mkdtempSync(join(tmpdir(), 'vaca-d1-tests-')),
  reporter: 'line',
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 15_000,
});
