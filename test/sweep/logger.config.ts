import { defineConfig } from '../../src';

// Everything visible and every file kind on, so one run shows it all.
export default defineConfig({
  level: 'debug',
  consoleWorker: true,
  consoleTest: true,
  githubAnnotations: false,
  files: { debugTrace: true, partialTrace: true, fullTrace: true, jsonl: true, tables: true },
  infoLogsCharLimit: 120,
});
