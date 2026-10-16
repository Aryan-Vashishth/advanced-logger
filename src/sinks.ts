import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripAnsi } from './ansi';
import { maskText } from './redact';
import { type LogConfig, LINE_BREAKS, LINE_BREAKS_NO_G, getRun, levelEnabled, runIdMissing, workerLabel } from './config';
import { CALLER_FG, type LevelName, type LogIntent, THEME_RESET } from './theme';

/** One log call. Sinks render it however they need. */
export interface LogEvent {
  time: Date;
  /** Pre-formatted timestamp. */
  ts: string;
  level: LevelName;
  /** null for pre-colored calls such as table(). */
  intent: LogIntent | null;
  label: string;
  /** Full message, may be multi-line. */
  message: string;
  /** Resolved theme style (intentFg + levelBg, per the fg/bg toggles; '' when none). Ignored when ANSI is off. */
  color: string;
  /** Plain "Callee <- Caller" text, empty when unresolved. */
  caller: string;
  /** Plain in-project chain, empty when unresolved. */
  chain: string;
  worker: string;
  /** Full test path ("file > describe > title"), as recorded in jsonl. */
  test?: string;
  /** Short test label for the console (the test's own title). */
  testTitle?: string;
  /** Set on a rendered table's event: its rows as data, for the CSV/JSON attachment sink and custom sinks. */
  table?: TableData;
}

/** A rendered table as data. Values are already redacted by key (at any depth); never truncated. */
export interface TableData {
  title?: string;
  /** Column order, as rendered. */
  headers: string[];
  rows: Array<Record<string, unknown>>;
  /** Attachment path under attachments/<csv|json>/, without extension: `<runId>-<worker>/<NNN>-<heading>`. Undefined when files.tables is off. */
  file?: string;
}

export interface Sink {
  /** Cheap check run before any stack capture; return false to skip the event entirely. */
  accepts(level: LevelName, cfg: LogConfig): boolean;
  write(ev: LogEvent, cfg: LogConfig): void;
}

const SPLIT_LINES = LINE_BREAKS_NO_G;
export const splitLines = (m: string): string[] => m.split(SPLIT_LINES);

const body = (ev: LogEvent, cfg: LogConfig, line: string): string =>
  ev.ts + cfg.segmentDivider + ev.label + cfg.segmentDivider + line;

// -- Console -----------------------------------------------------------------

function githubCommand(ev: LogEvent): 'error' | 'warning' | null {
  if (ev.level === 'ERROR' || ev.intent === 'ALERT') return 'error';
  if (ev.level === 'WARN') return 'warning';
  return null;
}

const escapeGithub = (t: string): string => t.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export const TEST_TAG_MAX = 40;

/** The opt-in "w1 │ test title │ " console prefix. The worker part matches the trace files' prefix. */
function consolePrefix(ev: LogEvent, cfg: LogConfig): string {
  let p = cfg.consoleWorker ? `${ev.worker} │ ` : '';
  if (cfg.consoleTest && ev.testTitle) {
    const t = ev.testTitle.replace(LINE_BREAKS, ' ');
    p += (t.length > TEST_TAG_MAX ? t.slice(0, TEST_TAG_MAX - 3) + '...' : t) + ' │ ';
  }
  return p;
}

export const consoleSink: Sink = {
  accepts: (level, cfg) => cfg.console && levelEnabled(cfg.level, level),
  write(ev, cfg) {
    const div = cfg.segmentDivider;
    const showCaller = levelEnabled(cfg.level, 'DEBUG');
    const callerText = showCaller ? ev.caller : '';
    const lines = splitLines(ev.message);
    const prefix = consolePrefix(ev, cfg);
    const out: string[] = [];
    lines.forEach((line, i) => {
      const b = prefix + body(ev, cfg, line);
      const first = i === 0 && callerText !== '';
      let text: string;
      if (cfg.ansi) {
        // ev.color is '' when fg and bg are both off: leave the body bare rather than emit a lone reset.
        const wrap = (s: string): string => (ev.color ? ev.color + s + THEME_RESET : s);
        // callerColor is its own opt-in and is not gated by fg/bg (only ansi=false silences it).
        text =
          first && cfg.callerColor
            ? wrap(b) + div + CALLER_FG + callerText + THEME_RESET
            : wrap(b + (first ? div + callerText : ''));
      } else {
        text = b + (first ? div + callerText : '');
      }
      out.push(text);
      if (cfg.githubAnnotations) {
        const cmd = githubCommand(ev);
        const plain = prefix + ev.ts + div + line;
        if (cmd && plain.trim() !== '') out.push(`::${cmd}::${escapeGithub(plain)}`);
      }
    });
    process.stdout.write(out.join('\n') + '\n');
  },
};

