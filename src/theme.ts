import {
  BG_BLACK,
  BOLD,
  FG_BRIGHT_BLACK,
  FG_BRIGHT_MAGENTA,
  FG_BRIGHT_WHITE,
  RESET,
  RGB_FG,
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
 * Level supplies the background, intent supplies the foreground; the theme is
 * "on" when ANSI is enabled and "off" otherwise.
 */
const BG = BG_BLACK;

const LEVEL_FG: Record<LevelName, string> = {
  INFO: FG_BRIGHT_WHITE + BOLD,
  WARN: RGB_FG.DEEP_AMBER + BOLD,
  ERROR: RGB_FG.DEEP_RED + BOLD,
  DEBUG: FG_BRIGHT_BLACK + BOLD,
};

const INTENT_FG: Record<Exclude<LogIntent, 'BASE'>, string> = {
  INTERACTION: FG_BRIGHT_WHITE + BOLD,
  NAVIGATION: RGB_FG.DEEP_CYAN + BOLD,
  OBSERVE: FG_BRIGHT_MAGENTA + BOLD,
  VERIFY: RGB_FG.DEEP_AMBER + BOLD,
  DATA: RGB_FG.DEEP_VIOLET + BOLD,
  SUCCESS: RGB_FG.DEEP_GREEN + BOLD,
  ALERT: RGB_FG.DEEP_RED + BOLD,
};

export const CALLER_FG = FG_BRIGHT_BLACK;
export const THEME_RESET = RESET;

/**
 * intentFg + levelBg, each part gated by config().fg / config().bg ('' when both are off).
 * Independent of config().ansi: callers (themed()) decide whether any color is wanted at all.
 */
export function resolveStyle(level: LevelName, intent: LogIntent): string {
  const { fg: useFg, bg: useBg } = config();
  const fg = useFg ? (intent === 'BASE' ? LEVEL_FG[level] : INTENT_FG[intent]) : '';
  return fg + (useBg ? BG : '');
}
