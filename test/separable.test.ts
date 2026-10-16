import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAllFiles, config, configure, info, resetConfig, runIdMissing, setTestContext } from '../src';

let tmp: string;
let out: string[];
let err: string[];
const SAVED = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('VOID_')) delete process.env[k];
  delete process.env.TEST_WORKER_INDEX;
  resetConfig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-sep-'));
  configure({ logDir: tmp, ansi: false, githubAnnotations: false, tsFormat: () => 'TS' });
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  setTestContext(undefined);
  closeAllFiles();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  resetConfig();
});

const lines = (): string[] => out.join('').split('\n').filter(Boolean);

describe('consoleWorker', () => {
  it('offByDefault_consoleLinesUnchanged', () => {
    process.env.TEST_WORKER_INDEX = '3';
    process.env.VOID_RUN_ID = 'r';
    info.log('hello');
    expect(lines()).toEqual(['TS │ INFO │ hello']);
  });

  it('on_prefixesEveryLineWithTheWorker', () => {
    process.env.TEST_WORKER_INDEX = '3';
    process.env.VOID_RUN_ID = 'r';
    configure({ consoleWorker: true });
    info.log('a\nb');
    expect(lines()).toEqual(['w3 │ TS │ INFO │ a', 'w3 │ TS │ INFO │ b']);
  });

  it('outsidePlaywright_isMain', () => {
    configure({ consoleWorker: true });
    info.log('x');
    expect(lines()).toEqual(['main │ TS │ INFO │ x']);
  });

  it('githubAnnotations_carryThePrefixToo', () => {
    configure({ consoleWorker: true, githubAnnotations: true });
    info.failed('boom');
    expect(lines()).toContain('::error::main │ TS │ boom');
  });

  it('filesAreUnaffected', () => {
    configure({ consoleWorker: true, consoleTest: true });
    setTestContext('file > suite > t1', 't1');
    info.log('x');
    const dir = path.join(tmp, fs.readdirSync(tmp)[0]!, 'partial-trace');
    const text = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), 'utf8');
    expect(text).toBe('main │ TS │ INFO │ x\n');
  });
});

describe('consoleTest', () => {
  it('offByDefault', () => {
    setTestContext('file > t1', 't1');
    info.log('x');
    expect(lines()).toEqual(['TS │ INFO │ x']);
  });

  it('on_prefixesWithTheTestTitle_afterTheWorker', () => {
    configure({ consoleWorker: true, consoleTest: true });
    setTestContext('file > suite > logs in', 'logs in');
    info.log('x');
    expect(lines()).toEqual(['main │ logs in │ TS │ INFO │ x']);
  });

  it('noTestRunning_noTestSegment', () => {
    configure({ consoleTest: true });
    info.log('x');
    expect(lines()).toEqual(['TS │ INFO │ x']);
  });

  it('longTitles_truncateTo40Chars', () => {
    configure({ consoleTest: true });
    const title = 'a'.repeat(60);
    setTestContext(title);
    info.log('x');
    expect(lines()).toEqual([`${'a'.repeat(37)}... │ TS │ INFO │ x`]);
  });

  it('titleDefaultsToTheFullPath_andLineBreaksAreFlattened', () => {
    configure({ consoleTest: true });
    setTestContext('two\nlines');
    info.log('x');
    expect(lines()).toEqual(['two lines │ TS │ INFO │ x']);
  });
});

