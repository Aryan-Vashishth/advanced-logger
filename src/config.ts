import { checkPatch, forgetConfigFile, loadConfigFile, loadedConfigFile } from './configFile';
import type { LevelName } from './theme';

export type RootLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';
export type AttachPolicy = 'on-failure' | 'always' | 'never';

export interface FileToggles {
  /** Everything (all levels) plus caller suffix. */
  debugTrace: boolean;
  /** Console-visible lines only, no caller suffix. */
  partialTrace: boolean;
  /** Everything plus [CHAIN] suffix. */
  fullTrace: boolean;
  /** One structured JSON record per log call (QoL addition, off by default). */
  jsonl: boolean;
  /**
   * For every rendered table, a CSV and a JSON copy at <logDir>/<date>/attachments/{csv,json}/<runId>-<worker>/
   * <NNN>-<title>.{csv,json}: one folder per parent log. Full cell values (no tableCellLimit), redacted like the console.
   */
  tables: boolean;
}

export interface LogConfig {
  /** Root threshold for console + partial-trace. Debug/full traces always capture everything. */
  level: RootLevel;
  /** ANSI output on/off. This is the theme toggle: on = HIGH_CONTRAST, off = plain text. Overrides fg and bg. */
  ansi: boolean;
  /** Intent-based foreground colors (plus the level foreground on BASE lines). Only matters when ansi is on. */
  fg: boolean;
  /** The theme background (one constant, BG_BLACK, for every level). Only matters when ansi is on. */
  bg: boolean;
  /**
   * Max log files kept per trace kind (partial-trace, debug-trace, full-trace, jsonl); older ones are deleted by
   * mtime. Files of the current run, and of any run written to in the last recentRunMinutes, are never deleted, so
   * this is not a hard cap. null (or 0) keeps everything. Prefer maxRuns: a file count can keep part of a parallel run.
   */
  maxLogFiles: number | null;
  /**
   * Max runs kept per trace kind, the current run included. Older runs are deleted whole, oldest first. A run written
   * to in the last recentRunMinutes is never deleted. null (or 0) keeps everything.
   */
  maxRuns: number | null;
  /**
   * Retention never deletes a run with a file modified this many minutes ago or less (another runner or CI shard may
   * still be writing it). Default 60. 0 turns the guard off, so only the current run is protected.
   */
  recentRunMinutes: number;
  /**
   * Max chars for an INFO log (tables excluded). Longer ones print truncated with the total char count, followed by a
   * WARN and a DEBUG line holding the full text. null (or 0) means no limit.
   */
  infoLogsCharLimit: number | null;
  /** Console-only: prefix each line with the worker (w<N>, or main outside Playwright), as the trace files do. */
  consoleWorker: boolean;
  /** Console-only: prefix each line with the running test's title (set by the Playwright fixture), max 40 chars. */
  consoleTest: boolean;
  /** Console-only: color the caller suffix separately. Breaks one-ANSI-block-per-line. Independent of fg and bg. */
  callerColor: boolean;
  /** Java-style pattern (yyyy MM dd HH mm ss SSS) or a formatter function. */
  tsFormat: string | ((d: Date) => string);
  segmentDivider: string;
  tableCellLimit: number;
  tableCellLimitEnabled: boolean;
  /** Frames whose class or file path contains any of these are dropped from caller/chain. */
  suppressContains: Set<string>;
  suppressMethodPrefixes: Set<string>;
  /** When non-empty, only frames whose file path contains / class starts with one of these are kept. */
  includeOnlyPrefixes: Set<string>;
  /** Frames under these roots (and not in node_modules) form the [CHAIN]. */
  projectRoots: string[];
  console: boolean;
  files: FileToggles;
  logDir: string;
  /** Emit ::error:: / ::warning:: workflow commands when running under GitHub Actions. */
  githubAnnotations: boolean;
  /** Mask values of these field keys (case-insensitive substring match) in tree/table/row output, at any depth. */
  redactKeys: string[];
  /**
   * Also mask secrets written into message text: `key=value`, `key: value` and `"key":"value"` where the key contains
   * one of redactKeys, plus `Bearer <token>` / `Basic <credentials>`. Applies to every sink.
   */
  redactText: boolean;
  /** Playwright integration: when to attach the per-test log to the report. */
  attach: AttachPolicy;
}

