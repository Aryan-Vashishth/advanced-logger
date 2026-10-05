import type { LogConfig } from './config';

/**
 * Stack-based caller resolution. Port of getCallerString / getProjectCallChain.
 * Parses V8 stack text; the logger's own folder is always excluded, which replaces
 * Java's name-prefix suppression (and avoids dropping user methods such as `login`).
 */

interface Frame {
  display: string;
  file: string;
}

const FRAME_RE = /^\s*at\s+(?:(async)\s+)?(?:(new)\s+)?(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
const PLAIN_OBJECT_TYPES = new Set(['Object', 'Module', 'Function', 'Promise', 'Array']);

function normalizeFile(raw: string): string {
  let f = raw;
  if (f.startsWith('file://')) {
    f = f.slice('file://'.length);
    if (/^\/[A-Za-z]:/.test(f)) f = f.slice(1);
    try {
      f = decodeURIComponent(f);
    } catch {
      /* keep raw */
    }
  }
  return f.replace(/\\/g, '/');
}

function fileBase(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function displayName(fn: string | undefined, file: string, isNew: boolean): string {
  const base = fileBase(file);
  if (!fn) return base;
  const name = fn.replace(/\s*\[as [^\]]*\]$/, '');
  if (isNew) return `${name.split('.').pop()}.(constructor)`;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return name === '<anonymous>' ? base : `${base}.${name}`;
  const type = name.slice(0, dot);
  const method = name.slice(dot + 1);
  const owner = PLAIN_OBJECT_TYPES.has(type) ? base : type;
  return method === '<anonymous>' ? owner : `${owner}.${method}`;
}

export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split('\n')) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    const file = normalizeFile(m[4]!);
    frames.push({ display: displayName(m[3], file, m[2] === 'new'), file });
  }
  return frames;
}

// Folder holding this logger (src/ or dist/). Any frame inside it is logger-internal.
const SELF_DIR: string = (() => {
  const first = parseStack(new Error().stack)[0];
  if (!first) return '\u0000';
  return first.file.slice(0, first.file.lastIndexOf('/') + 1);
})();

function filteredOut(f: Frame, cfg: LogConfig): boolean {
  if (f.file.startsWith(SELF_DIR)) return true;
  const method = f.display.slice(f.display.lastIndexOf('.') + 1);
  for (const p of cfg.suppressMethodPrefixes) if (method.startsWith(p)) return true;
  if (cfg.includeOnlyPrefixes.size > 0) {
    let hit = false;
    for (const p of cfg.includeOnlyPrefixes) {
      if (f.file.includes(p) || f.display.startsWith(p)) {
        hit = true;
        break;
      }
    }
    if (!hit) return true;
  }
  for (const s of cfg.suppressContains) if (f.display.includes(s) || f.file.includes(s)) return true;
  return false;
}

function isProjectFrame(f: Frame, cfg: LogConfig): boolean {
  if (f.file.startsWith(SELF_DIR) || f.file.includes('node_modules') || f.file.startsWith('node:')) return false;
  const roots = cfg.projectRoots.map((r) => r.replace(/\\/g, '/'));
  return roots.some((r) => f.file.startsWith(r));
}

export interface CallerInfo {
  /** "Callee.method <- Caller.method" (arrow is U+2190), plain text. Empty when unknown. */
  caller: string;
  /** Full in-project chain, leaf first, joined by " <- ". */
  chain: string;
}

export const ARROW = ' ← ';

export function resolveCaller(cfg: LogConfig): CallerInfo {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  let frames: Frame[];
  try {
    frames = parseStack(new Error().stack);
  } finally {
    Error.stackTraceLimit = prev;
  }

  // caller: first surviving frame is the callee; next with a different display is the caller
  let callee: Frame | undefined;
  let caller: Frame | undefined;
  for (const f of frames) {
    if (filteredOut(f, cfg)) continue;
    if (!callee) {
      callee = f;
      continue;
    }
    if (f.display === callee.display) continue;
    caller = f;
    break;
  }
  const callerText = !callee ? '' : caller ? callee.display + ARROW + caller.display : callee.display;

  // chain: every project frame that survives filters, consecutive duplicates collapsed
  const chain: string[] = [];
  for (const f of frames) {
    if (!isProjectFrame(f, cfg) || filteredOut(f, cfg)) continue;
    if (chain[chain.length - 1] !== f.display) chain.push(f.display);
  }
  return { caller: callerText, chain: chain.join(ARROW) };
}