describe('missing initRun() in a worker', () => {
  it('runIdMissing_onlyInAWorkerWithoutVoidRunId', () => {
    expect(runIdMissing({})).toBe(false);
    expect(runIdMissing({ TEST_WORKER_INDEX: '0' })).toBe(true);
    expect(runIdMissing({ TEST_WORKER_INDEX: '0', VOID_RUN_ID: 'r' })).toBe(false);
  });

  it('warnsOncePerProcess_atTheFirstFileWrite', () => {
    process.env.TEST_WORKER_INDEX = '1';
    info.log('a');
    info.log('b');
    const warnings = err.filter((e) => e.includes('VOID_RUN_ID is not set'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('w1:');
    expect(warnings[0]).toContain('initRun()');
  });

  it('noWarning_whenTheRunIdIsShared_orOutsidePlaywright', () => {
    info.log('main process');
    process.env.TEST_WORKER_INDEX = '1';
    process.env.VOID_RUN_ID = 'r';
    info.log('worker with initRun');
    expect(err.join('')).not.toContain('VOID_RUN_ID');
  });

  it('noWarning_whenNoFileSinkIsOn', () => {
    process.env.TEST_WORKER_INDEX = '1';
    configure({ files: { debugTrace: false, partialTrace: false, fullTrace: false } });
    info.log('console only');
    expect(err.join('')).toBe('');
  });
});

describe('configure() validation', () => {
  it('unknownKey_warnsAndIsSkipped_restStillApplies', () => {
    configure({ levl: 'debug', level: 'warn' } as never);
    expect(err.join('')).toContain("configure() has an unknown option 'levl'");
    expect('levl' in config()).toBe(false);
    expect(config().level).toBe('warn');
  });

  it('wrongType_warnsAndKeepsThePreviousValue', () => {
    configure({ level: 'verbose' } as never);
    expect(err.join('')).toContain("configure(): option 'level' must be one of");
    expect(config().level).toBe('info');
  });

  it('badFilesEntry_dropsOnlyThatEntry', () => {
    configure({ files: { jsonl: true, debugTrace: 'yes', bogus: true } } as never);
    expect(config().files.jsonl).toBe(true);
    expect(config().files.debugTrace).toBe(true);
    expect('bogus' in config().files).toBe(false);
    expect(err.join('')).toContain("'files.debugTrace'");
    expect(err.join('')).toContain("'files.bogus'");
  });

  it('sameProblem_warnsOnce', () => {
    for (let i = 0; i < 5; i++) configure({ levl: 'x' } as never);
    expect(err.filter((e) => e.includes("'levl'"))).toHaveLength(1);
  });

  it('neverThrows_evenForANonObject', () => {
    expect(() => configure(null as never)).not.toThrow();
    expect(() => configure('debug' as never)).not.toThrow();
    expect(err.join('')).toContain('configure() expects an object or a function');
  });

  it('validPatch_noWarning_andUndefinedIsIgnored', () => {
    configure({ level: 'debug', maxRuns: 3, consoleWorker: true, infoLogsCharLimit: undefined });
    expect(err.join('')).toBe('');
    expect(config().maxRuns).toBe(3);
  });

  it('callback_unknownKey_warnsAndIsRemoved', () => {
    configure((c) => void ((c as unknown as Record<string, unknown>).levl = 'debug'));
    expect(err.join('')).toContain("configure() callback has an unknown option 'levl'");
    expect('levl' in config()).toBe(false);
  });

  it('callback_wrongType_warnsAndIsRevertedToThePreviousValue', () => {
    configure({ level: 'warn' });
    configure((c) => {
      (c as unknown as Record<string, unknown>).level = 'verbose';
      c.console = false; // a valid change in the same callback still applies
    });
    expect(err.join('')).toContain("configure() callback: option 'level' must be one of");
    expect(config().level).toBe('warn');
    expect(config().console).toBe(false);
  });

  it('callback_badFilesEntry_isRevertedOrRemoved', () => {
    configure((c) => {
      (c.files as unknown as Record<string, unknown>).debugTrace = 'yes';
      (c.files as unknown as Record<string, unknown>).bogus = true;
      c.files.jsonl = true;
    });
    expect(config().files.debugTrace).toBe(true);
    expect('bogus' in config().files).toBe(false);
    expect(config().files.jsonl).toBe(true);
  });

  it('callback_arrayForASetOption_becomesASet', () => {
    configure((c) => void ((c as unknown as Record<string, unknown>).suppressContains = ['vendor']));
    expect(config().suppressContains).toBeInstanceOf(Set);
    expect([...config().suppressContains]).toEqual(['vendor']);
    expect(err.join('')).toBe('');
  });

  it('callback_validChanges_noWarning', () => {
    configure((c) => {
      c.level = 'debug';
      c.redactKeys.push('pin');
      c.recentRunMinutes = 5;
    });
    expect(err.join('')).toBe('');
    expect(config().redactKeys).toContain('pin');
  });
});

describe('configure() validation of the 0.4.0 options', () => {
  it('wrongTypes_forNewOptions_warnAndAreSkipped', () => {
    configure({ recentRunMinutes: -5, redactText: 'yes', files: { tables: 1 } } as never);
    const text = err.join('');
    expect(text).toContain("option 'recentRunMinutes' must be a number >= 0");
    expect(text).toContain("option 'redactText' must be a boolean");
    expect(text).toContain("'files.tables'");
    expect(config().recentRunMinutes).toBe(60);
    expect(config().redactText).toBe(true);
    expect(config().files.tables).toBe(true);
  });

  it('checkPatch_reportsTheKeyOfEachProblem', async () => {
    const { checkPatch } = await import('../src/configFile');
    const { problems } = checkPatch({ levl: 1, level: 'x', files: { bogus: true } }, 'test');
    expect(problems.map((p) => p.key)).toEqual(['levl', 'level', 'files.bogus']);
  });
});