// -- Files -------------------------------------------------------------------

type FileKind = 'debug-trace' | 'partial-trace' | 'full-trace';
const FD_CACHE = new Map<string, number>();

function fdFor(file: string): number {
  let fd = FD_CACHE.get(file);
  if (fd === undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(file, 'a');
    FD_CACHE.set(file, fd);
  }
  return fd;
}

/** Synchronous append: nothing is buffered, so a crashing worker loses no lines. */
function appendSync(file: string, text: string): void {
  fs.writeSync(fdFor(file), text);
}

/** Trace kinds already pruned by this process (once per kind, at its first write). */
const PRUNED = new Set<string>();


let RUN_ID_WARNED = false;

/** One stderr warning per process when a Playwright worker has no shared run id (initRun() was never called). */
function warnIfRunIdMissing(): void {
  if (RUN_ID_WARNED || !runIdMissing()) return;
  RUN_ID_WARNED = true;
  process.stderr.write(
    `[advanced-logger] ${workerLabel()}: VOID_RUN_ID is not set, so this worker's log files use their own run id ` +
      'and log retention is off in this process. Call initRun() from your Playwright globalSetup.\n',
  );
}

/**
 * Retention per trace kind, across date folders: `maxLogFiles` keeps the newest N files by mtime, `maxRuns` keeps
 * the newest N runs whole (a run is dated by its newest file). Both may be set; a file goes if either says so.
 * Never deleted: the current run's files (parallel workers share one run id), and any run with a file modified in
 * the last `recentRunMinutes` (0 = no such guard). So neither limit is a hard cap. Skipped entirely in a worker without a shared run id,
 * since its siblings' live files would look like an older run. Only files named like this logger's own output are
 * touched. Best effort: errors never reach the caller.
 */
type PruneKind = FileKind | 'jsonl' | 'table-csv' | 'table-json';

interface PruneSpec {
  /** Folder under <logDir>/<date>/. */
  dir: string[];
  /** Names this logger wrote; nothing else is touched. */
  own: RegExp;
  /**
   * Captures the run id: from the file name, or with `perWorkerFolders` from the folder name. A name it does not
   * match counts as its own run.
   */
  run: RegExp;
  /** Files sit one level down, in a `<runId>-<worker>` folder per parent log (table attachments). */
  perWorkerFolders: boolean;
  /** maxLogFiles applies (trace files). Attachments are pruned by run only: a table count says nothing about runs. */
  byFileCount: boolean;
}

function pruneSpec(kind: PruneKind): PruneSpec {
  if (kind === 'table-csv' || kind === 'table-json') {
    const ext = kind === 'table-csv' ? 'csv' : 'json';
    return {
      dir: ['attachments', ext],
      // <runId>-<worker>/<NNN>-<heading>.<ext>
      own: new RegExp(`^\\d{3,}-.+\\.${ext}$`),
      run: /^(.+)-(?:main|w\d+)$/,
      perWorkerFolders: true,
      byFileCount: false,
    };
  }
  // <kind>-<runId>-<worker>.<ext>
  return {
    dir: [kind],
    own: new RegExp(`^${kind}-.+\\.(log|jsonl)$`),
    run: new RegExp(`^${kind}-(.+)-(?:main|w\\d+)\\.(?:log|jsonl)$`),
    perWorkerFolders: false,
    byFileCount: true,
  };
}

