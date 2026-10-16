import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSink,
  closeAllFiles,
  configure,
  error,
  info,
  removeSink,
  resetConfig,
  setTestContext,
  warn,
  type LogEvent,
  type Sink,
} from '../src';
import { nextTableFile, tableToCsv, tableToJson } from '../src/sinks';

let tmp: string;
let out: string[];
const SAVED = { ...process.env };
const DAY = '2030-02-01';

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('VOID_')) delete process.env[k];
  resetConfig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-tbl-'));
  process.env.VOID_RUN_ID = 'run1';
  process.env.VOID_RUN_DATE = DAY;
  configure({ logDir: tmp, ansi: false, githubAnnotations: false, tsFormat: () => 'TS' });
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
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

const attachments = (ext: 'csv' | 'json'): string[] => {
  // `<runId>-<worker>/<NNN>-<heading>.<ext>` paths, one folder per parent log
  const dir = path.join(tmp, DAY, 'attachments', ext);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .flatMap((folder) => fs.readdirSync(path.join(dir, folder)).map((f) => `${folder}/${f}`))
    .sort();
};
const readAttachment = (ext: 'csv' | 'json', rel: string): string =>
  fs.readFileSync(path.join(tmp, DAY, 'attachments', ext, ...rel.split('/')), 'utf8');
const lastJson = (): { title?: string; columns: string[]; rows: Array<Record<string, unknown>>; [k: string]: unknown } =>
  JSON.parse(readAttachment('json', attachments('json').at(-1)!));
const lastCsv = (): string => readAttachment('csv', attachments('csv').at(-1)!);
const trace = (kind: string): string => {
  const dir = path.join(tmp, DAY, kind);
  return fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), 'utf8');
};

describe('table attachments: where and what', () => {
  it('oneCsvAndOneJson_perTable_inTheDateFoldersAttachments', () => {
    info.table([{ id: 1, name: 'Ann' }], 'Users');
    expect(attachments('csv')).toHaveLength(1);
    expect(attachments('json')).toHaveLength(1);
    expect(attachments('csv')[0]!.replace('.csv', '')).toBe(attachments('json')[0]!.replace('.json', ''));
  });

  it('oneFolderPerParentLog_namedLikeItsTraceFiles_thenNumberAndHeading', () => {
    process.env.TEST_WORKER_INDEX = '3';
    info.table([{ a: 1 }], 'Users & Roles!');
    expect(attachments('csv')[0]).toMatch(/^run1-w3\/\d{3}-users-roles\.csv$/);
    expect(attachments('json')[0]).toMatch(/^run1-w3\/\d{3}-users-roles\.json$/);
    const traceName = fs.readdirSync(path.join(tmp, DAY, 'partial-trace'))[0]!;
    expect(traceName).toBe('partial-trace-run1-w3.log'); // its folder is this file's <runId>-<worker>
  });

  it('eachWorker_getsItsOwnFolder', () => {
    process.env.TEST_WORKER_INDEX = '0';
    info.table([{ a: 1 }], 'A');
    closeAllFiles();
    process.env.TEST_WORKER_INDEX = '1';
    info.table([{ a: 1 }], 'B');
    expect(attachments('csv').map((f) => f.split('/')[0])).toEqual(['run1-w0', 'run1-w1']);
  });

  it('eachTableGetsTheNextNumber', () => {
    info.table([{ a: 1 }], 'First');
    info.table([{ a: 2 }], 'Second');
    const num = (heading: string): number => Number(new RegExp(`/(\\d{3})-${heading}\\.csv$`).exec(attachments('csv').find((f) => f.endsWith(`-${heading}.csv`))!)![1]);
    expect(num('second')).toBe(num('first') + 1);
  });

  it('aNumberWhoseFileExists_isSkipped_notOverwritten', () => {
    const cfg = configure({});
    const n = Number(/\/(\d{3})-/.exec(nextTableFile(cfg, 'x')!)![1]);
    const taken = path.join(tmp, DAY, 'attachments', 'csv', 'run1-main', `${String(n + 1).padStart(3, '0')}-users.csv`);
    fs.mkdirSync(path.dirname(taken), { recursive: true });
    fs.writeFileSync(taken, 'someone else');
    info.table([{ a: 1 }], 'Users');
    expect(fs.readFileSync(taken, 'utf8')).toBe('someone else');
    expect(attachments('csv')).toContain(`run1-main/${String(n + 2).padStart(3, '0')}-users.csv`);
  });

  it('json_holdsSourceAndRows', () => {
    setTestContext('spec > logs in', 'logs in');
    info.table([{ id: 1, name: 'Ann' }, { id: 2 }], 'Users');
    const doc = lastJson();
    expect(doc).toMatchObject({ title: 'Users', level: 'INFO', worker: 'main', runId: 'run1', test: 'spec > logs in' });
    expect(doc.columns).toEqual(['id', 'name']);
    expect(doc.rows).toEqual([{ id: 1, name: 'Ann' }, { id: 2 }]);
    expect(typeof doc.time).toBe('string');
  });

  it('csv_headerThenRows_missingCellsBlank', () => {
    info.table([{ a: 1, b: 'x' }, { a: 2 }], 'T');
    expect(lastCsv()).toBe('﻿a,b\r\n1,x\r\n2,\r\n');
  });

  it('cellsAreNeverTruncated_evenWithTableCellLimit', () => {
    configure({ tableCellLimit: 5, tableCellLimitEnabled: true });
    info.table([{ long: 'abcdefghijklmnop' }], 'T');
    expect(out.join('')).not.toContain('abcdefghijklmnop'); // console is truncated
    expect(lastCsv()).toContain('abcdefghijklmnop');
    expect(lastJson().rows[0]!.long).toBe('abcdefghijklmnop');
  });

  it('logObject_and_mapRow_andEveryLevel_writeAttachments', () => {
    configure({ level: 'error' }); // attachments, like debug-trace, are written at every level
    info.log({ order: 'A-1' });
    warn.table(new Map([['k', 'v']]) as unknown as Record<string, unknown>, 'Map row');
    error.table([{ code: 500 }], 'Errors');
    expect(attachments('csv')).toHaveLength(3);
  });

  it('emptyAndStringTables_writeNothing', () => {
    info.table([], 'T');
    info.table({}, 'T');
    info.table(null, 'T');
    info.table('just text');
    expect(attachments('csv')).toEqual([]);
  });
});

