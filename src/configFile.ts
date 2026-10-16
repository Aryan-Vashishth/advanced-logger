import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LogConfig, LogConfigPatch } from './config';

/** Looked up in this order in the project root; the first one that exists wins. */
export const CONFIG_FILE_NAMES = ['logger.config.ts', 'logger.config.js', 'logger.config.cjs', 'logger.config.json'] as const;

type Loaded = LogConfigPatch | ((config: LogConfig) => LogConfigPatch);

/** Resolved path for a config file, or undefined when none exists. An explicit VOID_LOG_CONFIG must exist. */
export function resolveConfigFile(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const explicit = env.VOID_LOG_CONFIG;
  if (explicit) {
    const file = path.resolve(cwd, explicit);
    if (!fs.existsSync(file)) {
      throw new Error(`[advanced-logger] VOID_LOG_CONFIG points to a file that does not exist: ${file}`);
    }
    return file;
  }
  for (const name of CONFIG_FILE_NAMES) {
    const file = path.join(cwd, name);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

/**
 * Load the project config file once per process. Returns undefined when there is none (silently fine).
 * A file that exists but throws, or has the wrong shape, throws an Error naming the file.
 */
export function loadConfigFile(env: NodeJS.ProcessEnv, cwd: string): Loaded | undefined {
  const file = resolveConfigFile(env, cwd);
  if (file === undefined) return undefined;
  LOADED = file;

  let value: unknown;
  try {
    // Lazy require, so Playwright's TypeScript hook (or Node's own type stripping) handles .ts files.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod: unknown = require(file);
    value = unwrapDefault(mod);
  } catch (err) {
    throw fail(file, err, 'could not be loaded');
  }

  if (typeof value === 'function') {
    const fn = value as (config: LogConfig) => unknown;
    return (cfg) => {
      let result: unknown;
      try {
        result = fn(cfg);
      } catch (err) {
        throw fail(file, err, 'threw while computing the config');
      }
      return validatePatch(result, file, 'the function must return an object');
    };
  }
  return validatePatch(value, file, 'it must default-export an object or a function');
}

let LOADED: string | undefined;

/** Absolute path of the config file loaded in this process, if any. */
export const loadedConfigFile = (): string | undefined => LOADED;

/** Drop the cached module so the next load re-reads the file (tests, resetConfig). */
export function forgetConfigFile(): void {
  if (LOADED !== undefined) {
    try {
      delete require.cache[require.resolve(LOADED)];
    } catch {
      /* not cached */
    }
    LOADED = undefined;
  }
}

/** `export default x` (transpiled or native), `module.exports = x`, and plain JSON all end up as x. */
function unwrapDefault(mod: unknown): unknown {
  if (mod !== null && typeof mod === 'object' && (mod as { __esModule?: boolean }).__esModule) {
    return (mod as { default?: unknown }).default;
  }
  return mod;
}

function fail(file: string, err: unknown, what: string): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`[advanced-logger] Config file ${file} ${what}: ${msg}`, { cause: err });
}

// -- Shape validation ----------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const bool = (v: unknown): boolean => typeof v === 'boolean';
const str = (v: unknown): boolean => typeof v === 'string';
const strList = (v: unknown): boolean =>
  (Array.isArray(v) || v instanceof Set) && [...(v as Iterable<unknown>)].every((x) => typeof x === 'string');
const strArr = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const oneOf = (...allowed: string[]) => (v: unknown): boolean => typeof v === 'string' && allowed.includes(v);

