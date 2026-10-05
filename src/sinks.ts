import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripAnsi } from './ansi';
import { type LogConfig, LINE_BREAKS_NO_G, getRun, levelEnabled, workerLabel } from './config';
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
  /** Resolved theme style (intentFg + levelBg). Ignored when ANSI is off. */
  color: string;
  /** Plain "Callee <- Caller" text, empty when unresolved. */
  caller: string;
  /** Plain in-project chain, empty when unresolved. */
  chain: string;
  worker: string;
  test?: string;
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

export const consoleSink: Sink = {
  accepts: (level, cfg) => cfg.console && levelEnabled(cfg.level, level),
  write(ev, cfg) {
    const div = cfg.segmentDivider;
    const showCaller = levelEnabled(cfg.level, 'DEBUG');
    const callerText = showCaller ? ev.caller : '';
    const lines = splitLines(ev.message);
    const out: string[] = [];
    lines.forEach((line, i) => {
      const b = body(ev, cfg, line);
      const first = i === 0 && callerText !== '';
      let text: string;
      if (cfg.ansi) {
        text =
          first && cfg.callerColor
            ? ev.color + b + THEME_RESET + div + CALLER_FG + callerText + THEME_RESET
            : ev.color + b + (first ? div + callerText : '') + THEME_RESET;
      } else {
        text = b + (first ? div + callerText : '');
      }
      out.push(text);
      if (cfg.githubAnnotations) {
        const cmd = githubCommand(ev);
        const plain = ev.ts + div + line;
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

export function closeAllFiles(): void {
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
