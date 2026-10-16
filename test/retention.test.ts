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

describe('recent runs', () => {
  it('maxLogFiles_neverDeletesARunWrittenToInTheLastHour', () => {
    const live = seed('2030-01-10', 'partial-trace', ['partial-trace-other-run-w0.log'], [0.01])[0]!; // ~15 min old
    const old = seed('2030-01-01', 'partial-trace', ['partial-trace-r1-main.log'], [9])[0]!;
    configure({ maxLogFiles: 1 });
    info.log('now');
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('aRunCountsAsRecentByItsNewestFile', () => {
    // w0 stopped writing long ago, but w1 of the same run wrote recently: the whole run stays.
    const [w0, w1] = seed('2030-01-09', 'partial-trace', ['partial-trace-other-w0.log', 'partial-trace-other-w1.log'], [3, 0.01]);
    configure({ maxLogFiles: 1 });
    info.log('now');
    expect(fs.existsSync(w0!)).toBe(true);
    expect(fs.existsSync(w1!)).toBe(true);
  });
});

describe('recentRunMinutes', () => {
  const MIN = 1 / (24 * 60); // one minute, in seed()'s day units

  it('aSmallerWindow_letsOlderRunsGo', () => {
    const [fresh, older] = [
      seed('2030-01-10', 'partial-trace', ['partial-trace-fresh-w0.log'], [2 * MIN])[0]!,
      seed('2030-01-10', 'partial-trace', ['partial-trace-older-w0.log'], [15 * MIN])[0]!,
    ];
    configure({ maxRuns: 1, recentRunMinutes: 5 });
    info.log('now');
    expect(fs.existsSync(fresh)).toBe(true); // 2 min old, inside the 5-minute window
    expect(fs.existsSync(older)).toBe(false); // 15 min old: protected by the default 60, not by 5
  });

  it('zero_turnsTheGuardOff_onlyTheCurrentRunIsKept', () => {
    const fresh = seed('2030-01-10', 'partial-trace', ['partial-trace-fresh-w0.log'], [MIN])[0]!;
    configure({ maxRuns: 1, recentRunMinutes: 0 });
    info.log('now');
    expect(fs.existsSync(fresh)).toBe(false);
    expect(names('partial-trace')).toEqual(['partial-trace-current-run-main.log']);
  });

  it('default_is60', () => {
    expect(resetConfig().recentRunMinutes).toBe(60);
  });

  it('env_setsIt_invalidIgnored', () => {
    process.env.VOID_LOG_RECENT_RUN_MINUTES = '10';
    expect(resetConfig().recentRunMinutes).toBe(10);
    process.env.VOID_LOG_RECENT_RUN_MINUTES = '0';
    expect(resetConfig().recentRunMinutes).toBe(0);
    process.env.VOID_LOG_RECENT_RUN_MINUTES = 'soon';
    expect(resetConfig().recentRunMinutes).toBe(60);
  });

  it('configFile_rejectsNegativeOrNonNumbers', async () => {
    const { loadConfigFile } = await import('../src/configFile');
    const load = (name: string, value: unknown): unknown => {
      const f = path.join(tmp, name);
      fs.writeFileSync(f, JSON.stringify({ recentRunMinutes: value }));
      return loadConfigFile({ VOID_LOG_CONFIG: f }, tmp);
    };
    expect(load('r1.json', 15)).toEqual({ recentRunMinutes: 15 });
    expect(() => load('r2.json', -1)).toThrow(/recentRunMinutes/);
    expect(() => load('r3.json', '15')).toThrow(/recentRunMinutes/);
  });
});

describe('maxRuns', () => {
  it('keepsTheNewestNRuns_includingTheCurrentOne_deletingWholeRuns', () => {
    const r1 = seed('2030-01-01', 'partial-trace', ['partial-trace-r1-w0.log', 'partial-trace-r1-w1.log'], [9, 9]);
    const r2 = seed('2030-01-05', 'partial-trace', ['partial-trace-r2-w0.log', 'partial-trace-r2-w1.log', 'partial-trace-r2-w2.log'], [5, 5, 5]);
    configure({ maxRuns: 2 });
    info.log('now');
    for (const f of r2) expect(fs.existsSync(f)).toBe(true);
    for (const f of r1) expect(fs.existsSync(f)).toBe(false);
    expect(names('partial-trace')).toHaveLength(4); // all of r2 + current
  });

  it('runAge_isItsNewestFile', () => {
    // r1 has an old file and a newer one; r2's only file sits between them. r1 is the newer run.
    const r1 = seed('2030-01-01', 'partial-trace', ['partial-trace-r1-w0.log', 'partial-trace-r1-w1.log'], [9, 2]);
    const r2 = seed('2030-01-04', 'partial-trace', ['partial-trace-r2-w0.log'], [5]);
    configure({ maxRuns: 2 });
    info.log('now');
    for (const f of r1) expect(fs.existsSync(f)).toBe(true);
    expect(fs.existsSync(r2[0]!)).toBe(false);
  });

  it('runIdsContainingDashes_groupCorrectly', () => {
    const run = seed('2030-01-01', 'partial-trace', ['partial-trace-20300101-101010-001-pid4-w0.log', 'partial-trace-20300101-101010-001-pid4-w1.log'], [9, 9]);
    const newer = seed('2030-01-02', 'partial-trace', ['partial-trace-20300102-101010-001-pid5-main.log'], [8])[0]!;
    configure({ maxRuns: 2 });
    info.log('now');
    expect(fs.existsSync(newer)).toBe(true);
    for (const f of run) expect(fs.existsSync(f)).toBe(false);
  });

  it('withMaxLogFiles_aFileGoesIfEitherLimitSaysSo', () => {
    const [a, b] = seed('2030-01-05', 'partial-trace', ['partial-trace-r2-w0.log', 'partial-trace-r2-w1.log'], [5, 5]);
    configure({ maxRuns: 5, maxLogFiles: 2 }); // maxRuns keeps r2 whole; maxLogFiles keeps current + 1 other file
    info.log('now');
    expect([a, b].filter((f) => fs.existsSync(f!))).toHaveLength(1);
  });

  it('nullOrZero_keepsEverything', () => {
    for (const v of [null, 0]) {
      seed('2030-01-01', 'partial-trace', [`partial-trace-old${v}-main.log`], [5]);
      configure({ maxRuns: v });
      info.log('x');
      closeAllFiles();
    }
    expect(names('partial-trace')).toHaveLength(3);
  });

  it('env_setsItAndZeroDisables_invalidIgnored', () => {
    process.env.VOID_LOG_MAX_RUNS = '4';
    expect(resetConfig().maxRuns).toBe(4);
    process.env.VOID_LOG_MAX_RUNS = '0';
    expect(resetConfig().maxRuns).toBeNull();
    process.env.VOID_LOG_MAX_RUNS = 'lots';
    expect(resetConfig().maxRuns).toBeNull();
  });
});

describe('worker without a shared run id', () => {
  it('skipsRetention_soSiblingWorkersFilesSurvive', () => {
    delete process.env.VOID_RUN_ID;
    process.env.TEST_WORKER_INDEX = '0';
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    try {
      // A sibling worker's live file has a different (pid-based) run id, so it would look like an older run.
      const sibling = seed('2030-01-10', 'partial-trace', ['partial-trace-20300110-090000-000-pid99-w1.log'], [2])[0]!;
      configure({ maxLogFiles: 1, maxRuns: 1 });
      info.log('now');
      expect(fs.existsSync(sibling)).toBe(true);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('log retention is off'));
    } finally {
      delete process.env.TEST_WORKER_INDEX;
    }
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