const KEYS: Record<keyof LogConfigPatch, [check: (v: unknown) => boolean, expected: string]> = {
  level: [oneOf('debug', 'info', 'warn', 'error', 'off'), "one of 'debug' | 'info' | 'warn' | 'error' | 'off'"],
  ansi: [bool, 'a boolean'],
  fg: [bool, 'a boolean'],
  bg: [bool, 'a boolean'],
  infoLogsCharLimit: [(v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0), 'a number >= 0 or null'],
  maxLogFiles: [(v) => v === null || (Number.isInteger(v) && (v as number) >= 0), 'an integer >= 0 or null'],
  maxRuns: [(v) => v === null || (Number.isInteger(v) && (v as number) >= 0), 'an integer >= 0 or null'],
  recentRunMinutes: [(v) => typeof v === 'number' && Number.isFinite(v) && v >= 0, 'a number >= 0'],
  redactText: [bool, 'a boolean'],
  consoleWorker: [bool, 'a boolean'],
  consoleTest: [bool, 'a boolean'],
  callerColor: [bool, 'a boolean'],
  tsFormat: [(v) => str(v) || typeof v === 'function', 'a string or a function'],
  segmentDivider: [str, 'a string'],
  tableCellLimit: [(v) => typeof v === 'number' && Number.isFinite(v), 'a finite number'],
  tableCellLimitEnabled: [bool, 'a boolean'],
  suppressContains: [strList, 'an array of strings'],
  suppressMethodPrefixes: [strList, 'an array of strings'],
  includeOnlyPrefixes: [strList, 'an array of strings'],
  projectRoots: [strArr, 'an array of strings'],
  console: [bool, 'a boolean'],
  files: [isPlainObject, 'an object'],
  logDir: [str, 'a string'],
  githubAnnotations: [bool, 'a boolean'],
  redactKeys: [strArr, 'an array of strings'],
  attach: [oneOf('on-failure', 'always', 'never'), "one of 'on-failure' | 'always' | 'never'"],
};

const FILE_KEYS = ['debugTrace', 'partialTrace', 'fullTrace', 'jsonl', 'tables'];

/**
 * Check a patch against KEYS. Every unknown key or wrong-typed value becomes a message naming `where`, and is left
 * out of the returned patch; undefined values are dropped. Shared by config files (which throw on the first problem)
 * and configure() (which warns and carries on).
 */
export interface PatchProblem {
  /** The offending option: 'level', or 'files.jsonl' for a files entry. */
  key: string;
  message: string;
}

export function checkPatch(value: Record<string, unknown>, where: string): { patch: LogConfigPatch; problems: PatchProblem[] } {
  const out: Record<string, unknown> = {};
  const problems: PatchProblem[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const rule = (KEYS as Record<string, [(v: unknown) => boolean, string] | undefined>)[key];
    if (!rule) {
      problems.push({ key, message: `[advanced-logger] ${where} has an unknown option '${key}'. Valid options: ${Object.keys(KEYS).join(', ')}.` });
      continue;
    }
    if (!rule[0](v)) {
      problems.push({ key, message: `[advanced-logger] ${where}: option '${key}' must be ${rule[1]} (got ${describe(v)}).` });
      continue;
    }
    if (key === 'files') {
      const files: Record<string, unknown> = {};
      for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) {
        if (fv === undefined) continue;
        if (!FILE_KEYS.includes(fk) || typeof fv !== 'boolean') {
          problems.push({ key: `files.${fk}`, message: `[advanced-logger] ${where}: option 'files.${fk}' must be a boolean and one of ${FILE_KEYS.join(', ')}.` });
          continue;
        }
        files[fk] = fv;
      }
      out[key] = files;
      continue;
    }
    out[key] = v;
  }
  return { patch: out as LogConfigPatch, problems };
}

/** Unknown keys are rejected (a typo such as `levl` must not be silently ignored); undefined values are dropped. */
function validatePatch(value: unknown, file: string, hint: string): LogConfigPatch {
  if (!isPlainObject(value)) {
    throw new Error(`[advanced-logger] Config file ${file} has an invalid shape: ${hint} (got ${describe(value)}).`);
  }
  const { patch, problems } = checkPatch(value, `Config file ${file}`);
  if (problems.length > 0) throw new Error(problems[0]!.message);
  return patch;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return `string ${JSON.stringify(v)}`;
  return typeof v === 'object' ? 'an object' : `${typeof v} ${String(v)}`;
}
