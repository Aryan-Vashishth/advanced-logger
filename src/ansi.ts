/**
 * ANSI escape factory + named color catalog.
 * Port of core.logging.ansi.AnsiEscape and AnsiColors.
 */

const ESC = '\u001b[';

// -- Escape factory ----------------------------------------------------------

export function sgr(...codes: number[]): string {
  if (codes.length === 0) throw new RangeError('sgr() requires at least one code');
  return `${ESC}${codes.join(';')}m`;
}

export function fg16(code: number): string {
  if (!((code >= 30 && code <= 37) || (code >= 90 && code <= 97))) {
    throw new RangeError(`16-color FG code must be in 30-37 or 90-97 (got ${code})`);
  }
  return sgr(code);
}

export function bg16(code: number): string {
  if (!((code >= 40 && code <= 47) || (code >= 100 && code <= 107))) {
    throw new RangeError(`16-color BG code must be in 40-47 or 100-107 (got ${code})`);
  }
  return sgr(code);
}

function validateRgb(r: number, g: number, b: number): void {
  for (const c of [r, g, b]) {
    if (!Number.isInteger(c) || c < 0 || c > 255) {
      throw new RangeError(`RGB components must be in 0-255 (got r=${r}, g=${g}, b=${b})`);
    }
  }
}

function validate256(code: number): void {
  if (!Number.isInteger(code) || code < 0 || code > 255) {
    throw new RangeError(`256-color code must be in 0-255 (got ${code})`);
  }
}

