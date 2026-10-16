/** Color metrics for the palette tests: WCAG contrast and CIEDE2000 color difference, both on sRGB triples. */

export type Rgb = [number, number, number];

const linear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export const luminance = ([r, g, b]: Rgb): number => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB to CIELAB (D65). */
function toLab([r, g, b]: Rgb): [number, number, number] {
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** CIEDE2000 difference. Roughly: under 2 looks the same, 10+ is clearly a different color. */
export function deltaE2000(c1: Rgb, c2: Rgb): number {
  const [L1, a1, b1] = toLab(c1);
  const [L2, a2, b2] = toLab(c2);
  const Cbar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const ap1 = a1 * (1 + G);
  const ap2 = a2 * (1 + G);
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hue = (a: number, b: number): number => {
    const h = (Math.atan2(b, a) * 180) / Math.PI;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hue(ap1, b1);
  const hp2 = hue(ap2, b2);

  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = hp2 - hp1;
  if (Cp1 * Cp2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(rad(dh / 2));

  const Lbar = (L1 + L2) / 2;
  const Cpbar = (Cp1 + Cp2) / 2;
  let hbar = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    hbar = Math.abs(hp1 - hp2) > 180 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2) / 2;
    if (hbar >= 360) hbar -= 360;
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hbar - 30)) +
    0.24 * Math.cos(rad(2 * hbar)) +
    0.32 * Math.cos(rad(3 * hbar + 6)) -
    0.2 * Math.cos(rad(4 * hbar - 63));
  const SL = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const SC = 1 + 0.045 * Cpbar;
  const SH = 1 + 0.015 * Cpbar * T;
  const RT = -2 * Math.sqrt(Cpbar ** 7 / (Cpbar ** 7 + 25 ** 7)) * Math.sin(rad(60 * Math.exp(-(((hbar - 275) / 25) ** 2))));
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

/** The RGB triple of a 24-bit foreground escape (`ESC[38;2;r;g;bm`). */
export function rgbOf(escape: string): Rgb {
  const m = /38;2;(\d+);(\d+);(\d+)m/.exec(escape);
  if (!m) throw new Error(`not a 24-bit foreground escape: ${JSON.stringify(escape)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
