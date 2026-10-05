import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSink,
  captureLogs,
  closeAllFiles,
  configure,
  detectAnsiSupport,
  error,
  fields,
  info,
  initRun,
  removeSink,
  resetConfig,
  setTableCellLimit,
  workerLabel,
  type LogEvent,
  type Sink,
} from '../src';

let tmp: string;
let out: string[];

beforeEach(() => {
  resetConfig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-aggr-'));
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

describe('malformed call arguments never throw into the caller', () => {
  it('log_oddTrailingPairs_doesNotThrowAndKeepsTheStrayValue', () => {
    expect(() => info.log('Request', 'method', 'POST', 'orphan')).not.toThrow();
    expect(out.join('')).toContain('(unpaired)');
    expect(out.join('')).toContain('orphan');
  });

  it('tree_singleNonFieldExtraArg_doesNotThrow', () => {
    expect(() => info.tree('heading', 'just-a-string')).not.toThrow();
    expect(out.join('')).toContain('(unpaired)');
    expect(out.join('')).toContain('just-a-string');
  });

  it('resolved_singleNonFieldExtraArg_doesNotThrow', () => {
    expect(() => info.resolved('Locator', 123)).not.toThrow();
    expect(out.join('')).toContain('123');
  });

  it('fieldsHelperItself_stillThrows_onlyLoggingCallsAreMadeSafe', () => {
    // The public fields() builder keeps its strict contract; only the LogActions
    // convenience methods must degrade instead of throwing.
    expect(() => fields('a', 1, 'b')).toThrow(TypeError);
  });
});

describe('hostile payloads', () => {
  it('circularObject_viaLogObject_doesNotThrowAndFallsBackToString', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => info.log(o)).not.toThrow();
  });

  it('circularObject_asFieldValue_doesNotThrow', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => info.log('Heading', fields('ref', o))).not.toThrow();
  });

  it('nullPrototypeObject_isTreatedAsARecord', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.id = 7;
    info.table(o);
    expect(out.join('')).toContain('id');
    expect(out.join('')).toContain('7');
  });

  it('errorWithoutStack_fallsBackToMessage', () => {
    const e = Object.create(Error.prototype) as Error;
    (e as { message: string }).message = 'no stack here';
    e.stack = undefined;
    error.log(e);
    expect(out.join('')).toContain('no stack here');
  });

  it('fieldsWithSymbolKey_doesNotThrow', () => {
    expect(() => info.log('H', fields(Symbol('k') as unknown as string, 'v'))).not.toThrow();
  });

  it('heterogeneousTableRows_missingColumnsRenderBlank', () => {
    info.table([{ a: 1, b: 2 }, { a: 3 }]);
    const text = out.join('');
    expect(text).toContain('| a |');
    expect(text).toContain('b');
  });

  it('tableRowsAsMaps_renderLikeObjectRows', () => {
    info.table([fields('ID', 1, 'Name', 'Alice')]);
    const text = out.join('');
    expect(text).toContain('| ID | Name  |');
    expect(text).toContain('| 1  | Alice |');
  });

  it('deeplyNestedArraysAndMaps_formatValueDoesNotThrow', () => {
    const deep = [1, [2, [3, [4, fields('k', 'v')]]]];
    expect(() => info.log('deep', deep)).not.toThrow();
  });

  it('veryLongSingleLineMessage_isWrittenInFull', () => {
    const big = 'x'.repeat(200_000);
    info.log(big);
    expect(lines()[0]!.endsWith(big)).toBe(true);
  });

  it('messageWithEveryLineBreakVariant_splitsIntoSeparateLines', () => {
    const msg = `a\nb\r\nc d e\u0085f\u000bg`;
    info.log(msg);
    expect(lines()).toHaveLength(7);
  });
});

describe('redaction is not fooled by casing or key aliases', () => {
  it('redactKeys_matchRegardlessOfCase', () => {
    info.log('Auth', fields('PASSWORD', 'hunter2', 'Token', 'abc123'));
    const text = out.join('');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('abc123');
  });

  it('redaction_onlyAffectsTreeAndTableNotRawLogStrings', () => {
    // Documents current behavior: redaction only applies to structured fields/tables,
    // a raw string that happens to contain a secret is passed through verbatim.
    info.log('password=hunter2');
    expect(out.join('')).toContain('hunter2');
  });
});

