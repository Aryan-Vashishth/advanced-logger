import { forgetConfigFile, loadConfigFile } from './configFile';
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
  /** ANSI output on/off. This is the theme toggle: on = HIGH_CONTRAST, off = plain text. Overrides fg and bg. */
  ansi: boolean;
  /** Intent-based foreground colors (plus the level foreground on BASE lines). Only matters when ansi is on. */
  fg: boolean;
  /** The theme background (one constant, BG_BLACK, for every level). Only matters when ansi is on. */
  bg: boolean;
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
  /** Mask values of these field keys (case-insensitive substring match) in tree/table/row output. */
  redactKeys: string[];
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
    },
    logDir: './logs',
    githubAnnotations: env.GITHUB_ACTIONS === 'true',
    redactKeys: ['password', 'passwd', 'secret', 'token', 'authorization', 'apikey', 'api_key'],
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
  const jsonl = envBool(env.VOID_LOG_JSONL);
  if (jsonl !== undefined) cfg.files.jsonl = jsonl;
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

/**
 * Precedence, lowest to highest: built-in defaults, config file, env vars. configure() calls land on top afterwards.
 * A failing config file throws on every call until it is fixed, so the mistake cannot be missed.
 */
function build(env: NodeJS.ProcessEnv = process.env): LogConfig {
  const cfg = builtinDefaults(env);
  // Re-entrancy guard: a config file that imports this package and touches config() while loading sees the defaults.
  CURRENT = cfg;
  try {
    const loaded = loadConfigFile(env, process.cwd());
    if (loaded !== undefined) {
      applyPatch(cfg, typeof loaded === 'function' ? loaded(cloneConfig(cfg)) : loaded);
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

/** Merge a patch, or mutate in place with a callback. Set-typed fields accept arrays in a patch. */
export function configure(patch: LogConfigPatch | ((cfg: LogConfig) => void)): LogConfig {
  const cur = config();
  if (typeof patch === 'function') {
    patch(cur);
    return cur;
  }
  applyPatch(cur, patch);
  return cur;
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

/** Worker label for the thread column: w<TEST_WORKER_INDEX> under Playwright, else "main". */
export function workerLabel(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEST_WORKER_INDEX != null ? `w${env.TEST_WORKER_INDEX}` : 'main';
}
