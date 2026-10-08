import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const fixture = path.resolve(__dirname, 'fixtures/multi-worker');
const cli = require.resolve('@playwright/test/cli');

describe('config file under real Playwright workers', () => {
  it('bothWorkersSeeTheFileLevel_whileConfigureInGlobalSetupDoesNotReachThem', () => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-probe-'));
    try {
      const env = { ...process.env, PROBE_DIR: probeDir, VOID_LOG_DIR: path.join(probeDir, 'logs') };
      for (const k of Object.keys(env)) if (k.startsWith('VOID_LOG_') && k !== 'VOID_LOG_DIR') delete (env as Record<string, unknown>)[k];
      // cwd is the fixture dir, so logger.config.ts is found by discovery (a .ts file, loaded by Playwright's transpiler).
      const r = spawnSync(process.execPath, [cli, 'test', '--config', 'playwright.config.ts'], { cwd: fixture, env, encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(0);

      const gs = JSON.parse(fs.readFileSync(path.join(probeDir, 'global-setup.json'), 'utf8'));
      expect(gs.level).toBe('error'); // runner process: configure() applied here only

      const a = JSON.parse(fs.readFileSync(path.join(probeDir, 'a.json'), 'utf8'));
      const b = JSON.parse(fs.readFileSync(path.join(probeDir, 'b.json'), 'utf8'));
      expect(a.pid).not.toBe(b.pid);
      expect(a.worker).not.toBe(b.worker);
      for (const w of [a, b]) {
        expect(w.level).toBe('debug'); // from logger.config.ts, not from globalSetup's configure()
        expect(w.redactKeys).toEqual(['pin']);
      }
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  }, 60_000);
});
