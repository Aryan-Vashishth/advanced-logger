import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripAnsi } from './ansi';
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

/** A run with any file modified this recently may still be writing (another runner, a CI shard): never pruned. */
export const RECENT_RUN_MS = 60 * 60 * 1000;

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
 * the last RECENT_RUN_MS. So neither limit is a hard cap. Skipped entirely in a worker without a shared run id,
 * since its siblings' live files would look like an older run. Only files named like this logger's own output are
 * touched. Best effort: errors never reach the caller.
 */
function pruneOnce(cfg: LogConfig, kind: FileKind | 'jsonl'): void {
  const maxFiles = cfg.maxLogFiles != null && cfg.maxLogFiles > 0 ? cfg.maxLogFiles : null;
  const maxRuns = cfg.maxRuns != null && cfg.maxRuns > 0 ? cfg.maxRuns : null;
  if (maxFiles == null && maxRuns == null) return;
  if (runIdMissing()) return;
  const key = `${path.resolve(cfg.logDir)}|${kind}`;
  if (PRUNED.has(key)) return;
  PRUNED.add(key);
  try {
    const { runId } = getRun();
    const own = new RegExp(`^${kind}-.+\\.(log|jsonl)$`);
    // kind-<runId>-<worker>.<ext>; a name without a worker suffix counts as its own run.
    const runOf = (name: string): string =>
      new RegExp(`^${kind}-(.+)-(main|w\\d+)\\.(log|jsonl)$`).exec(name)?.[1] ?? name;
    const files: Array<{ file: string; mtime: number; run: string; current: boolean }> = [];
    for (const day of fs.readdirSync(cfg.logDir, { withFileTypes: true })) {
      if (!day.isDirectory()) continue;
      const dir = path.join(cfg.logDir, day.name, kind);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!own.test(name)) continue;
        const file = path.join(dir, name);
        try {
          files.push({ file, mtime: fs.statSync(file).mtimeMs, run: runOf(name), current: name.includes(runId) });
        } catch {
          /* removed by another worker */
        }
      }
    }

    const newest = new Map<string, number>();
    for (const f of files) newest.set(f.run, Math.max(newest.get(f.run) ?? 0, f.mtime));
    const now = Date.now();
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
      if (now - newest.get(f.run)! < RECENT_RUN_MS) continue;
      try {
        fs.rmSync(f.file, { force: true });
        const dir = path.dirname(f.file);
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        const day = path.dirname(dir);
        if (fs.readdirSync(day).length === 0) fs.rmdirSync(day);
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
  return [consoleSink, partialTraceSink, debugTraceSink, fullTraceSink, jsonlSink, captureSink, ...CUSTOM];
}
