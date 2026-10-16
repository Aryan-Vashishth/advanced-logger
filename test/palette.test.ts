import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_FG, closeAllFiles, configure, debug, info, resetConfig, type LogAction } from '../src';
import { BG_BLACK, BOLD, RESET } from '../src/ansi';
import { contrast, deltaE2000, rgbOf, type Rgb } from './helpers/color-metrics';

/** Each action's intent family. Colors are checked for distance inside a family and across families. */
const FAMILIES: Record<string, LogAction[]> = {
  INTERACTION: ['click', 'hover', 'checkbox', 'toggle', 'dropdown', 'input', 'text', 'password', 'clear', 'key', 'upload'],
  NAVIGATION: ['navigate', 'tab', 'frame', 'breadcrumb'],
  OBSERVE: ['wait', 'search', 'result'],
  VERIFY: ['verifying'],
  DATA: ['grid', 'table', 'row'],
  SUCCESS: ['success', 'complete', 'resolved'],
  ALERT: ['failed', 'error', 'timeout', 'validation', 'fallback', 'skip'],
};
/** Level colors on plain log lines, which actions must not be mistaken for (ERROR and `failed` share red on purpose). */
const LEVELS: Record<string, Rgb> = { INFO: [255, 255, 255], WARN: [200, 155, 20] };
/** VS Code's default dark terminal background: lighter than pure black, so the stricter of the two. */
const DARK_BG: Rgb = [30, 30, 30];

let tmp: string;
let out: string[];

beforeEach(() => {
  resetConfig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-pal-'));
  configure({ logDir: tmp, ansi: true, fg: true, bg: true, githubAnnotations: false, tsFormat: () => 'TS' });
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
  resetConfig();
});

/** Call one action the way a test would, and return the first console line it printed. */
function render(action: LogAction): string {
  out = [];
  const log = info as unknown as Record<string, (...a: unknown[]) => void>;
  if (action === 'row') info.row({ a: 1 });
  else if (action === 'table') info.table('x');
  else log[action]!('x');
  return out.join('').split('\n')[0]!;
}

describe('per-action colors', () => {
  it('everyFamilyListsEveryAction_once', () => {
    const listed = Object.values(FAMILIES).flat().sort();
    expect(listed).toEqual(Object.keys(ACTION_FG).sort());
  });

  it('eachActionLine_usesItsOwnColor', () => {
    for (const action of Object.keys(ACTION_FG) as LogAction[]) {
      expect(render(action), action).toMatch(new RegExp('^' + escape(ACTION_FG[action] + BOLD + BG_BLACK)));
    }
  });

  it('allActionColors_areDistinct', () => {
    const values = Object.values(ACTION_FG);
    expect(new Set(values).size).toBe(values.length);
  });

  it('clickAndInputAndPlainInfo_allDiffer', () => {
    // The reported problem: these three used to render in the same bold white.
    const [click, input] = [render('click'), render('input')];
    out = [];
    info.log('x');
    const plain = out.join('');
    expect(click.slice(0, 20)).not.toBe(input.slice(0, 20));
    expect(click.slice(0, 20)).not.toBe(plain.slice(0, 20));
  });

  it('actionColors_ignoreTheLevel_likeIntentColorsDid', () => {
    const atInfo = render('click');
    configure({ level: 'debug' }); // so debug lines reach the console
    out = [];
    debug.click('x');
    expect(out.join('').split('\n')[0]!.slice(0, 30)).toBe(atInfo.slice(0, 30));
  });

  it('truncatedInfo_debugCopyKeepsTheActionColor', () => {
    configure({ level: 'debug', infoLogsCharLimit: 5 });
    out = [];
    info.click('a long message');
    const lines = out.join('').split('\n').filter(Boolean);
    const copy = lines.find((l) => l.includes('a long message') && !l.includes('...'))!;
    expect(copy.startsWith(ACTION_FG.click + BOLD)).toBe(true);
  });

  it('fgOff_removesActionColors', () => {
    configure({ fg: false });
    expect(render('click')).toBe(BG_BLACK + 'TS │ CLICK [>] │ x' + RESET);
  });
});