/** The files of one kind in one date folder, with the name the run id is read from (file, or its worker folder). */
function listKind(dir: string, spec: PruneSpec): Array<{ file: string; runName: string }> {
  const read = (d: string): string[] => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };
  const out: Array<{ file: string; runName: string }> = [];
  if (!spec.perWorkerFolders) {
    for (const name of read(dir)) if (spec.own.test(name)) out.push({ file: path.join(dir, name), runName: name });
    return out;
  }
  for (const folder of read(dir)) {
    if (!spec.run.test(folder)) continue;
    for (const name of read(path.join(dir, folder))) {
      if (spec.own.test(name)) out.push({ file: path.join(dir, folder, name), runName: folder });
    }
  }
  return out;
}

function pruneOnce(cfg: LogConfig, kind: PruneKind): void {
  const spec = pruneSpec(kind);
  const maxFiles = spec.byFileCount && cfg.maxLogFiles != null && cfg.maxLogFiles > 0 ? cfg.maxLogFiles : null;
  const maxRuns = cfg.maxRuns != null && cfg.maxRuns > 0 ? cfg.maxRuns : null;
  if (maxFiles == null && maxRuns == null) return;
  if (runIdMissing()) return;
  const key = `${path.resolve(cfg.logDir)}|${kind}`;
  if (PRUNED.has(key)) return;
  PRUNED.add(key);
  try {
    const { runId } = getRun();
    const runOf = (name: string): string => spec.run.exec(name)?.[1] ?? name;
    const files: Array<{ file: string; mtime: number; run: string; current: boolean }> = [];
    for (const day of fs.readdirSync(cfg.logDir, { withFileTypes: true })) {
      if (!day.isDirectory()) continue;
      for (const { file, runName } of listKind(path.join(cfg.logDir, day.name, ...spec.dir), spec)) {
        try {
          files.push({ file, mtime: fs.statSync(file).mtimeMs, run: runOf(runName), current: runName.includes(runId) });
        } catch {
          /* removed by another worker */
        }
      }
    }

    const newest = new Map<string, number>();
    for (const f of files) newest.set(f.run, Math.max(newest.get(f.run) ?? 0, f.mtime));
    const now = Date.now();
    const recentMs = cfg.recentRunMinutes * 60_000;
    const others = files.filter((f) => !f.current);
    const doomed = new Set<(typeof files)[number]>();

    if (maxFiles != null) {
      const keep = Math.max(0, maxFiles - (files.length - others.length));
      for (const f of [...others].sort((a, b) => b.mtime - a.mtime).slice(keep)) doomed.add(f);
    }
    if (maxRuns != null) {
      const otherRuns = [...new Set(others.map((f) => f.run))].sort((a, b) => newest.get(b)! - newest.get(a)!);
      const keep = Math.max(0, maxRuns - (others.length < files.length ? 1 : 0));
      const old = new Set(otherRuns.slice(keep));
      for (const f of others) if (old.has(f.run)) doomed.add(f);
    }

    for (const f of doomed) {
      if (now - newest.get(f.run)! < recentMs) continue;
      try {
        fs.rmSync(f.file, { force: true });
        // Remove folders this left empty (kind, attachments, date), never logDir itself.
        const root = path.resolve(cfg.logDir);
        for (let dir = path.dirname(path.resolve(f.file)); dir !== root && dir.startsWith(root); dir = path.dirname(dir)) {
          if (fs.readdirSync(dir).length > 0) break;
          fs.rmdirSync(dir);
        }
      } catch {
        /* in use, or already gone */
      }
    }
  } catch {
    /* retention must never break logging */
  }
}

export function closeAllFiles(): void {
  PRUNED.clear();
  RUN_ID_WARNED = false;
  for (const fd of FD_CACHE.values()) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  FD_CACHE.clear();
}

export function traceFilePath(cfg: LogConfig, kind: FileKind | 'jsonl', ext = 'log'): string {
  warnIfRunIdMissing();
  const { runId, runDate } = getRun();
  const w = workerLabel();
  return path.join(cfg.logDir, runDate, kind, `${kind}-${runId}-${w}.${ext}`);
}