const LEVEL_ORDER: Record<RootLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, off: 99 };
const NAME_ORDER: Record<LevelName, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export const levelEnabled = (root: RootLevel, level: LevelName): boolean =>
  NAME_ORDER[level] >= LEVEL_ORDER[root];

/** undefined for anything that is not a valid level, so an invalid env value never overrides a lower layer. */
function parseLevel(v: string | undefined): RootLevel | undefined {
  const l = (v ?? '').trim().toLowerCase();
  return l in LEVEL_ORDER ? (l as RootLevel) : undefined;
}

function envBool(v: string | undefined): boolean | undefined {
  if (v == null || v === '') return undefined;
  return /^(1|true|yes|on)$/i.test(v);
}

/** The env-level ANSI decision: VOID_LOG_ANSI, then NO_COLOR, then FORCE_COLOR. undefined when none is set. */
function explicitAnsi(env: NodeJS.ProcessEnv): boolean | undefined {
  const explicit = envBool(env.VOID_LOG_ANSI);
  if (explicit !== undefined) return explicit;
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  return undefined;
}

/** TTY/terminal hints, then CI renderers that show ANSI. This is the lowest layer (a config file beats it). */
function heuristicAnsi(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (isTTY) return true;
  if (env.GITHUB_ACTIONS === 'true') return true;
  if (env.COLORTERM) return true;
  return !!env.TERM && env.TERM !== 'dumb';
}

/** Explicit env wins, then NO_COLOR/FORCE_COLOR, then TTY/terminal hints, then CI renderers that show ANSI. */
export function detectAnsiSupport(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout?.isTTY): boolean {
  return explicitAnsi(env) ?? heuristicAnsi(env, isTTY);
}

/** Built-in defaults only. Env overrides are applied separately so a config file can sit between the two. */
function builtinDefaults(env: NodeJS.ProcessEnv): LogConfig {
  return {
    level: 'info',
    ansi: heuristicAnsi(env, !!process.stdout?.isTTY),
    fg: true,
    bg: true,
    infoLogsCharLimit: null,
    maxLogFiles: null,
    maxRuns: null,
    recentRunMinutes: 60,
    consoleWorker: false,
    consoleTest: false,
    callerColor: false,
    tsFormat: 'yyyy-MM-dd HH:mm:ss.SSS',
    segmentDivider: ' │ ',
    tableCellLimit: 40,
    tableCellLimitEnabled: false,
    suppressContains: new Set(['node_modules', 'node:', '<anonymous>']),
    suppressMethodPrefixes: new Set(),
    includeOnlyPrefixes: new Set(),
    projectRoots: [process.cwd()],
    console: true,
    files: {
      debugTrace: true,
      partialTrace: true,
      fullTrace: true,
      jsonl: false,
      tables: true,
    },
    logDir: './logs',
    githubAnnotations: env.GITHUB_ACTIONS === 'true',
    redactKeys: ['password', 'passwd', 'secret', 'token', 'authorization', 'apikey', 'api_key'],
    redactText: true,
    attach: 'on-failure',
  };
}

/** Each env var is applied only when set (and, for the level, valid). */
function applyEnv(cfg: LogConfig, env: NodeJS.ProcessEnv): void {
  const level = parseLevel(env.VOID_LOG_LEVEL);
  if (level) cfg.level = level;
  if (env.VOID_LOG_DIR) cfg.logDir = env.VOID_LOG_DIR;
  const ansi = explicitAnsi(env);
  if (ansi !== undefined) cfg.ansi = ansi;
  const tables = envBool(env.VOID_LOG_TABLES);
  if (tables !== undefined) cfg.files.tables = tables;
  const jsonl = envBool(env.VOID_LOG_JSONL);
  if (jsonl !== undefined) cfg.files.jsonl = jsonl;
  const trunc = env.VOID_LOG_INFO_LOGS_CHAR_LIMIT?.trim();
  if (trunc && /^\d+$/.test(trunc)) {
    cfg.infoLogsCharLimit = Number(trunc) > 0 ? Number(trunc) : null;
    LIMIT_SOURCE = 'env';
  }
  const maxFiles = env.VOID_LOG_MAX_FILES?.trim();
  if (maxFiles && /^\d+$/.test(maxFiles)) cfg.maxLogFiles = Number(maxFiles) > 0 ? Number(maxFiles) : null;
  const maxRuns = env.VOID_LOG_MAX_RUNS?.trim();
  if (maxRuns && /^\d+$/.test(maxRuns)) cfg.maxRuns = Number(maxRuns) > 0 ? Number(maxRuns) : null;
  const recent = env.VOID_LOG_RECENT_RUN_MINUTES?.trim();
  if (recent && /^\d+$/.test(recent)) cfg.recentRunMinutes = Number(recent);
  const redactText = envBool(env.VOID_LOG_REDACT_TEXT);
  if (redactText !== undefined) cfg.redactText = redactText;
  const fg = envBool(env.VOID_LOG_FG);
  if (fg !== undefined) cfg.fg = fg;
  const bg = envBool(env.VOID_LOG_BG);
  if (bg !== undefined) cfg.bg = bg;
}