describe('table attachments: the link line in the traces', () => {
  it('aDebugLineNamesBothFiles_inDebugAndFullTrace', () => {
    info.table([{ a: 1 }], 'T');
    const name = attachments('csv')[0]!.replace('.csv', '');
    const link = `TABLE FILES │ attachments/csv/${name}.csv | attachments/json/${name}.json`;
    expect(trace('debug-trace')).toContain(link);
    expect(trace('full-trace')).toContain(link);
  });

  it('atInfoLevel_theConsoleAndPartialTraceDoNotShowIt', () => {
    info.table([{ a: 1 }], 'T');
    expect(out.join('')).not.toContain('TABLE FILES');
    expect(trace('partial-trace')).not.toContain('TABLE FILES');
  });

  it('atDebugLevel_theConsoleShowsIt', () => {
    configure({ level: 'debug' });
    info.table([{ a: 1 }], 'T');
    expect(out.join('')).toMatch(/TABLE FILES │ attachments\/csv\/run1-main\/\d{3}-t\.csv \| attachments\/json\/run1-main\/\d{3}-t\.json/);
  });
});

describe('table attachments: redaction', () => {
  it('sensitiveKeys_atAnyDepth', () => {
    info.table([{ user: 'ann', password: 'hunter2', profile: { apiKey: 'k-1', city: 'Oslo' } }], 'T');
    for (const text of [lastCsv(), JSON.stringify(lastJson())]) {
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('k-1');
      expect(text).toContain('Oslo');
    }
  });

  it('freeTextInCells_andTitle_areMaskedWithRedactText', () => {
    info.table([{ note: 'token=abc123', url: '/x?access_token=zzz9&p=1' }], 'login token=t1tle');
    const doc = lastJson();
    expect(doc.rows[0]).toEqual({ note: 'token=***', url: '/x?access_token=***&p=1' });
    expect(doc.title).toBe('login token=***');
    expect(lastCsv()).not.toContain('abc123');
  });

  it('redactTextOff_keepsCellText_butKeyRedactionStays', () => {
    configure({ redactText: false });
    info.table([{ note: 'token=abc123', password: 'hunter2' }], 'T');
    expect(lastJson().rows[0]).toEqual({ note: 'token=abc123', password: '***' });
  });

  it('jsonStaysValid_whenAKeyLooksSensitive', () => {
    // A naive mask over the serialized JSON would turn "tokens":3 into "tokens":*** (invalid JSON).
    info.table([{ tokens: 3 }], 'T');
    expect(() => lastJson()).not.toThrow();
  });
});

