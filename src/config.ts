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
}

export interface LogConfig {
  /** Root threshold for console + partial-trace. Debug/full traces always capture everything. */
  level: RootLevel;
  /** ANSI output on/off. This is the theme toggle: on = HIGH_CONTRAST, off = plain text. */
  ansi: boolean;
  /** Console-only: color the caller suffix separately. Breaks one-ANSI-block-per-line. */
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
  /** Mask values of these field keys (case-insensitive substring match) in tree/table/row output. */
  redactKeys: string[];
  /** Playwright integration: when to attach the per-test log to the report. */
  attach: AttachPolicy;
}

const LEVEL_ORDER: Record<RootLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, off: 99 };
const NAME_ORDER: Record<LevelName, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export const levelEnabled = (root: RootLevel, level: LevelName): boolean =>
  NAME_ORDER[level] >= LEVEL_ORDER[root];

function parseLevel(v: string | undefined): RootLevel {
  const l = (v ?? '').trim().toLowerCase();
  return l in LEVEL_ORDER ? (l as RootLevel) : 'info';
}

function envBool(v: string | undefined): boolean | undefined {
  if (v == null || v === '') return undefined;
  return /^(1|true|yes|on)$/i.test(v);
}

/** Explicit env wins, then NO_COLOR/FORCE_COLOR, then TTY/terminal hints, then CI renderers that show ANSI. */
export function detectAnsiSupport(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout?.isTTY): boolean {
  const explicit = envBool(env.VOID_LOG_ANSI);
  if (explicit !== undefined) return explicit;
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  if (isTTY) return true;
  if (env.GITHUB_ACTIONS === 'true') return true;
  if (env.COLORTERM) return true;
  return !!env.TERM && env.TERM !== 'dumb';
}

function defaults(env: NodeJS.ProcessEnv = process.env): LogConfig {
  return {
    level: parseLevel(env.VOID_LOG_LEVEL),
    ansi: detectAnsiSupport(env),
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
      jsonl: envBool(env.VOID_LOG_JSONL) ?? false,
    },
    logDir: env.VOID_LOG_DIR || './logs',
    githubAnnotations: env.GITHUB_ACTIONS === 'true',
    redactKeys: ['password', 'passwd', 'secret', 'token', 'authorization', 'apikey', 'api_key'],
    attach: 'on-failure',
  };
}

let CURRENT: LogConfig = defaults();

export const config = (): LogConfig => CURRENT;

export type LogConfigPatch = Partial<
  Omit<LogConfig, 'files' | 'suppressContains' | 'suppressMethodPrefixes' | 'includeOnlyPrefixes'>
> & {
  files?: Partial<FileToggles>;
  suppressContains?: Iterable<string>;
  suppressMethodPrefixes?: Iterable<string>;
  includeOnlyPrefixes?: Iterable<string>;
};

/** Merge a patch, or mutate in place with a callback. Set-typed fields accept arrays in a patch. */
export function configure(patch: LogConfigPatch | ((cfg: LogConfig) => void)): LogConfig {
  if (typeof patch === 'function') {
    patch(CURRENT);
    return CURRENT;
  }
  const { files, suppressContains, suppressMethodPrefixes, includeOnlyPrefixes, ...rest } = patch;
  Object.assign(CURRENT, rest);
  if (files) Object.assign(CURRENT.files, files);
  if (suppressContains) CURRENT.suppressContains = new Set(suppressContains);
  if (suppressMethodPrefixes) CURRENT.suppressMethodPrefixes = new Set(suppressMethodPrefixes);
  if (includeOnlyPrefixes) CURRENT.includeOnlyPrefixes = new Set(includeOnlyPrefixes);
  return CURRENT;
}

/** Restore defaults (re-reads env). Mainly for tests. */
export function resetConfig(): LogConfig {
  CURRENT = defaults();
  return CURRENT;
}

// -- Convenience mutators (parity with CustomLogger) -------------------------

export const enableAnsi = (): void => void (CURRENT.ansi = true);
export const disableAnsi = (): void => void (CURRENT.ansi = false);
export const isAnsiEnabled = (): boolean => CURRENT.ansi;
export const enableCallerColor = (): void => void (CURRENT.callerColor = true);
export const disableCallerColor = (): void => void (CURRENT.callerColor = false);
export const isCallerColorEnabled = (): boolean => CURRENT.callerColor;
export const isDebugEnabled = (): boolean => levelEnabled(CURRENT.level, 'DEBUG');

export function includeOnlyPackages(...prefixes: string[]): void {
  CURRENT.includeOnlyPrefixes = new Set(prefixes.filter((p) => p && p.trim()));
}
export function suppressClassContains(...substrings: string[]): void {
  for (const s of substrings) if (s && s.trim()) CURRENT.suppressContains.add(s);
}
export function suppressMethodPrefix(...prefixes: string[]): void {
  for (const p of prefixes) if (p && p.trim()) CURRENT.suppressMethodPrefixes.add(p);
}
export const clearIncludes = (): void => CURRENT.includeOnlyPrefixes.clear();

// -- Line breaks (Java \R equivalent) ----------------------------------------

const EXTRA_BREAKS = String.fromCharCode(0x2028, 0x2029, 0x85, 0x0b, 0x0c);
const BREAK_SOURCE = `\\r\\n|[\\n\\r${EXTRA_BREAKS}]`;
export const LINE_BREAKS = new RegExp(BREAK_SOURCE, 'g');
export const LINE_BREAKS_NO_G = new RegExp(BREAK_SOURCE);

// -- Cell truncation ---------------------------------------------------------

export function truncateCell(s: unknown): string {
  if (s == null) return '';
  const str = String(s).replace(LINE_BREAKS, ' ');
  const cfg = CURRENT;
  if (!cfg.tableCellLimitEnabled || str.length <= cfg.tableCellLimit) return str;
  return str.slice(0, Math.max(1, cfg.tableCellLimit - 3)) + '...';
}

/** Set a table cell limit (min 4) and enable it. */
export function setTableCellLimit(limit: number): void {
  CURRENT.tableCellLimit = Math.max(4, limit);
  CURRENT.tableCellLimitEnabled = true;
}
export const disableTableCellLimit = (): void => void (CURRENT.tableCellLimitEnabled = false);

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

/** Worker label for the thread column: w<TEST_WORKER_INDEX> under Playwright, else "main". */
export function workerLabel(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEST_WORKER_INDEX != null ? `w${env.TEST_WORKER_INDEX}` : 'main';
}