function cloneConfig(c: LogConfig): LogConfig {
  return {
    ...c,
    files: { ...c.files },
    suppressContains: new Set(c.suppressContains),
    suppressMethodPrefixes: new Set(c.suppressMethodPrefixes),
    includeOnlyPrefixes: new Set(c.includeOnlyPrefixes),
    projectRoots: [...c.projectRoots],
    redactKeys: [...c.redactKeys],
  };
}

let CURRENT: LogConfig | undefined;

/** Which layer set the active infoLogsCharLimit, so the truncation warning can say what to edit. */
let LIMIT_SOURCE: 'default' | 'file' | 'env' | 'code' = 'default';

/**
 * Precedence, lowest to highest: built-in defaults, config file, env vars. configure() calls land on top afterwards.
 * A failing config file throws on every call until it is fixed, so the mistake cannot be missed.
 */
function build(env: NodeJS.ProcessEnv = process.env): LogConfig {
  const cfg = builtinDefaults(env);
  // Re-entrancy guard: a config file that imports this package and touches config() while loading sees the defaults.
  CURRENT = cfg;
  LIMIT_SOURCE = 'default';
  try {
    const loaded = loadConfigFile(env, process.cwd());
    if (loaded !== undefined) {
      const patch = typeof loaded === 'function' ? loaded(cloneConfig(cfg)) : loaded;
      applyPatch(cfg, patch);
      if (patch.infoLogsCharLimit !== undefined) LIMIT_SOURCE = 'file';
    }
    applyEnv(cfg, env);
  } catch (err) {
    CURRENT = undefined;
    throw err;
  }
  return cfg;
}

/** Built lazily on first use, so the project config file is read once in every process (every Playwright worker included). */
export const config = (): LogConfig => CURRENT ?? build();

export type LogConfigPatch = Partial<
  Omit<LogConfig, 'files' | 'suppressContains' | 'suppressMethodPrefixes' | 'includeOnlyPrefixes'>
> & {
  files?: Partial<FileToggles>;
  suppressContains?: Iterable<string>;
  suppressMethodPrefixes?: Iterable<string>;
  includeOnlyPrefixes?: Iterable<string>;
};

function applyPatch(target: LogConfig, patch: LogConfigPatch): void {
  const { files, suppressContains, suppressMethodPrefixes, includeOnlyPrefixes, ...rest } = patch;
  Object.assign(target, rest);
  if (files) Object.assign(target.files, files);
  if (suppressContains) target.suppressContains = new Set(suppressContains);
  if (suppressMethodPrefixes) target.suppressMethodPrefixes = new Set(suppressMethodPrefixes);
  if (includeOnlyPrefixes) target.includeOnlyPrefixes = new Set(includeOnlyPrefixes);
}

/** configure() problems already reported in this process, so a call inside a loop or hook warns once. */
const WARNED = new Set<string>();

/**
 * Merge a patch, or mutate in place with a callback. Set-typed fields accept arrays in a patch.
 * Both forms are checked like a config file, but a problem never throws (a logger must not fail a test): an unknown
 * option or a wrong-typed value prints one stderr warning and is skipped, and the rest still applies. For the
 * callback, "skipped" means the bad option is put back to its value from before the call (an unknown one removed).
 */