describe('table attachments: switching off', () => {
  it('filesTablesFalse_writesNothing_andNoLinkLine', () => {
    configure({ files: { tables: false } });
    info.table([{ a: 1 }], 'T');
    expect(fs.existsSync(path.join(tmp, DAY, 'attachments'))).toBe(false);
    expect(trace('debug-trace')).not.toContain('TABLE FILES');
  });

  it('env_VOID_LOG_TABLES', () => {
    process.env.VOID_LOG_TABLES = '0';
    expect(resetConfig().files.tables).toBe(false);
    process.env.VOID_LOG_TABLES = 'on';
    expect(resetConfig().files.tables).toBe(true);
  });

  it('nextTableFile_isUndefinedWhenOff', () => {
    const cfg = configure({ files: { tables: false } });
    expect(nextTableFile(cfg, 'Users')).toBeUndefined();
  });

  it('customSinks_receiveTheTableAsData', () => {
    const seen: LogEvent[] = [];
    const sink: Sink = { accepts: () => true, write: (ev) => void seen.push(ev) };
    addSink(sink);
    try {
      info.table([{ a: 1 }], 'T');
    } finally {
      removeSink(sink);
    }
    const ev = seen.find((e) => e.table)!;
    expect(ev.table).toMatchObject({ title: 'T', headers: ['a'], rows: [{ a: 1 }] });
    expect(ev.table!.file).toMatch(/^run1-main\/\d{3}-t$/);
  });
});

describe('CSV and JSON formatting', () => {
  const csvRow = (row: Record<string, unknown>): string => tableToCsv({ headers: Object.keys(row), rows: [row] }).split('\r\n')[1]!;

  it.each<[string, unknown, string]>([
    ['comma', 'Ann, Lee', '"Ann, Lee"'],
    ['quote', 'say "hi"', '"say ""hi"""'],
    ['newline', 'a\nb', '"a\nb"'],
    ['leading space', ' x', '" x"'],
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['number', 42, '42'],
    ['boolean', true, 'true'],
    ['object', { a: 1 }, '"{""a"":1}"'],
    ['array', [1, 2], '"[1,2]"'],
    ['formula', '=SUM(A1)', "'=SUM(A1)"],
    ['plus formula', '+cmd', "'+cmd"],
    ['at formula', '@x', "'@x"],
    ['negative number text', '-5', '-5'],
  ])('csv %s', (_name, value, expected) => {
    expect(csvRow({ v: value })).toBe(expected);
  });

  it('json_handlesMapSetBigintError', () => {
    const text = tableToJson(
      { time: new Date(0), level: 'INFO', worker: 'main', test: undefined },
      { headers: ['m', 's', 'b', 'e'], rows: [{ m: new Map([['k', 1]]), s: new Set([1, 2]), b: 10n, e: new Error('boom') }] },
    );
    const row = JSON.parse(text).rows[0];
    expect(row.m).toEqual({ k: 1 });
    expect(row.s).toEqual([1, 2]);
    expect(row.b).toBe('10');
    expect(row.e).toContain('boom');
  });
});

describe('retention covers attachments', () => {
  /** Seed `<date>/attachments/<ext>/<rel>` (rel = `<runId>-<worker>/<file>`) with an old mtime. */
  function seedAttachment(ext: 'csv' | 'json', rel: string, ageDays: number, day = '2030-01-01'): string {
    const f = path.join(tmp, day, 'attachments', ext, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'old');
    const t = new Date(Date.now() - ageDays * 86_400_000);
    fs.utimesSync(f, t, t);
    return f;
  }

  it('maxRuns_deletesOldRunsAttachments_andTheEmptiedFolders', () => {
    const csv = seedAttachment('csv', 'oldrun-w0/001-users.csv', 9);
    const json = seedAttachment('json', 'oldrun-w0/001-users.json', 9);
    configure({ maxRuns: 1 });
    info.table([{ a: 1 }], 'T');
    expect(fs.existsSync(csv)).toBe(false);
    expect(fs.existsSync(json)).toBe(false);
    // worker folder, csv/json, attachments, date: all emptied and removed
    expect(fs.existsSync(path.join(tmp, '2030-01-01'))).toBe(false);
    expect(attachments('csv')).toHaveLength(1); // the current run's own
  });

  it('aRunsWorkerFolders_goTogether_otherRunsStay', () => {
    const [w0, w1] = [seedAttachment('csv', 'oldrun-w0/001-a.csv', 9), seedAttachment('csv', 'oldrun-w1/001-b.csv', 9)];
    const newer = seedAttachment('csv', 'newer-w0/001-c.csv', 3);
    configure({ maxRuns: 2 }); // current + "newer"
    info.table([{ a: 1 }], 'T');
    expect(fs.existsSync(w0)).toBe(false);
    expect(fs.existsSync(w1)).toBe(false);
    expect(fs.existsSync(newer)).toBe(true);
  });

  it('maxLogFiles_doesNotCountAttachments', () => {
    const csv = seedAttachment('csv', 'oldrun-w0/001-x.csv', 9);
    configure({ maxLogFiles: 1 });
    info.table([{ a: 1 }], 'T');
    expect(fs.existsSync(csv)).toBe(true);
  });

  it('foreignFoldersAndFiles_areLeftAlone', () => {
    const notAWorkerFolder = seedAttachment('csv', 'my-exports/001-x.csv', 9);
    const notOurFile = seedAttachment('csv', 'oldrun-w0/notes.csv', 9);
    configure({ maxRuns: 1 });
    info.table([{ a: 1 }], 'T');
    expect(fs.existsSync(notAWorkerFolder)).toBe(true);
    expect(fs.existsSync(notOurFile)).toBe(true);
  });

  it('runIdIsReadFromTheFolder_soHeadingsCannotConfuseIt', () => {
    // A heading that looks like a worker label ("x-w9-2") does not matter: the run id comes from the folder.
    const old = seedAttachment('csv', 'keep-w0/001-a.csv', 9);
    seedAttachment('csv', 'keep-w0/002-x-w9-2.csv', 0.001); // recent, so run "keep" is recent and stays whole
    configure({ maxRuns: 1 });
    info.table([{ a: 1 }], 'T');
    expect(fs.existsSync(old)).toBe(true);
  });
});

