import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSink,
  captureLogs,
  closeAllFiles,
  configure,
  debug,
  detectAnsiSupport,
  error,
  fields,
  info,
  initRun,
  removeSink,
  resetConfig,
  stripAnsi,
  warn,
  type LogEvent,
  type Sink,
} from '../src';
import { rgbFg, sgr } from '../src/ansi';
import { formatTs } from '../src/config';
import { resolveStyle } from '../src/theme';

let tmp: string;
let out: string[];

beforeEach(() => {
  resetConfig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-'));
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
  delete process.env.TEST_WORKER_INDEX;
  delete process.env.VOID_RUN_ID;
  delete process.env.VOID_RUN_DATE;
});

const lines = (): string[] => out.join('').split('\n').filter(Boolean);

function readTrace(kind: string): string {
  const dir = path.join(tmp, fs.readdirSync(tmp)[0]!, kind);
  const files = fs.readdirSync(dir);
  return fs.readFileSync(path.join(dir, files[0]!), 'utf8');
}

describe('ansi + theme', () => {
  it('sgr_multipleCodes_joinsWithSemicolon', () => {
    expect(sgr(38, 5, 208, 1)).toBe('\u001b[38;5;208;1m');
  });

  it('rgbFg_outOfRange_throws', () => {
    expect(() => rgbFg(256, 0, 0)).toThrow(RangeError);
  });

  it('stripAnsi_coloredText_returnsPlain', () => {
    expect(stripAnsi('\u001b[1m\u001b[38;2;1;2;3mhi\u001b[0m')).toBe('hi');
  });

  it('resolveStyle_errorBase_usesErrorFgOnBlackBg', () => {
    const s = resolveStyle('ERROR', 'BASE');
    expect(s).toContain('38;2;210;48;48');
    expect(s.endsWith('\u001b[40m')).toBe(true);
  });

  it('resolveStyle_successIntent_ignoresLevelForeground', () => {
    expect(resolveStyle('WARN', 'SUCCESS')).toBe(resolveStyle('ERROR', 'SUCCESS'));
  });
});

describe('console output', () => {
  it('log_plainMessage_printsTsLabelMessage', () => {
    info.log('hello');
    expect(lines()).toEqual(['TS │ INFO │ hello']);
  });

  it('click_ansiOn_wrapsLineInThemeStyleAndReset', () => {
    configure({ ansi: true });
    info.click('Submit');
    const line = lines()[0]!;
    expect(line.startsWith(resolveStyle('INFO', 'INTERACTION'))).toBe(true);
    expect(line.endsWith('\u001b[0m')).toBe(true);
    expect(stripAnsi(line)).toBe('TS │ CLICK [>] │ Submit');
  });

  it('multilineMessage_eachLineGetsOwnPrefix', () => {
    info.log('a\nb\r\nc');
    expect(lines()).toEqual(['TS │ INFO │ a', 'TS │ INFO │ b', 'TS │ INFO │ c']);
  });

  it('password_masksValueAndKeepsLabel', () => {
    info.password('hunter2', 'login');
    expect(lines()[0]).toBe('TS │ PASSWORD [**] │ ******* | login');
  });

  it('actions_coverAllIntentLabels', () => {
    info.navigate('x');
    info.wait('x');
    info.verifying('x');
    info.success('x');
    info.failed('x');
    info.grid('x');
    const labels = lines().map((l) => l.split(' │ ')[1]);
    expect(labels).toEqual(['NAVIGATE [=>]', 'WAIT [~]', 'VERIFY [?]', 'SUCCESS [+]', 'FAILED [x]', 'GRID [#]']);
  });
});

describe('level filtering', () => {
  it('debugBelowRootLevel_hiddenFromConsoleButKeptInDebugTrace', () => {
    configure({ level: 'info' });
    debug.log('quiet');
    warn.log('loud');
    expect(lines()).toEqual(['TS │ WARN │ loud']);
    expect(readTrace('debug-trace')).toContain('quiet');
    expect(readTrace('full-trace')).toContain('quiet');
    expect(readTrace('partial-trace')).not.toContain('quiet');
  });

  it('levelOff_silencesConsoleAndPartialTrace', () => {
    configure({ level: 'off' });
    error.log('x');
    expect(lines()).toEqual([]);
  });
});