// -- Table attachments (CSV + JSON, files.tables) -----------------------------

/** Per-process table counter. Never reset (not even by closeAllFiles), so a name is never reused and overwritten. */
let TABLE_SEQ = 0;

/** A heading as a file-name part: lowercase letters and digits (any script) joined by '-', at most 40 chars. */
export function headingSlug(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'table';
}

/**
 * The next table's attachment name, `<runId>-<worker>/<NNN>-<heading>`, or undefined when files.tables is off.
 * The folder `<runId>-<worker>` is the part every trace file of this worker shares (`<kind>-<runId>-<worker>.log`),
 * so each parent log has its own folder. NNN counts tables in this process; a number whose file already exists
 * (another process with the same run id and worker label) is skipped rather than overwritten.
 */
export function nextTableFile(cfg: LogConfig, heading: string): string | undefined {
  if (!cfg.files.tables) return undefined;
  warnIfRunIdMissing();
  const folder = `${getRun().runId}-${workerLabel()}`;
  const slug = headingSlug(heading);
  let name: string;
  do {
    TABLE_SEQ += 1;
    name = `${folder}/${String(TABLE_SEQ).padStart(3, '0')}-${slug}`;
  } while (fs.existsSync(tableFilePath(cfg, 'csv', name)) || fs.existsSync(tableFilePath(cfg, 'json', name)));
  return name;
}

/** <logDir>/<runDate>/attachments/<csv|json>/<runId>-<worker>/<NNN>-<heading>.<csv|json> */
export function tableFilePath(cfg: LogConfig, ext: 'csv' | 'json', file: string): string {
  return path.join(cfg.logDir, getRun().runDate, 'attachments', ext, ...file.split('/')) + `.${ext}`;
}

/** JSON.stringify replacer for values JSON drops or garbles: Map, Set, bigint, Error. */
function jsonSafe(_key: string, v: unknown): unknown {
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), x]));
  if (v instanceof Set) return [...v];
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Error) return v.stack ?? v.message;
  return v;
}

/** redactText for attachment cells: mask each string value (never the serialized text, which would break JSON). */
function maskStrings(v: unknown, keys: readonly string[]): unknown {
  if (typeof v === 'string') return maskText(v, keys);
  if (Array.isArray(v)) return v.map((x) => maskStrings(x, keys));
  if (v instanceof Map) return new Map([...v.entries()].map(([k, x]) => [k, maskStrings(x, keys)]));
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskStrings(x, keys)]));
  }
  return v;
}

