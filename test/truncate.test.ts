import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLogs, closeAllFiles, config, configure, debug, error, info, resetConfig, warn } from '../src';

let tmp: string;
let out: string[];
const SAVED = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('VOID_LOG_')) delete process.env[k];
  resetConfig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-trunc-'));
  configure({ logDir: tmp, ansi: false, githubAnnotations: false, tsFormat: () => 'TS' });
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeAllFiles();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  resetConfig();
});

const lines = (): string[] => out.join('').split('\n').filter(Boolean);
const trace = (kind: string): string => {
  const dir = path.join(tmp, fs.readdirSync(tmp)[0]!, kind);
  return fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), 'utf8');
};
const LONG = 'x'.repeat(259);

describe('infoLogsCharLimit', () => {
  it('unset_logsWholeTextWithNoExtraLines', () => {
    info.log(LONG);
    expect(lines()).toEqual([`TS │ INFO │ ${LONG}`]);
  });

  it.each([null, 0])('%s_meansNoLimit', (v) => {
    configure({ infoLogsCharLimit: v });
    info.log(LONG);
    expect(lines()).toEqual([`TS │ INFO │ ${LONG}`]);
  });

  it('overLimit_truncatesWithCharCountThenWarnsThenLogsFullAtDebug', () => {
    configure({ infoLogsCharLimit: 50, level: 'debug' });
    info.log(LONG);
    const l = lines().map((x) => x.replace(/ │ truncate.test.*$/, ''));
    expect(l[0]).toBe(`TS │ INFO │ ${'x'.repeat(50)}... (259 chars)`);
    expect(l[1]).toContain('TS │ WARN │ INFO log exceeded the 50 char threshold (259 chars). Refer to the debug logs');
    expect(l[1]).toContain('passed to configure()');
    expect(l[2]).toContain(`TS │ DEBUG │ ${LONG}`);
    expect(l).toHaveLength(3);
  });

  it('atInfoLevel_consoleShowsTruncatedAndWarn_fullTextOnlyInDebugTrace', () => {
    configure({ infoLogsCharLimit: 50 });
    info.log(LONG);
    const l = lines();
    expect(l).toHaveLength(2);
    expect(l[0]).toBe(`TS │ INFO │ ${'x'.repeat(50)}... (259 chars)`);
    expect(l[1]).toContain('WARN');
    expect(out.join('')).not.toContain(LONG);
    expect(trace('debug-trace')).toContain(`DEBUG │ ${LONG}`);
    expect(trace('full-trace')).toContain(`DEBUG │ ${LONG}`);
    expect(trace('partial-trace')).not.toContain(LONG);
  });

  it('exactlyAtLimit_isNotTruncated', () => {
    configure({ infoLogsCharLimit: 259 });
    info.log(LONG);
    expect(lines()).toEqual([`TS │ INFO │ ${LONG}`]);
  });

  it('actionsKeepTheirLabel_inAllThreeLines', () => {
    configure({ infoLogsCharLimit: 10, level: 'debug' });
    info.click(LONG);
    const text = out.join('');
    expect(text).toContain('CLICK [>] │ xxxxxxxxxx... (259 chars)');
    expect(text.match(/CLICK \[>\]/g)).toHaveLength(2); // truncated INFO + full DEBUG copy
  });

  it('otherLevelsAndTables_areNeverTruncated', () => {
    configure({ infoLogsCharLimit: 10 });
    warn.log(LONG);
    error.log(LONG);
    debug.log(LONG);
    info.table([{ Col: LONG }]);
    const text = out.join('');
    expect(text.split(LONG).length - 1).toBeGreaterThanOrEqual(3);
    expect(text).not.toContain('chars)');
  });

  it('infoHiddenByRootLevel_isLeftAloneSoNoPointlessWarn', () => {
    configure({ infoLogsCharLimit: 10, level: 'warn' });
    info.log(LONG);
    expect(out).toEqual([]);
    expect(trace('debug-trace')).toContain(LONG);
    expect(trace('debug-trace')).not.toContain('chars)');
  });

  it('capture_getsTheTruncatedLineAndWarn', () => {
    configure({ infoLogsCharLimit: 10 });
    const cap = captureLogs();
    info.log(LONG);
    const text = cap.stop();
    expect(text).toContain('xxxxxxxxxx... (259 chars)');
    expect(text).toContain('WARN');
  });

  it('shortMessagesStillPass', () => {
    configure({ infoLogsCharLimit: 50 });
    info.log('short');
    expect(lines()).toEqual(['TS │ INFO │ short']);
  });
});