describe('structured output', () => {
  it('tree_headingAndFields_rendersBranches', () => {
    info.log('Request', fields('method', 'POST', 'timeout', 5000));
    expect(lines()).toEqual([
      'TS │ INFO │ Request',
      'TS │ INFO │           ├─ method      : POST',
      'TS │ INFO │           └─ timeout     : 5000',
    ]);
  });

  it('tree_plainObjectAndArrayValue_deepFormats', () => {
    info.log('R', { ids: [1, [2, 3]] });
    expect(lines()[1]).toContain('ids         : [1, [2, 3]]');
  });

  it('fields_oddArgumentCount_throws', () => {
    expect(() => fields('a', 1, 'b')).toThrow(TypeError);
  });

  it('table_rowsAndTitle_rendersAsciiGrid', () => {
    info.table(
      [
        { ID: 1, Name: 'Alice' },
        { ID: 2, Name: 'Bob' },
      ],
      'Users',
    );
    const body = lines().map((l) => l.replace(/^TS │ TABLE │ /, ''));
    expect(body[0]).toBe(''); // leading newline, as in the Java logger
    expect(body.slice(1)).toEqual([
      '+----+-------+',
      '|   Users    |',
      '+----+-------+',
      '| ID | Name  |',
      '+----+-------+',
      '| 1  | Alice |',
      '| 2  | Bob   |',
      '+----+-------+',
    ]);
  });

  it('table_cellLimit_truncatesWithEllipsis', () => {
    configure({ tableCellLimitEnabled: true, tableCellLimit: 8 });
    info.table({ K: 'abcdefghijklmnop' });
    expect(out.join('')).toContain('abcde...');
  });

  it('table_emptyRows_logsNoRowsMessage', () => {
    info.table([]);
    expect(lines()[0]).toBe('TS │ TABLE │ No rows to display.');
  });

  it('row_alignsKeys', () => {
    info.row({ a: 1, longer: 2 });
    expect(lines()).toEqual(['TS │ ROW │ a      : 1', 'TS │ ROW │ longer : 2']);
  });

  it('log_arrayOfMaps_rendersIndexedTables', () => {
    info.log([{ a: 1 }]);
    expect(out.join('')).toContain('  [0] ');
    expect(out.join('')).toContain('| a |');
  });

  it('log_headingWithPrimitive_rendersHeadingColonValue', () => {
    info.log('count', 3);
    expect(lines()[0]).toBe('TS │ LOG │ count: 3');
  });

  it('resolved_withFields_usesSuccessTreeLabel', () => {
    info.resolved('Locator', { role: 'button' });
    expect(lines()[0]).toBe('TS │ RESOLVED │ Locator');
  });

  it('redaction_sensitiveKeys_areMasked', () => {
    info.log('Login', { user: 'bob', password: 'hunter2', apiToken: 'abc' });
    const text = out.join('');
    expect(text).toContain('user        : bob');
    expect(text).toContain('password    : ***');
    expect(text).toContain('apiToken    : ***');
    expect(text).not.toContain('hunter2');
  });

  it('log_errorObject_printsStack', () => {
    error.log(new Error('boom'));
    expect(out.join('')).toContain('Error: boom');
  });
});

describe('caller + chain', () => {
  function loginFlow(): void {
    info.log('inside');
  }

  it('debugLevel_consoleShowsCalleeAndCaller', () => {
    configure({ level: 'debug' });
    loginFlow();
    const line = lines()[0]!;
    expect(line).toContain('│ inside │ ');
    expect(line).toContain('loginFlow');
    expect(line).toContain('←');
  });

  it('infoLevel_consoleHidesCallerButDebugTraceKeepsIt', () => {
    configure({ level: 'info' });
    loginFlow();
    expect(lines()[0]).toBe('TS │ INFO │ inside');
    expect(readTrace('debug-trace')).toContain('loginFlow');
  });

  it('fullTrace_includesChainSuffix', () => {
    loginFlow();
    const trace = readTrace('full-trace');
    expect(trace).toContain('[CHAIN]');
    expect(trace).toContain('loginFlow');
  });

  it('loggerOwnFrames_neverAppearInCaller', () => {
    configure({ level: 'debug' });
    loginFlow();
    expect(lines()[0]).not.toMatch(/actions|dispatch|core\./);
  });

  it('methodNamedLoginPrefixedWithLog_isNotSuppressed', () => {
    // Regression guard: the Java logger drops frames whose method starts with "log" (e.g. login()).
    configure({ level: 'debug' });
    loginFlow();
    expect(lines()[0]).toContain('loginFlow');
  });

  it('includeOnlyPackages_unmatchedFrames_dropped', () => {
    configure({ level: 'debug', includeOnlyPrefixes: ['no/such/path'] });
    loginFlow();
    expect(lines()[0]).toBe('TS │ INFO │ inside');
  });
});

