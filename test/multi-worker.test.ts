import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const fixture = path.resolve(__dirname, 'fixtures/multi-worker');
const cli = require.resolve('@playwright/test/cli');

interface Probe {
  pid: number;
  worker: string;
  level: string;
  redactKeys: string[];
  runId: string;
}

/**
 * Run the fixture suite (2 workers) in a fresh dir, with one stale log file from an older run seeded in it.
 * The fixture's logger.config.ts sets consoleWorker, consoleTest and maxLogFiles: 1.
 */
function runFixture(initRun: boolean) {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-probe-'));
  const logDir = path.join(probeDir, 'logs');
  const stale = path.join(logDir, '2020-01-01', 'partial-trace', 'partial-trace-20200101-000000-000-pid1-w0.log');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, 'old\n');
  const t = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(stale, t, t);

  const env: Record<string, string | undefined> = { ...process.env, PROBE_DIR: probeDir, VOID_LOG_DIR: logDir, PROBE_INIT_RUN: initRun ? '1' : '0' };
  for (const k of Object.keys(env)) if (k.startsWith('VOID_') && k !== 'VOID_LOG_DIR') delete env[k];
  // cwd is the fixture dir, so logger.config.ts is found by discovery (a .ts file, loaded by Playwright's transpiler).
  const r = spawnSync(process.execPath, [cli, 'test', '--config', 'playwright.config.ts'], { cwd: fixture, env, encoding: 'utf8' });
  const read = (n: string): Probe => JSON.parse(fs.readFileSync(path.join(probeDir, `${n}.json`), 'utf8'));
  try {
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return {
      r,
      gs: JSON.parse(fs.readFileSync(path.join(probeDir, 'global-setup.json'), 'utf8')) as { level: string },
      a: read('a'),
      b: read('b'),
      staleSurvived: fs.existsSync(stale),
    };
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

// Three tests read the same initRun() run; spawn it once.
let withInit: ReturnType<typeof runFixture> | undefined;
const withInitRun = (): ReturnType<typeof runFixture> => (withInit ??= runFixture(true));

describe('real Playwright workers', () => {
  it('bothWorkersSeeTheFileLevel_whileConfigureInGlobalSetupDoesNotReachThem', () => {
    const { gs, a, b } = withInitRun();
    expect(gs.level).toBe('error'); // runner process: configure() applied here only
    expect(a.pid).not.toBe(b.pid);
    expect(a.worker).not.toBe(b.worker);
    for (const w of [a, b]) {
      expect(w.level).toBe('debug'); // from logger.config.ts, not from globalSetup's configure()
      expect(w.redactKeys).toEqual(['pin']);
    }
  }, 60_000);

  it('consoleLinesNameTheirWorkerAndTest', () => {
    const { r, a, b } = withInitRun();
    expect(r.stdout).toContain(`w${a.worker} │ worker sees the config file (a) │ `);
    expect(r.stdout).toContain(`w${b.worker} │ worker sees the config file (b) │ `);
    expect(r.stdout).toMatch(new RegExp(`w${a.worker} │ worker sees the config file \\(a\\) │ [^\\n]*│ probe a`));
  }, 60_000);

  it('withInitRun_workersShareOneRunId_noWarning_andRetentionRuns', () => {
    const { r, a, b, staleSurvived } = withInitRun();
    expect(a.runId).toBe(b.runId);
    expect(r.stdout + r.stderr).not.toContain('VOID_RUN_ID is not set');
    expect(staleSurvived).toBe(false);
  }, 60_000);

  it('withoutInitRun_eachWorkerWarnsOnce_andRetentionDeletesNothing', () => {
    const { r, a, b, staleSurvived } = runFixture(false);
    expect(a.runId).not.toBe(b.runId); // the split this guards against
    const out = r.stdout + r.stderr;
    expect(out.match(/VOID_RUN_ID is not set/g)).toHaveLength(2);
    expect(out).toContain(`w${a.worker}: VOID_RUN_ID is not set`);
    expect(out).toContain(`w${b.worker}: VOID_RUN_ID is not set`);
    expect(staleSurvived).toBe(true);
  }, 60_000);
});