export function configure(patch: LogConfigPatch | ((cfg: LogConfig) => void)): LogConfig {
  const cur = config();
  if (typeof patch === 'function') {
    const before = cloneConfig(cur);
    patch(cur);
    checkLive(cur, before);
    if (cur.infoLogsCharLimit !== before.infoLogsCharLimit) LIMIT_SOURCE = 'code';
    return cur;
  }
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    warnOnce(`[advanced-logger] configure() expects an object or a function (got ${patch === null ? 'null' : typeof patch}); ignored.`);
    return cur;
  }
  const checked = checkPatch(patch as Record<string, unknown>, 'configure()');
  for (const p of checked.problems) warnOnce(`${p.message} Skipped.`);
  patch = checked.patch;
  applyPatch(cur, patch);
  if (patch.infoLogsCharLimit !== undefined) LIMIT_SOURCE = 'code';
  return cur;
}

const SET_KEYS = ['suppressContains', 'suppressMethodPrefixes', 'includeOnlyPrefixes'] as const;

/** After a configure() callback: warn about and undo each invalid change, so the live config stays well-formed. */
function checkLive(cur: LogConfig, before: LogConfig): void {
  const live = cur as unknown as Record<string, unknown>;
  // An array is a valid value for the Set-typed options (as in a patch), but the live config needs a real Set.
  for (const k of SET_KEYS) if (Array.isArray(live[k])) live[k] = new Set(live[k] as string[]);
  for (const p of checkPatch(live, 'configure() callback').problems) {
    warnOnce(`${p.message} Reverted.`);
    const [top, sub] = p.key.split('.') as [string, string | undefined];
    const prev = before as unknown as Record<string, unknown>;
    if (sub !== undefined) {
      const files = cur.files as unknown as Record<string, unknown>;
      if (sub in before.files) files[sub] = (before.files as unknown as Record<string, unknown>)[sub];
      else delete files[sub];
    } else if (top in prev) {
      live[top] = prev[top];
    } else {
      delete live[top];
    }
  }
}

/** Print a warning to stderr once per process (reset by resetConfig()). Internal: used for misuse that must not throw. */
export function warnOnce(msg: string): void {
  if (WARNED.has(msg)) return;
  WARNED.add(msg);
  process.stderr.write(msg + '\n');
}

/** Tells the reader where to raise infoLogsCharLimit, based on which layer set the active value. */
export function infoLimitHint(): string {
  const file = loadedConfigFile();
  switch (LIMIT_SOURCE) {
    case 'file':
      return `To increase the limit, change infoLogsCharLimit in ${file}.`;
    case 'env':
      return 'To increase the limit, change the VOID_LOG_INFO_LOGS_CHAR_LIMIT environment variable.';
    case 'code':
      return 'To increase the limit, change the infoLogsCharLimit passed to configure() in your code.';
    default:
      return 'To increase the limit, set infoLogsCharLimit in your logger config file or VOID_LOG_INFO_LOGS_CHAR_LIMIT.';
  }
}

/** Types a logger.config.* file. Returns its argument unchanged; the type is exactly LogConfigPatch. */
export function defineConfig(patch: LogConfigPatch): LogConfigPatch;
export function defineConfig(fn: (config: LogConfig) => LogConfigPatch): (config: LogConfig) => LogConfigPatch;
export function defineConfig(c: LogConfigPatch | ((config: LogConfig) => LogConfigPatch)): unknown {
  return c;
}

/** Restore defaults and re-read env and the config file. Mainly for tests. */
export function resetConfig(): LogConfig {
  CURRENT = undefined;
  WARNED.clear();
  forgetConfigFile();
  return config();
}

// -- Convenience mutators (parity with CustomLogger) -------------------------

export const enableAnsi = (): void => void (config().ansi = true);
export const disableAnsi = (): void => void (config().ansi = false);
export const isAnsiEnabled = (): boolean => config().ansi;
export const enableFg = (): void => void (config().fg = true);
export const disableFg = (): void => void (config().fg = false);
export const isFgEnabled = (): boolean => config().fg;
export const enableBg = (): void => void (config().bg = true);
export const disableBg = (): void => void (config().bg = false);
export const isBgEnabled = (): boolean => config().bg;
export const enableCallerColor = (): void => void (config().callerColor = true);
export const disableCallerColor = (): void => void (config().callerColor = false);
export const isCallerColorEnabled = (): boolean => config().callerColor;
export const isDebugEnabled = (): boolean => levelEnabled(config().level, 'DEBUG');