describe('files', () => {
  it('partialTrace_writesPlainWorkerPrefixedLinesWithoutAnsi', () => {
    configure({ ansi: true });
    process.env.TEST_WORKER_INDEX = '3';
    info.click('Go');
    const text = readTrace('partial-trace');
    expect(text).toBe('w3 │ TS │ CLICK [>] │ Go\n');
    expect(text).not.toContain('\u001b');
  });

  it('files_defaultWorker_isMainAndRunIdIsInFileName', () => {
    info.log('x');
    const dir = path.join(tmp, fs.readdirSync(tmp)[0]!, 'partial-trace');
    expect(fs.readdirSync(dir)[0]).toMatch(/^partial-trace-.*-main\.log$/);
  });

  it('initRun_setsSharedRunIdEnvOnce', () => {
    const a = initRun();
    const b = initRun();
    expect(a.runId).toBe(b.runId);
    expect(process.env.VOID_RUN_ID).toBe(a.runId);
  });

  it('fileToggles_disabled_noFileCreated', () => {
    configure({ files: { debugTrace: false, partialTrace: false, fullTrace: false } });
    info.log('x');
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('jsonl_enabled_writesOneStructuredRecordPerCall', () => {
    configure({ files: { jsonl: true } });
    info.log('a\nb');
    const rec = JSON.parse(readTrace('jsonl').trim());
    expect(rec).toMatchObject({ level: 'INFO', label: 'INFO', message: 'a\nb', worker: 'main', visible: true });
  });

  it('consoleDisabled_stillWritesFiles', () => {
    configure({ console: false });
    info.log('quiet');
    expect(lines()).toEqual([]);
    expect(readTrace('partial-trace')).toContain('quiet');
  });
});

describe('config + sinks', () => {
  it('formatTs_javaStylePattern_formatsAllTokens', () => {
    const cfg = resetConfig();
    expect(formatTs(cfg, new Date(2026, 0, 2, 3, 4, 5, 6))).toBe('2026-01-02 03:04:05.006');
  });

  it('detectAnsiSupport_precedence_explicitThenNoColorThenForceColor', () => {
    expect(detectAnsiSupport({ VOID_LOG_ANSI: 'false', FORCE_COLOR: '1' }, true)).toBe(false);
    expect(detectAnsiSupport({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false);
    expect(detectAnsiSupport({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(detectAnsiSupport({}, true)).toBe(true);
    expect(detectAnsiSupport({ TERM: 'dumb' }, false)).toBe(false);
    expect(detectAnsiSupport({ GITHUB_ACTIONS: 'true' }, false)).toBe(true);
  });

  it('githubAnnotations_errorAndWarn_emitWorkflowCommands', () => {
    configure({ githubAnnotations: true });
    error.log('bad\n100%');
    warn.log('careful');
    info.log('fine');
    const cmds = lines().filter((l) => l.startsWith('::'));
    expect(cmds).toEqual(['::error::TS │ bad', '::error::TS │ 100%25', '::warning::TS │ careful']);
  });

  it('customSink_receivesEventAndCanBeRemoved', () => {
    const seen: LogEvent[] = [];
    const sink: Sink = { accepts: () => true, write: (ev) => void seen.push(ev) };
    addSink(sink);
    info.success('ok');
    removeSink(sink);
    info.success('ignored');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ level: 'INFO', intent: 'SUCCESS', label: 'SUCCESS [+]', message: 'ok' });
  });

  it('failingSink_neverThrowsIntoCaller', () => {
    const sink: Sink = {
      accepts: () => true,
      write: () => {
        throw new Error('disk full');
      },
    };
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    addSink(sink);
    expect(() => info.log('x')).not.toThrow();
    removeSink(sink);
    expect(errSpy).toHaveBeenCalled();
  });

  it('captureLogs_collectsPlainLinesUntilStopped', () => {
    configure({ ansi: true });
    const cap = captureLogs();
    info.click('a');
    const text = cap.stop();
    info.click('b');
    expect(text).toBe('TS │ CLICK [>] │ a');
    expect(cap.text()).toBe('TS │ CLICK [>] │ a');
  });
});