/** One CSV field (RFC 4180). A text cell that a spreadsheet would run as a formula gets a leading apostrophe. */
function csvField(v: unknown): string {
  let s: string;
  if (v == null) s = '';
  else if (typeof v === 'string') s = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
  else if (typeof v === 'object') s = JSON.stringify(v, jsonSafe) ?? String(v);
  else s = String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 BOM (so Excel reads non-ASCII correctly), header row, then one row per table row; CRLF line ends. */
export function tableToCsv(t: Pick<TableData, 'headers' | 'rows'>): string {
  const lines = [t.headers.map(csvField).join(',')];
  for (const row of t.rows) lines.push(t.headers.map((h) => csvField(row[h])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** The JSON attachment: where the table came from, then its rows. */
export function tableToJson(ev: Pick<LogEvent, 'time' | 'level' | 'worker' | 'test'>, t: TableData): string {
  const doc = {
    title: t.title,
    time: ev.time.toISOString(),
    level: ev.level,
    worker: ev.worker,
    runId: getRun().runId,
    test: ev.test,
    columns: t.headers,
    rows: t.rows,
  };
  return JSON.stringify(doc, jsonSafe, 2) + '\n';
}

/** Writes each table's CSV and JSON attachment. All levels, like debug-trace; non-table events are ignored. */
export const tableFilesSink: Sink = {
  accepts: (_level, cfg) => cfg.files.tables,
  write(ev, cfg) {
    const t = ev.table;
    if (!t?.file) return;
    const masked: TableData = cfg.redactText
      ? { ...t, title: t.title === undefined ? undefined : maskText(t.title, cfg.redactKeys), rows: t.rows.map((r) => maskStrings(r, cfg.redactKeys) as Record<string, unknown>) }
      : t;
    for (const [ext, text] of [
      ['csv', tableToCsv(masked)],
      ['json', tableToJson(ev, masked)],
    ] as const) {
      const file = tableFilePath(cfg, ext, t.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    pruneOnce(cfg, 'table-csv');
    pruneOnce(cfg, 'table-json');
  },
};

function fileSink(kind: FileKind, enabled: (cfg: LogConfig) => boolean, rootOnly: boolean, render: (ev: LogEvent, cfg: LogConfig) => string[]): Sink {
  return {
    accepts: (level, cfg) => enabled(cfg) && (!rootOnly || levelEnabled(cfg.level, level)),
    write(ev, cfg) {
      const lines = render(ev, cfg);
      if (lines.length === 0) return;
      const prefix = `${ev.worker} │ `;
      appendSync(traceFilePath(cfg, kind), lines.map((l) => `${prefix}${stripAnsi(l)}`).join('\n') + '\n');
      pruneOnce(cfg, kind);
    },
  };
}

export const partialTraceSink = fileSink('partial-trace', (c) => c.files.partialTrace, true, (ev, cfg) =>
  splitLines(ev.message).map((l) => body(ev, cfg, l)),
);

export const debugTraceSink = fileSink('debug-trace', (c) => c.files.debugTrace, false, (ev, cfg) =>
  splitLines(ev.message).map((l, i) => {
    const b = body(ev, cfg, l);
    return i === 0 && ev.caller ? b + cfg.segmentDivider + ev.caller : b;
  }),
);

export const fullTraceSink = fileSink('full-trace', (c) => c.files.fullTrace, false, (ev, cfg) =>
  splitLines(ev.message).map((l) => {
    const b = body(ev, cfg, l);
    return ev.chain ? b + cfg.segmentDivider + '[CHAIN] ' + ev.chain : b;
  }),
);

// -- Structured JSONL (opt-in) ----------------------------------------------

export const jsonlSink: Sink = {
  accepts: (_level, cfg) => cfg.files.jsonl,
  write(ev, cfg) {
    const rec = {
      time: ev.time.toISOString(),
      level: ev.level,
      intent: ev.intent,
      label: ev.label,
      message: stripAnsi(ev.message),
      caller: ev.caller || undefined,
      chain: ev.chain || undefined,
      worker: ev.worker,
      test: ev.test,
      visible: levelEnabled(cfg.level, ev.level),
    };
    appendSync(traceFilePath(cfg, 'jsonl', 'jsonl'), JSON.stringify(rec) + '\n');
    pruneOnce(cfg, 'jsonl');
  },
};

// -- In-memory capture (used by the Playwright fixture) ----------------------

export interface Capture {
  /** Plain-text lines as they would appear in partial-trace. */
  text(): string;
  stop(): string;
}

const CAPTURES = new Set<string[]>();

export const captureSink: Sink = {
  accepts: (level, cfg) => CAPTURES.size > 0 && levelEnabled(cfg.level, level),
  write(ev, cfg) {
    const lines = splitLines(ev.message).map((l) => stripAnsi(body(ev, cfg, l)));
    for (const buf of CAPTURES) buf.push(...lines);
  },
};

export function captureLogs(): Capture {
  const buf: string[] = [];
  CAPTURES.add(buf);
  return {
    text: () => buf.join('\n'),
    stop: () => {
      CAPTURES.delete(buf);
      return buf.join('\n');
    },
  };
}

// -- Registry ----------------------------------------------------------------

const CUSTOM = new Set<Sink>();
export const addSink = (s: Sink): void => void CUSTOM.add(s);
export const removeSink = (s: Sink): void => void CUSTOM.delete(s);

export function activeSinks(): Sink[] {
  return [consoleSink, partialTraceSink, debugTraceSink, fullTraceSink, jsonlSink, tableFilesSink, captureSink, ...CUSTOM];
}