export const rgbFg = (r: number, g: number, b: number): string => {
  validateRgb(r, g, b);
  return `${ESC}38;2;${r};${g};${b}m`;
};
export const rgbBg = (r: number, g: number, b: number): string => {
  validateRgb(r, g, b);
  return `${ESC}48;2;${r};${g};${b}m`;
};
/** 0xRRGGBB overloads. */
export const rgbFgHex = (rgb: number): string => rgbFg((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);
export const rgbBgHex = (rgb: number): string => rgbBg((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff);

export const fg256 = (code: number): string => {
  validate256(code);
  return `${ESC}38;5;${code}m`;
};
export const bg256 = (code: number): string => {
  validate256(code);
  return `${ESC}48;5;${code}m`;
};

export const RESET = sgr(0);
export const BOLD = sgr(1);
export const DIM = sgr(2);
export const ITALIC = sgr(3);

export const colorize = (text: string, ansi: string, bg = ''): string => `${ansi}${bg}${text}${RESET}`;

// -- Strip / extract ---------------------------------------------------------

const ANSI_RE = /\u001b\[[;\d]*m/g;

export function stripAnsi(str: string | null | undefined): string {
  return str == null ? '' : str.replace(ANSI_RE, '');
}

/** Derive a foreground escape from a style string (bg-only styles map to their matching fg). */
export function fgFromStyle(style: string | null | undefined): string {
  if (style == null) return FG_BRIGHT_WHITE;
  const fg = /(\u001b\[3\d{1,2}(;\d{1,2})?m)/.exec(style);
  if (fg) return fg[1]!;
  const m8 = /(\u001b\[4)(\d)(m)/.exec(style);
  if (m8) {
    const c = `\u001b[3${m8[2]}m`;
    return c === FG_BLACK ? FG_BRIGHT_WHITE : c;
  }
  const m256 = /(\u001b\[48;5;)(\d+)(m)/.exec(style);
  if (m256) return `\u001b[38;5;${m256[2]}m`;
  return FG_BRIGHT_WHITE;
}

// -- Color catalog (data only) ----------------------------------------------

export const FG_BLACK = fg16(30);
export const FG_RED = fg16(31);
export const FG_GREEN = fg16(32);
export const FG_YELLOW = fg16(33);
export const FG_BLUE = fg16(34);
export const FG_MAGENTA = fg16(35);
export const FG_CYAN = fg16(36);
export const FG_WHITE = fg16(37);
export const FG_BRIGHT_BLACK = fg16(90);
export const FG_BRIGHT_RED = fg16(91);
export const FG_BRIGHT_GREEN = fg16(92);
export const FG_BRIGHT_YELLOW = fg16(93);
export const FG_BRIGHT_BLUE = fg16(94);
export const FG_BRIGHT_MAGENTA = fg16(95);
export const FG_BRIGHT_CYAN = fg16(96);
export const FG_BRIGHT_WHITE = fg16(97);

export const BG_BLACK = bg16(40);
export const BG_RED = bg16(41);
export const BG_GREEN = bg16(42);
export const BG_YELLOW = bg16(43);
export const BG_BLUE = bg16(44);
export const BG_MAGENTA = bg16(45);
export const BG_CYAN = bg16(46);
export const BG_WHITE = bg16(47);
export const BG_BRIGHT_BLACK = bg16(100);
export const BG_BRIGHT_RED = bg16(101);
export const BG_BRIGHT_GREEN = bg16(102);
export const BG_BRIGHT_YELLOW = bg16(103);
export const BG_BRIGHT_BLUE = bg16(104);
export const BG_BRIGHT_MAGENTA = bg16(105);
export const BG_BRIGHT_CYAN = bg16(106);
export const BG_BRIGHT_WHITE = bg16(107);

export const FG_256 = {
  ORANGE: fg256(208),
  GOLD: fg256(220),
  LIME: fg256(118),
  SKY: fg256(117),
  VIOLET: fg256(135),
  PINK: fg256(205),
  TEAL: fg256(80),
  SALMON: fg256(209),
  GREY_DARK: fg256(240),
  GREY_MID: fg256(246),
  GREY_LIGHT: fg256(252),
  NAVY: fg256(17),
  MAROON: fg256(88),
  OLIVE: fg256(100),
  INDIGO: fg256(54),
} as const;

export const BG_256 = {
  ORANGE: bg256(208),
  DARK_GREY: bg256(235),
  MID_GREY: bg256(238),
  NAVY: bg256(17),
  DARK_GREEN: bg256(22),
  DARK_TEAL: bg256(23),
  DARK_PURPLE: bg256(53),
  DARK_OLIVE: bg256(94),
  DARK_RED: bg256(52),
  MAROON: bg256(88),
  INDIGO: bg256(54),
} as const;

export const RGB_FG = {
  SNOW_WHITE: rgbFg(240, 242, 245),
  SOFT_WHITE: rgbFg(210, 215, 220),
  COOL_GREY: rgbFg(140, 150, 165),
  WARM_GREY: rgbFg(160, 158, 150),
  DEEP_CHARCOAL: rgbFg(28, 30, 38),
  GOLD: rgbFg(255, 200, 50),
  AMBER: rgbFg(255, 170, 0),
  PEACH: rgbFg(255, 185, 110),
  CORAL: rgbFg(255, 105, 85),
  SALMON: rgbFg(255, 140, 105),
  HOT_PINK: rgbFg(255, 75, 170),
  SKY_BLUE: rgbFg(80, 185, 255),
  ELECTRIC_BLUE: rgbFg(50, 140, 255),
  STEEL_CYAN: rgbFg(90, 220, 220),
  MINT: rgbFg(60, 220, 175),
  LIME_GREEN: rgbFg(100, 240, 120),
  NEON_GREEN: rgbFg(80, 255, 120),
  LAVENDER: rgbFg(185, 155, 255),
  VIOLET: rgbFg(160, 100, 255),
  PURPLE: rgbFg(155, 111, 224),
  DARKER_PURPLE: rgbFg(122, 79, 196),
  DEEP_PURPLE: rgbFg(90, 54, 163),
  DEEP_RED: rgbFg(210, 48, 48),
  DEEP_GREEN: rgbFg(38, 185, 72),
  DEEP_CYAN: rgbFg(28, 188, 196),
  DEEP_AMBER: rgbFg(200, 155, 20),
  DEEP_VIOLET: rgbFg(152, 88, 210),
  DEEP_ORANGE: rgbFg(205, 88, 18),
  DEEP_PINK: rgbFg(210, 40, 125),
} as const;

export const RGB_BG = {
  CHARCOAL: rgbBg(35, 38, 46),
  DARK_SLATE: rgbBg(28, 32, 42),
  MIDNIGHT: rgbBg(16, 18, 26),
  NEAR_BLACK: rgbBg(20, 22, 30),
  CARBON: rgbBg(28, 28, 32),
  STEEL_DARK: rgbBg(48, 52, 62),
  DARK_AMBER: rgbBg(95, 62, 0),
  VIVID_AMBER: rgbBg(170, 105, 0),
  RUST: rgbBg(110, 48, 20),
  CRIMSON: rgbBg(100, 20, 25),
  DARK_WINE: rgbBg(90, 16, 36),
  MAROON: rgbBg(110, 22, 22),
  ORANGE_VIVID: rgbBg(200, 100, 0),
  DARK_FOREST: rgbBg(18, 52, 28),
  DARK_OCEAN: rgbBg(14, 38, 72),
  DARK_TEAL: rgbBg(14, 66, 66),
  DARK_INDIGO: rgbBg(28, 24, 68),
  DARK_PURPLE: rgbBg(45, 22, 72),
  DARK_CYAN: rgbBg(0, 80, 100),
  SOFT_WHITE: rgbBg(238, 240, 245),
  LIGHT_GREY: rgbBg(205, 210, 218),
  WARM_AMBER_LT: rgbBg(190, 140, 15),
  TOMATO_RED: rgbBg(190, 45, 45),
  HOT_PINK: rgbBg(195, 38, 115),
  NEON_PURPLE: rgbBg(115, 18, 175),
  ELECTRIC_TEAL: rgbBg(0, 150, 170),
} as const;