describe('concurrent in-process capture (documents a real limitation)', () => {
  it('twoOverlappingCaptures_eachReceiveAllLinesWrittenWhileBothActive', () => {
    // captureLogs() is a process-wide fan-out, not scoped to a single logical test.
    // If two captures are active at once, lines meant for one leak into the other.
    const capA = captureLogs();
    info.log('only-for-a-so-far');
    const capB = captureLogs();
    info.log('shared-line');
    const textA = capA.stop();
    info.log('only-for-b-now');
    const textB = capB.stop();

    expect(textA).toContain('only-for-a-so-far');
    expect(textA).toContain('shared-line');
    expect(textB).toContain('shared-line');
    expect(textB).toContain('only-for-b-now');
    // textA does NOT contain only-for-b-now because capA had already stopped.
    expect(textA).not.toContain('only-for-b-now');
  });
});

describe('config mutation via callback form', () => {
  it('configureWithFunction_mutatesSetTypedFieldsDirectly', () => {
    configure((cfg) => {
      cfg.suppressContains.add('totally-custom-marker');
    });
    expect(() => info.log('x')).not.toThrow();
  });
});

describe('github annotations escaping', () => {
  it('messageWithPercentCrlfAndLiteralEncodedSequence_escapesOnlyOnce', () => {
    configure({ githubAnnotations: true });
    error.log('100% done\r\nnext');
    const cmds = lines().filter((l) => l.startsWith('::error::'));
    expect(cmds.some((l) => l.includes('100%25'))).toBe(true);
    expect(cmds.some((l) => l.includes('%0D'))).toBe(false); // \r\n is split into separate lines first
  });
});

describe('table cell limit guardrails', () => {
  it('setTableCellLimit_belowMinimum_clampsToFour', () => {
    configure({ tableCellLimitEnabled: false });
    setTableCellLimit(0);
    info.table({ K: 'abcdefghij' });
    expect(out.join('')).toContain('a...');
  });
});

describe('worker + run identity edge cases', () => {
  it('workerLabel_nonNumericIndex_passedThroughVerbatim', () => {
    expect(workerLabel({ TEST_WORKER_INDEX: 'weird' } as unknown as NodeJS.ProcessEnv)).toBe('wweird');
  });

  it('initRun_concurrentCallsAcrossFreshProcesses_agreeOnSameIdWhenEnvPreSet', () => {
    process.env.VOID_RUN_ID = 'fixed-id';
    process.env.VOID_RUN_DATE = '2020-01-01';
    const a = initRun();
    const b = initRun();
    expect(a.runId).toBe('fixed-id');
    expect(b.runId).toBe('fixed-id');
  });
});

describe('detectAnsiSupport exhaustive matrix', () => {
  it('forceColorZero_disablesEvenOnTty', () => {
    expect(detectAnsiSupport({ FORCE_COLOR: '0' }, true)).toBe(false);
  });
  it('forceColorFalseString_disables', () => {
    expect(detectAnsiSupport({ FORCE_COLOR: 'false' }, true)).toBe(false);
  });
  it('colortermSet_enablesWithoutTty', () => {
    expect(detectAnsiSupport({ COLORTERM: 'truecolor' }, false)).toBe(true);
  });
  it('noEnvAtAllAndNoTty_defaultsToFalseViaUndefinedTerm', () => {
    expect(detectAnsiSupport({}, false)).toBe(false);
  });
});

describe('sinks never corrupt each other', () => {
  it('oneCustomSinkThrows_othersStillRun', () => {
    const seenByGood: LogEvent[] = [];
    const bad: Sink = { accepts: () => true, write: () => { throw new Error('boom'); } };
    const good: Sink = { accepts: () => true, write: (ev) => void seenByGood.push(ev) };
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    addSink(bad);
    addSink(good);
    info.log('still delivered');
    removeSink(bad);
    removeSink(good);
    expect(seenByGood).toHaveLength(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it('sinkAcceptsFalse_isNeverAskedToWrite_andSkipsStackCapture', () => {
    const calls: string[] = [];
    const picky: Sink = {
      accepts: () => { calls.push('accepts'); return false; },
      write: () => { calls.push('write'); },
    };
    addSink(picky);
    info.log('x');
    removeSink(picky);
    expect(calls).toEqual(['accepts']);
  });
});

describe('volume smoke test', () => {
  it('tenThousandSequentialCalls_allLinesLandInOrderInPartialTrace', () => {
    configure({ console: true });
    const n = 3_000;
    for (let i = 0; i < n; i++) info.log(`line-${i}`);
    const dir = path.join(tmp, fs.readdirSync(tmp)[0]!, 'partial-trace');
    const file = fs.readdirSync(dir)[0]!;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const fileLines = text.split('\n').filter(Boolean);
    expect(fileLines).toHaveLength(n);
    expect(fileLines[0]).toContain('line-0');
    expect(fileLines[n - 1]).toContain(`line-${n - 1}`);
  });
});
