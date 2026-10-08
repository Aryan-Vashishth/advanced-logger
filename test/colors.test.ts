import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeAllFiles,
  config,
  configure,
  disableBg,
  disableFg,
  enableBg,
  enableFg,
  error,
  info,
  isBgEnabled,
  isFgEnabled,
  resetConfig,
  warn,
} from '../src';
import { BG_BLACK, BOLD, FG_BRIGHT_WHITE, FG_BRIGHT_BLACK, RESET, RGB_FG } from '../src/ansi';
import { resolveStyle } from '../src/theme';

const ESC = '\u001b';
const INTERACTION_FG = FG_BRIGHT_WHITE + BOLD;
const DEEP_RED_BOLD = RGB_FG.DEEP_RED + BOLD;

let tmp: string;
let out: string[];
const SAVED = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('VOID_LOG_')) delete process.env[k];
  resetConfig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-colors-'));
  configure({ logDir: tmp, ansi: true, githubAnnotations: false, tsFormat: () => 'TS' });
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
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  resetConfig();
});

const lines = (): string[] => out.join('').split('\n').filter(Boolean);

function readAllTraces(): string[] {
  const day = path.join(tmp, fs.readdirSync(tmp)[0]!);
  return fs
    .readdirSync(day)
    .flatMap((kind) => fs.readdirSync(path.join(day, kind)).map((f) => fs.readFileSync(path.join(day, kind, f), 'utf8')));
}

describe('fg/bg combinations (console)', () => {
  it('bothOn_isTheZeroPointOneOutput', () => {
    info.click('Submit');
    expect(lines()).toEqual([INTERACTION_FG + BG_BLACK + 'TS │ CLICK [>] │ Submit' + RESET]);
  });

  it('fgOnly_emitsForegroundWithoutBackground', () => {
    configure({ bg: false });
    info.click('Submit');
    const line = lines()[0]!;
    expect(line).toBe(INTERACTION_FG + 'TS │ CLICK [>] │ Submit' + RESET);
    expect(line).not.toContain(BG_BLACK);
  });

  it('bgOnly_emitsOnlyTheBackground', () => {
    configure({ fg: false });
    info.click('Submit');
    const line = lines()[0]!;
    expect(line).toBe(BG_BLACK + 'TS │ CLICK [>] │ Submit' + RESET);
    expect(line).not.toContain(`${ESC}[97`);
    expect(line).not.toContain(BOLD);
  });

  it('bothOff_leavesTheBodyBareWithNoStrayReset', () => {
    configure({ fg: false, bg: false });
    info.click('Submit');
    expect(lines()).toEqual(['TS │ CLICK [>] │ Submit']);
  });

  it('ansiOff_winsOverFgAndBg', () => {
    configure({ ansi: false, fg: true, bg: true });
    info.click('Submit');
    error.failed('nope');
    expect(out.join('')).not.toContain(ESC);
  });

  it('baseLevelForeground_belongsToFg', () => {
    configure({ bg: false });
    error.log('bad');
    expect(lines()[0]).toBe(DEEP_RED_BOLD + 'TS │ ERROR │ bad' + RESET);
    configure({ fg: false, bg: true });
    out = [];
    error.log('bad');
    expect(lines()[0]).toBe(BG_BLACK + 'TS │ ERROR │ bad' + RESET);
  });

  it('resolveStyle_followsTheToggles', () => {
    expect(resolveStyle('INFO', 'INTERACTION')).toBe(INTERACTION_FG + BG_BLACK);
    configure({ fg: false });
    expect(resolveStyle('INFO', 'INTERACTION')).toBe(BG_BLACK);
    configure({ fg: true, bg: false });
    expect(resolveStyle('INFO', 'INTERACTION')).toBe(INTERACTION_FG);
    configure({ fg: false, bg: false });
    expect(resolveStyle('INFO', 'INTERACTION')).toBe('');
  });
});

