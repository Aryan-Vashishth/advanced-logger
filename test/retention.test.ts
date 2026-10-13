import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAllFiles, configure, info, resetConfig } from '../src';

let tmp: string;
const SAVED = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('VOID_')) delete process.env[k];
  resetConfig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-ret-'));
  configure({ logDir: tmp, ansi: false, console: false, githubAnnotations: false });
  process.env.VOID_RUN_ID = 'current-run';
  process.env.VOID_RUN_DATE = '2030-01-10';
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeAllFiles();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  resetConfig();
});

/** Seed `count` old files in a kind folder, file i being i days older than the next. */
function seed(day: string, kind: string, names: string[], ageDays: number[]): string[] {
  const dir = path.join(tmp, day, kind);
  fs.mkdirSync(dir, { recursive: true });
  return names.map((n, i) => {
    const f = path.join(dir, n);
    fs.writeFileSync(f, 'old\n');
    const t = new Date(Date.now() - ageDays[i]! * 86_400_000);
    fs.utimesSync(f, t, t);
    return f;
  });
}

const names = (kind: string): string[] =>
  fs
    .readdirSync(tmp, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => (fs.existsSync(path.join(tmp, d.name, kind)) ? fs.readdirSync(path.join(tmp, d.name, kind)) : []))
    .sort();

describe('maxLogFiles', () => {
  it('unsetNullOrZero_keepsEverything', () => {
    for (const v of [null, 0]) {
      seed('2030-01-01', 'partial-trace', [`partial-trace-old${v}-main.log`], [5]);
      configure({ maxLogFiles: v });
      info.log('x');
      closeAllFiles();
    }
    expect(names('partial-trace')).toHaveLength(3);
  });

  it('keepsTheNewestN_deletesOlderAcrossDateFolders', () => {
    const [a, b, c] = [
      ...seed('2030-01-01', 'partial-trace', ['partial-trace-r1-main.log'], [9]),
      ...seed('2030-01-05', 'partial-trace', ['partial-trace-r2-main.log'], [5]),
      ...seed('2030-01-08', 'partial-trace', ['partial-trace-r3-main.log'], [2]),
    ];
    configure({ maxLogFiles: 2 });
    info.log('now'); // writes current-run file, then prunes
    // limit 2 = the current run's file + the single newest old file
    expect(fs.existsSync(c!)).toBe(true);
    expect(fs.existsSync(b!)).toBe(false);
    expect(fs.existsSync(a!)).toBe(false);
    expect(names('partial-trace')).toHaveLength(2);
  });

  it('removesEmptyDateFolders', () => {
    seed('2030-01-01', 'partial-trace', ['partial-trace-r1-main.log'], [9]);
    configure({ maxLogFiles: 1 });
    info.log('now');
    expect(fs.existsSync(path.join(tmp, '2030-01-01'))).toBe(false);
  });

  it('currentRunFiles_areNeverDeleted_evenOverTheLimit', () => {
    const peer = seed('2030-01-10', 'partial-trace', ['partial-trace-current-run-w1.log'], [0])[0]!;
    const old = seed('2030-01-01', 'partial-trace', ['partial-trace-r1-main.log'], [9])[0]!;
    configure({ maxLogFiles: 1 });
    info.log('now');
    expect(fs.existsSync(peer)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(names('partial-trace')).toHaveLength(2); // peer + this worker's file, over the limit of 1
  });

  it('eachKindIsCountedSeparately', () => {
    seed('2030-01-01', 'debug-trace', ['debug-trace-r1-main.log'], [9]);
    seed('2030-01-02', 'full-trace', ['full-trace-r1-main.log'], [8]);
    configure({ maxLogFiles: 2 });
    info.log('now');
    expect(names('debug-trace')).toHaveLength(2);
    expect(names('full-trace')).toHaveLength(2);
    expect(names('partial-trace')).toHaveLength(1);
  });

  it('jsonlIsPrunedToo', () => {
    seed('2030-01-01', 'jsonl', ['jsonl-r1-main.jsonl', 'jsonl-r2-main.jsonl'], [9, 8]);
    configure({ maxLogFiles: 1, files: { jsonl: true } });
    info.log('now');
    expect(names('jsonl')).toHaveLength(1);
    expect(names('jsonl')[0]).toContain('current-run');
  });

  it('foreignFilesAreLeftAlone', () => {
    const keep = seed('2030-01-01', 'partial-trace', ['notes.txt', 'partial-trace-r1-main.log.bak'], [9, 9]);
    configure({ maxLogFiles: 1 });
    info.log('now');
    for (const f of keep) expect(fs.existsSync(f)).toBe(true);
  });

  it('prunesOncePerProcess_notOnEveryWrite', () => {
    configure({ maxLogFiles: 1 });
    info.log('a');
    const extra = seed('2030-01-01', 'partial-trace', ['partial-trace-late-main.log'], [9])[0]!;
    info.log('b');
    expect(fs.existsSync(extra)).toBe(true);
  });
});

describe('maxLogFiles config surface', () => {
  it('env_setsItAndZeroDisables_invalidIgnored', () => {
    process.env.VOID_LOG_MAX_FILES = '7';
    expect(resetConfig().maxLogFiles).toBe(7);
    process.env.VOID_LOG_MAX_FILES = '0';
    expect(resetConfig().maxLogFiles).toBeNull();
    process.env.VOID_LOG_MAX_FILES = 'many';
    expect(resetConfig().maxLogFiles).toBeNull();
  });

  it('configFile_acceptsIntegersAndNull_rejectsOthers', async () => {
    const { loadConfigFile } = await import('../src/configFile');
    const load = (name: string, value: unknown): unknown => {
      const f = path.join(tmp, name);
      fs.writeFileSync(f, JSON.stringify({ maxLogFiles: value }));
      return loadConfigFile({ VOID_LOG_CONFIG: f }, tmp);
    };
    expect(load('m1.json', 5)).toEqual({ maxLogFiles: 5 });
    expect(load('m2.json', null)).toEqual({ maxLogFiles: null });
    expect(() => load('m3.json', 2.5)).toThrow(/maxLogFiles/);
    expect(() => load('m4.json', '5')).toThrow(/maxLogFiles/);
    expect(() => load('m5.json', -1)).toThrow(/maxLogFiles/);
  });
});