export function includeOnlyPackages(...prefixes: string[]): void {
  config().includeOnlyPrefixes = new Set(prefixes.filter((p) => p && p.trim()));
}
export function suppressClassContains(...substrings: string[]): void {
  for (const s of substrings) if (s && s.trim()) config().suppressContains.add(s);
}
export function suppressMethodPrefix(...prefixes: string[]): void {
  for (const p of prefixes) if (p && p.trim()) config().suppressMethodPrefixes.add(p);
}
export const clearIncludes = (): void => config().includeOnlyPrefixes.clear();

// -- Line breaks (Java \R equivalent) ----------------------------------------

const EXTRA_BREAKS = String.fromCharCode(0x2028, 0x2029, 0x85, 0x0b, 0x0c);
const BREAK_SOURCE = `\\r\\n|[\\n\\r${EXTRA_BREAKS}]`;
export const LINE_BREAKS = new RegExp(BREAK_SOURCE, 'g');
export const LINE_BREAKS_NO_G = new RegExp(BREAK_SOURCE);

// -- Cell truncation ---------------------------------------------------------

export function truncateCell(s: unknown): string {
  if (s == null) return '';
  const str = String(s).replace(LINE_BREAKS, ' ');
  const cfg = config();
  if (!cfg.tableCellLimitEnabled || str.length <= cfg.tableCellLimit) return str;
  return str.slice(0, Math.max(1, cfg.tableCellLimit - 3)) + '...';
}

/** Set a table cell limit (min 4) and enable it. */
export function setTableCellLimit(limit: number): void {
  const cfg = config();
  cfg.tableCellLimit = Math.max(4, limit);
  cfg.tableCellLimitEnabled = true;
}
export const disableTableCellLimit = (): void => void (config().tableCellLimitEnabled = false);

// -- Timestamp formatting ----------------------------------------------------

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

export function formatTs(cfg: LogConfig, d: Date): string {
  if (typeof cfg.tsFormat === 'function') return cfg.tsFormat(d);
  return cfg.tsFormat.replace(/yyyy|SSS|MM|dd|HH|mm|ss/g, (t) => {
    switch (t) {
      case 'yyyy': return String(d.getFullYear());
      case 'MM': return pad(d.getMonth() + 1);
      case 'dd': return pad(d.getDate());
      case 'HH': return pad(d.getHours());
      case 'mm': return pad(d.getMinutes());
      case 'ss': return pad(d.getSeconds());
      default: return pad(d.getMilliseconds(), 3);
    }
  });
}

// -- Run identity ------------------------------------------------------------

const stamp = (d: Date): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;

/**
 * Set VOID_RUN_ID / VOID_RUN_DATE if absent so every Playwright worker (which inherits the runner's env)
 * shares one run id. Call from globalSetup. Idempotent.
 */
export function initRun(): { runId: string; runDate: string } {
  const now = new Date();
  process.env.VOID_RUN_DATE ||= `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  process.env.VOID_RUN_ID ||= `${stamp(now)}-pid${process.pid}`;
  return getRun();
}

const FALLBACK_RUN = (() => {
  const now = new Date();
  return {
    runId: `${stamp(now)}-pid${process.pid}`,
    runDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  };
})();

export function getRun(): { runId: string; runDate: string } {
  return {
    runId: process.env.VOID_RUN_ID || FALLBACK_RUN.runId,
    runDate: process.env.VOID_RUN_DATE || FALLBACK_RUN.runDate,
  };
}

/**
 * True in a Playwright worker whose runner never called initRun(). Each such worker falls back to its own pid-based
 * run id, so its files are split from its siblings' and retention would see their live files as an older run.
 */
export function runIdMissing(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TEST_WORKER_INDEX != null && !env.VOID_RUN_ID;
}

/** Worker label for the thread column: w<TEST_WORKER_INDEX> under Playwright, else "main". */
export function workerLabel(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEST_WORKER_INDEX != null ? `w${env.TEST_WORKER_INDEX}` : 'main';
}
