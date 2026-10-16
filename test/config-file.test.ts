import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config, configure, defineConfig, resetConfig, type LogConfig, type LogConfigPatch } from '../src';
import { CONFIG_FILE_NAMES, loadConfigFile, resolveConfigFile } from '../src/configFile';

let dir: string;
let cwd0: string;
const SAVED = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('VOID_LOG_')) delete process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-cfg-'));
  cwd0 = process.cwd();
  // Start every test from an empty project root so a stray logger.config.* in the repo can never leak in.
  process.chdir(dir);
  resetConfig();
});

afterEach(() => {
  process.chdir(cwd0);
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  resetConfig();
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, content: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
};

describe('discovery', () => {
  it('noFile_resolvesToUndefinedAndConfigMatchesBuiltInDefaults', () => {
    expect(resolveConfigFile({}, dir)).toBeUndefined();
    expect(loadConfigFile({}, dir)).toBeUndefined();
    const c = resetConfig();
    expect(c).toMatchObject({
      level: 'info',
      fg: true,
      bg: true,
      callerColor: false,
      logDir: './logs',
      console: true,
      attach: 'on-failure',
      tableCellLimit: 40,
    });
    expect(c.files).toEqual({ debugTrace: true, partialTrace: true, fullTrace: true, jsonl: false, tables: true });
  });

  it('searchOrder_isTsJsCjsJson', () => {
    expect([...CONFIG_FILE_NAMES]).toEqual(['logger.config.ts', 'logger.config.js', 'logger.config.cjs', 'logger.config.json']);
    for (const n of [...CONFIG_FILE_NAMES].reverse()) write(n, '{}');
    for (const n of CONFIG_FILE_NAMES) {
      expect(resolveConfigFile({}, dir)).toBe(path.join(dir, n));
      fs.rmSync(path.join(dir, n));
    }
    expect(resolveConfigFile({}, dir)).toBeUndefined();
  });

  it('firstUse_findsTheFileInProcessCwd', () => {
    write('logger.config.json', JSON.stringify({ level: 'warn' }));
    expect(resetConfig().level).toBe('warn');
  });

  it('theFileIsLoadedOncePerProcess_laterEditsAreNotSeen', () => {
    const f = write('logger.config.cjs', "module.exports = { level: 'warn' };");
    expect(resetConfig().level).toBe('warn');
    fs.writeFileSync(f, "module.exports = { level: 'error' };");
    expect(config().level).toBe('warn');
  });
});

describe('file forms', () => {
  it('cjsObject_isApplied', () => {
    write(
      'logger.config.cjs',
      "module.exports = { level: 'debug', callerColor: true, files: { jsonl: true }, redactKeys: ['pin'], suppressContains: ['vendor'] };",
    );
    const c = resetConfig();
    expect(c.level).toBe('debug');
    expect(c.callerColor).toBe(true);
    expect(c.files).toEqual({ debugTrace: true, partialTrace: true, fullTrace: true, jsonl: true, tables: true });
    expect(c.redactKeys).toEqual(['pin']);
    expect([...c.suppressContains]).toEqual(['vendor']);
  });

  it('transpiledEsmDefault_isUnwrapped', () => {
    write('logger.config.js', "Object.defineProperty(exports, '__esModule', { value: true }); exports.default = { level: 'error', fg: false };");
    expect(resetConfig()).toMatchObject({ level: 'error', fg: false });
  });

  it('jsonForm_isApplied', () => {
    write('logger.config.json', JSON.stringify({ level: 'off', tableCellLimit: 12, tableCellLimitEnabled: true, bg: false }));
    expect(resetConfig()).toMatchObject({ level: 'off', tableCellLimit: 12, tableCellLimitEnabled: true, bg: false });
  });

  it('functionForm_receivesDefaultsAndReturnsAPatch', () => {
    write(
      'logger.config.cjs',
      `module.exports = (cfg) => ({ level: cfg.level === 'info' ? 'debug' : 'error', logDir: cfg.logDir + '-x', files: { fullTrace: cfg.files.fullTrace === true ? false : true } });`,
    );
    const c = resetConfig();
    expect(c.level).toBe('debug');
    expect(c.logDir).toBe('./logs-x');
    expect(c.files.fullTrace).toBe(false);
  });

  it('functionForm_cannotMutateTheLiveConfigThroughItsArgument', () => {
    write('logger.config.cjs', "module.exports = (cfg) => { cfg.level = 'off'; cfg.suppressContains.clear(); return {}; };");
    const c = resetConfig();
    expect(c.level).toBe('info');
    expect(c.suppressContains.has('node_modules')).toBe(true);
  });

  it('defineConfig_returnsItsArgumentUnchanged_andTypesAsLogConfigPatch', () => {
    const obj = { level: 'warn' } satisfies LogConfigPatch;
    expect(defineConfig(obj)).toBe(obj);
    const fn = (c: LogConfig): LogConfigPatch => ({ level: c.level });
    expect(defineConfig(fn)).toBe(fn);
  });

  it('undefinedValues_areIgnoredNotApplied', () => {
    write('logger.config.cjs', 'module.exports = { level: undefined, logDir: undefined };');
    expect(resetConfig()).toMatchObject({ level: 'info', logDir: './logs' });
  });
});

describe('VOID_LOG_CONFIG', () => {
  it('absolutePath_overridesTheDiscoveredFile', () => {
    write('logger.config.json', JSON.stringify({ level: 'warn' }));
    const other = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(other, JSON.stringify({ level: 'error' }));
    process.env.VOID_LOG_CONFIG = other;
    expect(resetConfig().level).toBe('error');
  });

  it('relativePath_resolvesAgainstCwd', () => {
    fs.mkdirSync(path.join(dir, 'conf'));
    fs.writeFileSync(path.join(dir, 'conf', 'log.json'), JSON.stringify({ level: 'debug' }));
    process.env.VOID_LOG_CONFIG = 'conf/log.json';
    expect(resetConfig().level).toBe('debug');
  });

  it('anyFileName_isAccepted', () => {
    const f = write('my-logging.cjs', "module.exports = { level: 'warn' };");
    process.env.VOID_LOG_CONFIG = f;
    expect(resetConfig().level).toBe('warn');
  });

  it('explicitPathThatDoesNotExist_failsLoudlyWithThePath', () => {
    const missing = path.join(dir, 'nope.json');
    process.env.VOID_LOG_CONFIG = missing;
    expect(() => resetConfig()).toThrow(missing);
  });
});

describe('precedence: defaults < file < env < configure()', () => {
  it('fileBeatsBuiltInDefaults', () => {
    write('logger.config.json', JSON.stringify({ level: 'warn', logDir: 'from-file' }));
    expect(resetConfig()).toMatchObject({ level: 'warn', logDir: 'from-file' });
  });

  it('envBeatsFile', () => {
    write('logger.config.json', JSON.stringify({ level: 'warn', logDir: 'from-file', files: { jsonl: false }, fg: true, bg: true }));
    process.env.VOID_LOG_LEVEL = 'error';
    process.env.VOID_LOG_DIR = 'from-env';
    process.env.VOID_LOG_JSONL = '1';
    process.env.VOID_LOG_FG = '0';
    process.env.VOID_LOG_BG = 'false';
    expect(resetConfig()).toMatchObject({ level: 'error', logDir: 'from-env', fg: false, bg: false });
    expect(config().files.jsonl).toBe(true);
  });

  it('ansi_voidLogAnsiAndNoColorBeatFile_fileBeatsAutoDetection', () => {
    write('logger.config.json', JSON.stringify({ ansi: true }));
    process.env.VOID_LOG_ANSI = '0';
    expect(resetConfig().ansi).toBe(false);
    delete process.env.VOID_LOG_ANSI;
    process.env.NO_COLOR = '1';
    expect(resetConfig().ansi).toBe(false);
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    process.env.TERM = 'dumb';
    delete process.env.COLORTERM;
    delete process.env.GITHUB_ACTIONS;
    // No env decision at all: the file's `true` wins over what auto-detection would pick here.
    expect(resetConfig().ansi).toBe(true);
  });

  it('configureBeatsEnvAndFile', () => {
    write('logger.config.json', JSON.stringify({ level: 'warn' }));
    process.env.VOID_LOG_LEVEL = 'error';
    resetConfig();
    configure({ level: 'debug' });
    expect(config().level).toBe('debug');
  });

  it('configureBeforeFirstUse_stillLoadsTheFileFirstSoConfigureWins', () => {
    write('logger.config.json', JSON.stringify({ level: 'warn', logDir: 'from-file' }));
    // Simulate "nothing has touched config yet" by invalidating lazily-built state.
    resetConfig();
    configure({ level: 'debug' });
    expect(config()).toMatchObject({ level: 'debug', logDir: 'from-file' });
  });

  it('invalidEnvLevel_doesNotOverrideTheFile', () => {
    write('logger.config.json', JSON.stringify({ level: 'warn' }));
    process.env.VOID_LOG_LEVEL = 'loud';
    expect(resetConfig().level).toBe('warn');
  });

  it('invalidEnvLevel_withNoFile_isStillInfoLikeZeroPointOne', () => {
    process.env.VOID_LOG_LEVEL = 'loud';
    expect(resetConfig().level).toBe('info');
  });
});

describe('failures are loud and name the file', () => {
  const failing: Array<[string, string, string, RegExp]> = [
    ['syntaxError', 'logger.config.cjs', 'module.exports = {', /SyntaxError|Unexpected/],
    ['throwsWhileLoading', 'logger.config.cjs', "throw new Error('boom at load');", /boom at load/],
    ['functionThrows', 'logger.config.cjs', "module.exports = () => { throw new Error('boom in fn'); };", /boom in fn/],
    ['invalidJson', 'logger.config.json', '{ "level": ', /JSON|Unexpected|position/i],
    ['arrayShape', 'logger.config.json', '[1,2]', /invalid shape/],
    ['stringShape', 'logger.config.cjs', "module.exports = 'warn';", /invalid shape/],
    ['nullShape', 'logger.config.json', 'null', /invalid shape/],
    ['functionReturnsNothing', 'logger.config.cjs', 'module.exports = () => {};', /must return an object/],
    ['unknownKey', 'logger.config.json', '{ "levl": "debug" }', /unknown option 'levl'/],
    ['badLevel', 'logger.config.json', '{ "level": "loud" }', /option 'level' must be one of/],
    ['badBoolean', 'logger.config.json', '{ "fg": "yes" }', /option 'fg' must be a boolean/],
    ['badArray', 'logger.config.json', '{ "redactKeys": "password" }', /option 'redactKeys' must be an array of strings/],
    ['badFilesKey', 'logger.config.json', '{ "files": { "nope": true } }', /files\.nope/],
  ];

  it.each(failing)('%s', (_name, file, content, message) => {
    const full = write(file, content);
    let err: Error | undefined;
    try {
      resetConfig();
    } catch (e) {
      err = e as Error;
    }
    expect(err, 'expected resetConfig() to throw').toBeInstanceOf(Error);
    expect(err!.message).toContain(full);
    expect(err!.message).toMatch(message);
  });

  it('keepsFailingOnEveryCallInsteadOfSilentlyFallingBackToDefaults', () => {
    const full = write('logger.config.json', '{ "levl": "debug" }');
    expect(() => resetConfig()).toThrow(full);
    expect(() => config()).toThrow(full);
    expect(() => configure({ level: 'debug' })).toThrow(full);
  });
});