describe('infoLogsCharLimit config surface', () => {
  it('env_setsItAndZeroDisables_invalidIgnored', () => {
    process.env.VOID_LOG_INFO_LOGS_CHAR_LIMIT = '120';
    expect(resetConfig().infoLogsCharLimit).toBe(120);
    process.env.VOID_LOG_INFO_LOGS_CHAR_LIMIT = '0';
    expect(resetConfig().infoLogsCharLimit).toBeNull();
    process.env.VOID_LOG_INFO_LOGS_CHAR_LIMIT = 'abc';
    expect(resetConfig().infoLogsCharLimit).toBeNull();
    process.env.VOID_LOG_INFO_LOGS_CHAR_LIMIT = '';
    expect(resetConfig().infoLogsCharLimit).toBeNull();
  });

  it('configFile_value_isValidated', async () => {
    const { loadConfigFile } = await import('../src/configFile');
    const f = path.join(tmp, 'c1.json');
    fs.writeFileSync(f, JSON.stringify({ infoLogsCharLimit: 80 }));
    const loaded = loadConfigFile({ VOID_LOG_CONFIG: f }, tmp);
    expect(loaded).toEqual({ infoLogsCharLimit: 80 });
    const f2 = path.join(tmp, 'c2.json');
    fs.writeFileSync(f2, JSON.stringify({ infoLogsCharLimit: '80' }));
    expect(() => loadConfigFile({ VOID_LOG_CONFIG: f2 }, tmp)).toThrow(/infoLogsCharLimit/);
    expect(config().infoLogsCharLimit).toBeNull();
  });
});

describe('warning says where to raise the limit', () => {
  const warnText = (): string => out.join('').split('\n').find((l) => l.includes('WARN'))!;
  const reset = (): void => void configure({ logDir: tmp, ansi: false, githubAnnotations: false, tsFormat: () => 'TS' });

  it('fromConfigFile_namesTheFileAndItsPath', () => {
    const f = path.join(tmp, 'hint1.json');
    fs.writeFileSync(f, JSON.stringify({ infoLogsCharLimit: 20 }));
    process.env.VOID_LOG_CONFIG = f;
    resetConfig();
    reset();
    info.log(LONG);
    expect(warnText()).toContain(`change infoLogsCharLimit in ${f}.`);
  });

  it('fromEnv_namesTheVariable_notTheFile', () => {
    const f = path.join(tmp, 'hint2.json');
    fs.writeFileSync(f, JSON.stringify({ infoLogsCharLimit: 20 }));
    process.env.VOID_LOG_CONFIG = f;
    process.env.VOID_LOG_INFO_LOGS_CHAR_LIMIT = '30';
    resetConfig();
    reset();
    info.log(LONG);
    expect(warnText()).toContain('VOID_LOG_INFO_LOGS_CHAR_LIMIT environment variable');
    expect(warnText()).not.toContain(f);
  });

  it('configureOverridingTheFile_pointsAtConfigure', () => {
    const f = path.join(tmp, 'hint3.json');
    fs.writeFileSync(f, JSON.stringify({ infoLogsCharLimit: 20 }));
    process.env.VOID_LOG_CONFIG = f;
    resetConfig();
    configure({ infoLogsCharLimit: 10 });
    reset();
    info.log(LONG);
    expect(warnText()).toContain('passed to configure()');
  });
});