describe('fg/bg across every action family', () => {
  const calls: Array<[string, () => void]> = [
    ['click', () => info.click('a')],
    ['navigate', () => info.navigate('a')],
    ['success', () => info.success('a')],
    ['failed', () => warn.failed('a')],
    ['log', () => warn.log('a')],
    ['row', () => info.row({ Key: 'v', Other: 2 })],
    ['tree', () => info.tree('Heading', { a: 1, b: 2 })],
    ['resolved', () => info.resolved('Heading', { a: 1 })],
    ['table', () => info.table([{ ID: 1, Name: 'Alice' }], 'Users')],
    ['tableNoTitle', () => info.table([{ ID: 1 }])],
  ];

  it.each(calls)('%s: fg=false leaves no foreground escape and no bold', (_n, call) => {
    configure({ fg: false });
    call();
    const text = out.join('');
    expect(text).toContain(BG_BLACK);
    expect(text).not.toMatch(/\u001b\[(3[0-7]|9[0-7]|38;)/);
    expect(text).not.toContain(BOLD);
  });

  it.each(calls)('%s: bg=false leaves no background escape', (_n, call) => {
    configure({ bg: false });
    call();
    const text = out.join('');
    expect(text).not.toMatch(/\u001b\[(4[0-7]|10[0-7]|48;)/);
  });

  it.each(calls)('%s: both off emits no escape code at all', (_n, call) => {
    configure({ fg: false, bg: false });
    call();
    expect(out.join('')).not.toContain(ESC);
  });

  it.each(calls)('%s: ansi=false emits no escape code at all', (_n, call) => {
    configure({ ansi: false });
    call();
    expect(out.join('')).not.toContain(ESC);
  });

  it('tableTitle_boldFollowsFg', () => {
    info.table([{ A: 1 }], 'T');
    expect(out.join('')).toContain(BOLD);
    out = [];
    configure({ fg: false, bg: false });
    info.table([{ A: 1 }], 'T');
    expect(out.join('')).not.toContain(BOLD);
    out = [];
    configure({ fg: false, bg: true });
    info.table([{ A: 1 }], 'T');
    expect(out.join('')).not.toContain(BOLD);
  });
});

describe('plain-text sinks stay clean', () => {
  const combos: Array<[boolean, boolean]> = [
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ];

  it.each(combos)('fg=%s bg=%s: partial/debug/full traces contain no escape code', (fg, bg) => {
    configure({ fg, bg, level: 'debug', callerColor: true });
    info.click('Submit');
    info.table([{ ID: 1 }], 'T');
    error.log('bad');
    const traces = readAllTraces();
    expect(traces.length).toBeGreaterThanOrEqual(3);
    for (const t of traces) expect(t).not.toContain(ESC);
  });
});

describe('callerColor is independent of fg/bg', () => {
  function flow(): void {
    info.log('inside');
  }

  it('bothOff_callerStillColoredWhenCallerColorIsOn_bodyStaysBare', () => {
    configure({ level: 'debug', callerColor: true, fg: false, bg: false });
    flow();
    const line = lines()[0]!;
    expect(line.startsWith('TS')).toBe(true);
    expect(line).toContain(FG_BRIGHT_BLACK);
    expect(line.startsWith(ESC)).toBe(false);
    expect(line.endsWith(RESET)).toBe(true);
  });

  it('ansiOff_silencesCallerColorToo', () => {
    configure({ level: 'debug', callerColor: true, ansi: false });
    flow();
    expect(out.join('')).not.toContain(ESC);
  });

  it('bothOffAndCallerColorOff_isPlainEvenAtDebug', () => {
    configure({ level: 'debug', fg: false, bg: false });
    flow();
    expect(out.join('')).not.toContain(ESC);
    expect(lines()[0]).toContain('flow');
  });
});

describe('env vars VOID_LOG_FG / VOID_LOG_BG', () => {
  it.each([
    ['0', false],
    ['false', false],
    ['1', true],
    ['true', true],
    ['TRUE', true],
  ])('VOID_LOG_FG=%s -> fg=%s', (raw, expected) => {
    process.env.VOID_LOG_FG = raw;
    expect(resetConfig().fg).toBe(expected);
  });

  it.each([
    ['0', false],
    ['false', false],
    ['1', true],
    ['true', true],
  ])('VOID_LOG_BG=%s -> bg=%s', (raw, expected) => {
    process.env.VOID_LOG_BG = raw;
    expect(resetConfig().bg).toBe(expected);
  });

  it('unsetOrEmpty_keepsDefaultTrue', () => {
    process.env.VOID_LOG_FG = '';
    expect(resetConfig()).toMatchObject({ fg: true, bg: true });
  });

  it('env_appliesToRenderedOutput', () => {
    process.env.VOID_LOG_BG = '0';
    resetConfig();
    configure({ logDir: tmp, ansi: true, githubAnnotations: false, tsFormat: () => 'TS' });
    info.click('x');
    expect(lines()[0]).toBe(INTERACTION_FG + 'TS │ CLICK [>] │ x' + RESET);
  });

  it('explicitConfigure_beatsEnv', () => {
    process.env.VOID_LOG_FG = '0';
    resetConfig();
    configure({ fg: true });
    expect(config().fg).toBe(true);
  });
});

describe('mutators', () => {
  it('enableDisable_roundTrip', () => {
    expect([isFgEnabled(), isBgEnabled()]).toEqual([true, true]);
    disableFg();
    disableBg();
    expect([isFgEnabled(), isBgEnabled()]).toEqual([false, false]);
    enableFg();
    expect([isFgEnabled(), isBgEnabled()]).toEqual([true, false]);
    enableBg();
    expect([isFgEnabled(), isBgEnabled()]).toEqual([true, true]);
  });
});