describe('config surface', () => {
  it('configFile_acceptsFilesTables_rejectsNonBoolean', async () => {
    const { loadConfigFile } = await import('../src/configFile');
    const f = path.join(tmp, 't.json');
    fs.writeFileSync(f, JSON.stringify({ files: { tables: false } }));
    expect(loadConfigFile({ VOID_LOG_CONFIG: f }, tmp)).toEqual({ files: { tables: false } });
    const bad = path.join(tmp, 't2.json'); // a new path: require() caches the first file by path
    fs.writeFileSync(bad, JSON.stringify({ files: { tables: 'no' } }));
    expect(() => loadConfigFile({ VOID_LOG_CONFIG: bad }, tmp)).toThrow(/files\.tables/);
  });
});

describe('table titles name the files', () => {
  /** Call table() without a title, as plain JS or older compiled code would. */
  const untitled = (data: unknown, title?: unknown): void => (info.table as (d: unknown, t?: unknown) => void).call(info, data, title);
  let err: string[];
  beforeEach(() => {
    err = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  it('titled_showsATitleRow_andNamesTheFiles', () => {
    info.table([{ a: 1 }], 'Order Lines');
    expect(out.join('')).toContain(' Order Lines ');
    expect(attachments('csv')[0]).toMatch(/^run1-main\/\d{3}-order-lines\.csv$/);
    expect(err.join('')).toBe('');
  });

  it('untitled_stillRenders_withoutATitleRow_filesNamedUntitled_warnsOnce', () => {
    untitled([{ a: 1 }]);
    untitled([{ a: 2 }]);
    expect(out.join('')).toContain('| a |');
    expect(attachments('csv').every((f) => /\/\d{3}-untitled\.csv$/.test(f))).toBe(true);
    const warnings = err.filter((e) => e.includes('table() was called without a title'));
    expect(warnings).toHaveLength(1);
  });

  it('blankTitle_countsAsUntitled', () => {
    untitled([{ a: 1 }], '   ');
    expect(attachments('csv')[0]).toMatch(/-untitled\.csv$/);
    expect(err.join('')).toContain('without a title');
  });

  it('emptyTableWithoutTitle_stillWarns_butWritesNothing', () => {
    untitled([]);
    expect(attachments('csv')).toEqual([]);
    expect(err.join('')).toContain('without a title');
  });

  it('logObject_namesItsFilesLog_withoutATitleRowOrWarning', () => {
    info.log({ order: 'A-1' });
    expect(attachments('csv')[0]).toMatch(/\/\d{3}-log\.csv$/);
    expect(out.join('')).not.toMatch(/\| +log +\|/);
    expect(err.join('')).toBe('');
  });

  it('listItems_areNamedByIndex', () => {
    info.log('Users', [{ id: 1 }, { id: 2 }]);
    expect(attachments('csv').map((f) => f.replace(/^.*\/\d{3}-/, ''))).toEqual(['list-item-0.csv', 'list-item-1.csv']);
  });

  it.each<[string, string]>([
    ['Users & Roles!', 'users-roles'],
    ['  leading and trailing  ', 'leading-and-trailing'],
    ['Пользователи 2024', 'пользователи-2024'],
    ['注文一覧', '注文一覧'],
    ['!!!', 'table'],
    ['a'.repeat(60), 'a'.repeat(40)],
    ['word '.repeat(12), 'word-word-word-word-word-word-word-word'],
  ])('heading %j → %s', async (heading, slug) => {
    const { headingSlug } = await import('../src/sinks');
    expect(headingSlug(heading)).toBe(slug);
  });
});
