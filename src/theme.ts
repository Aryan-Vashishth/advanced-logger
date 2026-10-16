import {
  BG_BLACK,
  BOLD,
  FG_BRIGHT_BLACK,
  FG_BRIGHT_MAGENTA,
  FG_BRIGHT_WHITE,
  RESET,
  RGB_FG,
  rgbFg,
} from './ansi';
import { config } from './config';

/** Classifies what a line communicates, independent of level. Port of LogIntent. */
export const LogIntent = {
  BASE: 'BASE',
  INTERACTION: 'INTERACTION',
  NAVIGATION: 'NAVIGATION',
  OBSERVE: 'OBSERVE',
  VERIFY: 'VERIFY',
  DATA: 'DATA',
  SUCCESS: 'SUCCESS',
  ALERT: 'ALERT',
} as const;
export type LogIntent = (typeof LogIntent)[keyof typeof LogIntent];

export type LevelName = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * The single built-in theme (HIGH_CONTRAST from the Java logger).
 * One background for every level; the foreground is the action's own color (ACTION_FG), else the intent's, else
 * (plain log lines) the level's. The theme is "on" when ANSI is enabled and "off" otherwise.
 */
const BG = BG_BLACK;

/** ERROR level and the `failed` action share this red. Brighter than RGB_FG.DEEP_RED, which is under 4.5:1 on dark grey. */
const ERROR_RED = rgbFg(248, 75, 75);

const LEVEL_FG: Record<LevelName, string> = {
  INFO: FG_BRIGHT_WHITE + BOLD,
  WARN: RGB_FG.DEEP_AMBER + BOLD,
  ERROR: ERROR_RED + BOLD,
  DEBUG: FG_BRIGHT_BLACK + BOLD,
};

/** Fallback when a line has an intent but no action (custom LogActions subclasses). Each is its family's anchor. */
const INTENT_FG: Record<Exclude<LogIntent, 'BASE'>, string> = {
  INTERACTION: rgbFg(70, 166, 255) + BOLD,
  NAVIGATION: rgbFg(0, 196, 196) + BOLD,
  OBSERVE: FG_BRIGHT_MAGENTA + BOLD,
  VERIFY: rgbFg(240, 207, 76) + BOLD,
  DATA: rgbFg(181, 139, 249) + BOLD,
  SUCCESS: rgbFg(75, 201, 87) + BOLD,
  ALERT: ERROR_RED + BOLD,
};

/**
 * One foreground per action, inside its intent's hue family, so `click` and `input` differ while every interaction
 * still reads as blue and every alert as red or orange. Picked in OKLCH, then checked: each color is at least 4.6:1
 * against #1e1e1e, colors in one family are at least 10 apart (CIEDE2000), and colors in different families at
 * least 12. Re-check those numbers when changing a value.
 */
export const ACTION_FG = {
  // INTERACTION: blues, from cyan-blue to indigo
  click: rgbFg(70, 166, 255),
  hover: rgbFg(76, 142, 182),
  checkbox: rgbFg(100, 126, 239),
  toggle: rgbFg(183, 211, 255),
  dropdown: rgbFg(105, 248, 255),
  input: rgbFg(0, 207, 247),
  text: rgbFg(123, 173, 193),
  password: rgbFg(167, 229, 255),
  clear: rgbFg(179, 192, 202),
  key: rgbFg(0, 153, 171),
  upload: rgbFg(148, 165, 225),
  // NAVIGATION: teals
  navigate: rgbFg(0, 196, 196),
  tab: rgbFg(91, 235, 190),
  frame: rgbFg(71, 161, 144),
  breadcrumb: rgbFg(164, 219, 206),
  // OBSERVE: pinks and magentas
  wait: rgbFg(255, 167, 255),
  search: rgbFg(216, 121, 208),
  result: rgbFg(215, 161, 197),
  // VERIFY: gold
  verifying: rgbFg(240, 207, 76),
  // DATA: violets
  grid: rgbFg(181, 139, 249),
  table: rgbFg(222, 209, 255),
  row: rgbFg(149, 122, 187),
  // SUCCESS: greens
  success: rgbFg(75, 201, 87),
  complete: rgbFg(14, 160, 83),
  resolved: rgbFg(151, 191, 62),
  // ALERT: reds and oranges; skip is muted, since a skip is not a failure
  failed: ERROR_RED,
  error: rgbFg(255, 140, 120),
  timeout: rgbFg(216, 103, 39),
  validation: rgbFg(255, 126, 158),
  fallback: rgbFg(244, 136, 14),
  skip: rgbFg(219, 198, 185),
} as const;
export type LogAction = keyof typeof ACTION_FG;

/**
 * Table title and column-name rows: the table color (ACTION_FG.table) darker, same hue, so headers stand apart from
 * the rows below. 4.66:1 on #1e1e1e; CIEDE2000 25.8 from the table body.
 */
export const TABLE_HEADER_FG = rgbFg(153, 115, 223);

export const CALLER_FG = FG_BRIGHT_BLACK;
export const THEME_RESET = RESET;

/**
 * Foreground + background, each part gated by config().fg / config().bg ('' when both are off). The foreground is
 * the action's color when there is one, else the intent's, else (BASE) the level's.
 * Independent of config().ansi: callers (themed()) decide whether any color is wanted at all.
 */
export function resolveStyle(level: LevelName, intent: LogIntent, action?: LogAction): string {
  const { fg: useFg, bg: useBg } = config();
  let fg = '';
  if (useFg) {
    if (intent === 'BASE') fg = LEVEL_FG[level];
    else fg = action !== undefined && action in ACTION_FG ? ACTION_FG[action] + BOLD : INTENT_FG[intent];
  }
  return fg + (useBg ? BG : '');
}