describe('palette stays readable (re-check after editing ACTION_FG)', () => {
  const rgb = Object.fromEntries(Object.entries(ACTION_FG).map(([k, v]) => [k, rgbOf(v)])) as Record<LogAction, Rgb>;

  it('metricSanity', () => {
    expect(deltaE2000([10, 20, 30], [10, 20, 30])).toBe(0);
    expect(deltaE2000([255, 0, 0], [0, 0, 255])).toBeGreaterThan(40);
  });

  it('everyColor_hasAtLeast4.5ContrastOnADarkTerminal', () => {
    for (const [action, c] of Object.entries(rgb)) {
      expect(contrast(c, DARK_BG), action).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('colorsInOneFamily_areAtLeast10Apart', () => {
    for (const [family, actions] of Object.entries(FAMILIES)) {
      for (let i = 0; i < actions.length; i++) {
        for (let j = i + 1; j < actions.length; j++) {
          const d = deltaE2000(rgb[actions[i]!], rgb[actions[j]!]);
          expect(d, `${family}: ${actions[i]} vs ${actions[j]}`).toBeGreaterThanOrEqual(10);
        }
      }
    }
  });

  it('colorsInDifferentFamilies_andLevelColors_areAtLeast12Apart', () => {
    const entries = Object.entries(FAMILIES).flatMap(([f, as]) => as.map((a) => ({ f, name: a, c: rgb[a] })));
    for (const [name, c] of Object.entries(LEVELS)) entries.push({ f: 'LEVEL', name: name as LogAction, c });
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [a, b] = [entries[i]!, entries[j]!];
        if (a.f === b.f) continue;
        expect(deltaE2000(a.c, b.c), `${a.name} vs ${b.name}`).toBeGreaterThanOrEqual(12);
      }
    }
  });
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('fallbacks and prefixes', () => {
  it('customSubclass_msgWithoutAction_usesTheIntentsAnchorColor', async () => {
    const { LogActions, LogIntent } = await import('../src');
    class Mine extends LogActions {
      tap(m: string): void {
        this.msg(LogIntent.INTERACTION, 'TAP [.]', m);
      }
    }
    out = [];
    new Mine('INFO').tap('x');
    expect(out.join('').startsWith(ACTION_FG.click + BOLD + BG_BLACK)).toBe(true); // INTERACTION anchor = click blue
  });

  it('consolePrefixes_sitInsideTheColorBlock', () => {
    configure({ consoleWorker: true });
    expect(render('click')).toBe(ACTION_FG.click + BOLD + BG_BLACK + 'main │ TS │ CLICK [>] │ x' + RESET);
  });
});

describe('table header rows', () => {
  const tableLines = (): string[] => out.join('').split('\n').filter(Boolean);

  it('titleRow_andColumnNameRow_eachHaveTheirOwnColor_dataRowsHaveNeither', async () => {
    const { TABLE_TITLE_FG, TABLE_COLUMNS_FG } = await import('../src');
    out = [];
    info.table([{ id: 1, name: 'Ann' }], 'Users');
    const lines = tableLines();
    const titleLine = lines.find((l) => l.includes(' Users '))!;
    const columnsLine = lines.find((l) => l.includes(' id ') && l.includes(' name '))!;
    const dataLine = lines.find((l) => l.includes(' Ann '))!;
    expect(titleLine).toContain(TABLE_TITLE_FG + BOLD + '|');
    expect(titleLine).not.toContain(TABLE_COLUMNS_FG);
    expect(columnsLine).toContain(TABLE_COLUMNS_FG + BOLD + '| id ');
    expect(columnsLine).not.toContain(TABLE_TITLE_FG);
    expect(dataLine).not.toContain(TABLE_TITLE_FG);
    expect(dataLine).not.toContain(TABLE_COLUMNS_FG);
    // after each header part, the table style (with its background) is back for the rest of the line
    expect(titleLine).toContain('|' + ACTION_FG.table + BOLD + BG_BLACK);
    expect(columnsLine).toContain('|' + ACTION_FG.table + BOLD + BG_BLACK);
  });

  it('untitledTable_onlyTheColumnRowIsShaded', async () => {
    const { TABLE_TITLE_FG, TABLE_COLUMNS_FG } = await import('../src');
    out = [];
    info.log({ id: 1 }); // log(object): a table without a title row
    expect(out.join('')).toContain(TABLE_COLUMNS_FG);
    expect(out.join('')).not.toContain(TABLE_TITLE_FG);
  });

  it('fgOff_noHeaderColors', async () => {
    const { TABLE_TITLE_FG, TABLE_COLUMNS_FG } = await import('../src');
    configure({ fg: false });
    out = [];
    info.table([{ id: 1 }], 'Users');
    expect(out.join('')).not.toContain(TABLE_TITLE_FG);
    expect(out.join('')).not.toContain(TABLE_COLUMNS_FG);
  });

  it('title_columns_body_areReadable_layeredDarkToLight_andClearlyApart', async () => {
    const { TABLE_TITLE_FG, TABLE_COLUMNS_FG } = await import('../src');
    const [title, columns, body] = [rgbOf(TABLE_TITLE_FG), rgbOf(TABLE_COLUMNS_FG), rgbOf(ACTION_FG.table)];
    for (const c of [title, columns]) expect(contrast(c, DARK_BG)).toBeGreaterThanOrEqual(4.5);
    // darker than the body: less contrast against a dark background
    expect(contrast(title, DARK_BG)).toBeLessThan(contrast(columns, DARK_BG));
    expect(contrast(columns, DARK_BG)).toBeLessThan(contrast(body, DARK_BG));
    expect(deltaE2000(title, columns)).toBeGreaterThanOrEqual(12);
    expect(deltaE2000(columns, body)).toBeGreaterThanOrEqual(12);
    expect(deltaE2000(title, body)).toBeGreaterThanOrEqual(20);
  });

  it('columnColor_doesNotLookLikeAnObserveLine', async () => {
    const { TABLE_COLUMNS_FG } = await import('../src');
    for (const a of ['wait', 'search', 'result'] as const) {
      expect(deltaE2000(rgbOf(TABLE_COLUMNS_FG), rgbOf(ACTION_FG[a])), a).toBeGreaterThanOrEqual(12);
    }
  });
});
