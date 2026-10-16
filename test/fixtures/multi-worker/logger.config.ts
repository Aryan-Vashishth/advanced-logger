import { defineConfig } from '../../../src';

export default defineConfig({ level: 'debug', redactKeys: ['pin'], consoleWorker: true, consoleTest: true, maxLogFiles: 1, ansi: false });
