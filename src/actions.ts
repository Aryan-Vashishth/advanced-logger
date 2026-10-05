import { BOLD, RESET } from './ansi';
import { config, truncateCell } from './config';
import { dispatch, themed } from './core';
import { type LevelName, LogIntent } from './theme';

export type Fields = Map<string, unknown> | Record<string, unknown>;
export type Row = Fields;

// -- helpers -----------------------------------------------------------------

/** Ordered key/value builder. Throws on an odd number of arguments. */
export function fields(...pairs: unknown[]): Map<string, unknown> {
  if (pairs.length % 2 !== 0) throw new TypeError('fields() requires an even number of key/value arguments');
  const map = new Map<string, unknown>();
  for (let i = 0; i < pairs.length; i += 2) map.set(String(pairs[i]), pairs[i + 1]);
  return map;
}

/**
 * Like fields(), but a logging call must never throw back into the caller: a dangling
 * trailing key (odd pair count) is kept under a sentinel key instead of raising.
 */
function safeFields(...pairs: unknown[]): Map<string, unknown> {
  if (pairs.length % 2 === 0) return fields(...pairs);
  const map = fields(...pairs.slice(0, -1));
  map.set('(unpaired)', pairs[pairs.length - 1]);
  return map;
}

const isMap = (v: unknown): v is Map<unknown, unknown> => v instanceof Map;

function isRecord(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof Error) &&
    !(v instanceof Map) &&
    Object.prototype.toString.call(v) === '[object Object]'
  );
}

const isFields = (v: unknown): v is Fields => isMap(v) || isRecord(v);

function entriesOf(f: Fields): Array<[string, unknown]> {
  return isMap(f) ? [...f.entries()].map(([k, v]) => [String(k), v]) : Object.entries(f);
}

const str = (m: unknown): string => (m == null ? 'null' : typeof m === 'string' ? m : String(m));

function sensitive(key: string): boolean {
  const k = key.toLowerCase();
  return config().redactKeys.some((r) => k.includes(r.toLowerCase()));
}

/** Java Arrays.deepToString-style rendering for arrays; JSON for plain objects. */
export function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.map(formatValue).join(', ')}]`;
  if (v instanceof Error) return v.stack ?? v.message;
  if (isMap(v)) return `{${[...v.entries()].map(([k, x]) => `${String(k)}=${formatValue(x)}`).join(', ')}}`;
  if (isRecord(v)) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

const redacted = (key: string, v: unknown): unknown => (sensitive(key) ? '***' : v);

const mask = (text: string | null | undefined): string => (text == null ? '***' : '*'.repeat(text.length));

function center(s: string, width: number): string {
  const plain = s.replace(/\u001b\[[;\d]*m/g, '');
  const len = plain.length;
  if (len >= width) return s.slice(0, width);
  const left = Math.floor((width - len) / 2);
  return ' '.repeat(left) + s + ' '.repeat(width - len - left);
}

// -- LogActions --------------------------------------------------------------

/**
 * One instance per level (debug/info/warn/error). Every method resolves its style as
 * intentFg + levelBg from the single built-in theme.
 */
export class LogActions {
  constructor(readonly level: LevelName) {}

  // -- INTERACTION
  click(m: unknown): void { this.msg(LogIntent.INTERACTION, 'CLICK [>]', m); }
  checkbox(m: unknown): void { this.msg(LogIntent.INTERACTION, 'CHECKBOX [x]', m); }
  text(m: unknown): void { this.msg(LogIntent.INTERACTION, 'TEXT [T]', m); }
  input(m: unknown): void { this.msg(LogIntent.INTERACTION, 'INPUT [>>]', m); }
  dropdown(m: unknown): void { this.msg(LogIntent.INTERACTION, 'DROPDOWN [v]', m); }
  toggle(m: unknown): void { this.msg(LogIntent.INTERACTION, 'TOGGLE [o]', m); }
  upload(m: unknown): void { this.msg(LogIntent.INTERACTION, 'UPLOAD [^]', m); }
  hover(m: unknown): void { this.msg(LogIntent.INTERACTION, 'HOVER [*]', m); }
  clear(m: unknown): void { this.msg(LogIntent.INTERACTION, 'CLEAR [-]', m); }
  key(m: unknown): void { this.msg(LogIntent.INTERACTION, 'KEY [#]', m); }
  /** Logs the password masked, never the value. */
  password(text: string | null | undefined, label?: string): void {
    this.msg(LogIntent.INTERACTION, 'PASSWORD [**]', label === undefined ? mask(text) : `${mask(text)} | ${label}`);
  }

  // -- NAVIGATION
  navigate(m: unknown): void { this.msg(LogIntent.NAVIGATION, 'NAVIGATE [=>]', m); }
  tab(m: unknown): void { this.msg(LogIntent.NAVIGATION, 'TAB [->]', m); }
  frame(m: unknown): void { this.msg(LogIntent.NAVIGATION, 'FRAME [{}]', m); }
  breadcrumb(m: unknown): void { this.msg(LogIntent.NAVIGATION, 'BREADCRUMB [/]', m); }

  // -- OBSERVE
  wait(m: unknown): void { this.msg(LogIntent.OBSERVE, 'WAIT [~]', m); }
  search(m: unknown): void { this.msg(LogIntent.OBSERVE, 'SEARCHED [*]', m); }
  result(m: unknown): void { this.msg(LogIntent.OBSERVE, 'RESULT [:]', m); }

  // -- VERIFY
  verifying(m: unknown): void { this.msg(LogIntent.VERIFY, 'VERIFY [?]', m); }

  // -- SUCCESS
  success(m: unknown): void { this.msg(LogIntent.SUCCESS, 'SUCCESS [+]', m); }
  complete(m: unknown): void { this.msg(LogIntent.SUCCESS, 'COMPLETE [+]', m); }

  // -- ALERT
  error(m: unknown): void { this.msg(LogIntent.ALERT, 'ERROR [x]', m); }
  failed(m: unknown): void { this.msg(LogIntent.ALERT, 'FAILED [x]', m); }
  timeout(m: unknown): void { this.msg(LogIntent.ALERT, 'TIMEOUT [!!]', m); }
  validation(m: unknown): void { this.msg(LogIntent.ALERT, 'VALIDATION [?!]', m); }
  fallback(m: unknown): void { this.msg(LogIntent.ALERT, 'FALLBACK [<-]', m); }
  skip(m: unknown): void { this.msg(LogIntent.ALERT, 'SKIP [>>]', m); }

  // -- DATA
  grid(m: unknown): void { this.msg(LogIntent.DATA, 'GRID [#]', m); }

  /** `table("text")` logs a TABLE line; `table(row | rows, title?)` renders an ASCII table. */
  table(data: string, title?: undefined): void;
  table(data: Row | Row[] | null | undefined, title?: string): void;
  table(data: unknown, title?: string): void {
    if (typeof data === 'string') return this.msg(LogIntent.DATA, 'TABLE [=]', data);
    if (data == null || (Array.isArray(data) && data.length === 0) || (isFields(data) && entriesOf(data).length === 0)) {
      return this.msg(LogIntent.DATA, 'TABLE', Array.isArray(data) || data == null ? 'No rows to display.' : 'No data to display.');
    }
    this.renderTable(Array.isArray(data) ? (data as Row[]) : [data as Row], title);
  }

  /** Aligned `key : value` lines. */
  row(data: Row | null | undefined): void {
    if (data == null || entriesOf(data).length === 0) return this.msg(LogIntent.DATA, 'ROW', '(empty)');
    const entries = entriesOf(data);
    const w = Math.max(...entries.map(([k]) => k.length));
    for (const [k, v] of entries) {
      this.msg(LogIntent.DATA, 'ROW', `${k.padEnd(w)} : ${truncateCell(redacted(k, v))}`);
    }
  }

  // -- tree / resolved

  tree(heading: string, fieldsOrFirst?: Fields | unknown, ...rest: unknown[]): void {
    this.treeInternal(heading, this.toFields(fieldsOrFirst, rest), LogIntent.BASE, 'LOG');
  }

  /** `resolved("msg")` or `resolved("heading", fields | ...pairs)` as a SUCCESS tree. */
  resolved(heading: string, fieldsOrFirst?: Fields | unknown, ...rest: unknown[]): void {
    if (fieldsOrFirst === undefined && rest.length === 0) return this.msg(LogIntent.SUCCESS, 'RESOLVED [ok]', heading);
    this.treeInternal(heading, this.toFields(fieldsOrFirst, rest), LogIntent.SUCCESS, 'RESOLVED');
  }

  // -- log overloads -----------------------------------------------------------

  /**
   * log("message")             -> level-labelled line
   * log(obj | array | map)     -> table / indexed list
   * log("heading", {k: v})     -> key/value tree
   * log("heading", "k", v, ..) -> key/value tree from pairs
   * log("heading", array|value)-> "heading: value" (arrays render as an indexed list)
   */
  log(message: string): void;
  log(obj: unknown): void;
  log(heading: string, fields: Fields): void;
  log(heading: string, ...pairsOrValue: unknown[]): void;
  log(...args: unknown[]): void {
    const label = this.level;
    if (args.length === 0) return this.msg(LogIntent.BASE, label, '');
    if (args.length === 1) {
      const [a] = args;
      if (typeof a === 'string') return this.msg(LogIntent.BASE, label, a);
      return this.logObject(a);
    }
    const heading = str(args[0]);
    const second = args[1];
    if (args.length === 2) {
      if (isFields(second)) return this.treeInternal(heading, second, LogIntent.BASE, label);
      return this.logHeadingValue(heading, second);
    }
    this.treeInternal(heading, safeFields(...args.slice(1)), LogIntent.BASE, label);
  }

  // -- internals ---------------------------------------------------------------

  private toFields(first: unknown, rest: unknown[]): Fields | undefined {
    if (first === undefined && rest.length === 0) return undefined;
    if (rest.length === 0 && isFields(first)) return first;
    return safeFields(first, ...rest);
  }

  private logObject(obj: unknown): void {
    if (obj == null) return this.msg(LogIntent.BASE, 'LOG', 'null');
    if (isMap(obj) || isRecord(obj)) return this.table(obj as Row);
    if (Array.isArray(obj)) return this.logList(obj);
    if (obj instanceof Error) return this.msg(LogIntent.BASE, 'LOG', obj.stack ?? obj.message);
    this.msg(LogIntent.BASE, 'LOG', String(obj));
  }

  private logHeadingValue(heading: string, v: unknown): void {
    if (v == null) return this.msg(LogIntent.BASE, 'LOG', `${heading}: null`);
    if (Array.isArray(v)) {
      this.msg(LogIntent.BASE, 'LOG', `${heading}:`);
      return this.logList(v);
    }
    this.msg(LogIntent.BASE, 'LOG', `${heading}: ${formatValue(v)}`);
  }

  private logList(list: unknown[]): void {
    if (list.length === 0) return this.msg(LogIntent.BASE, 'LOG', '(empty list)');
    list.forEach((item, i) => {
      const prefix = `  [${i}] `;
      if (isFields(item)) {
        this.msg(LogIntent.BASE, 'LOG', prefix);
        this.table(item);
      } else {
        this.msg(LogIntent.BASE, 'LOG', prefix + formatValue(item));
      }
    });
  }

  private renderTable(rows: Row[], title?: string): void {
    const normalized = rows.map((r) => entriesOf(r).map(([k, v]) => [k, redacted(k, v)] as [string, unknown]));
    const widths = new Map<string, number>();
    for (const row of normalized) {
      for (const [col, raw] of row) {
        const val = truncateCell(raw);
        widths.set(col, Math.max(widths.get(col) ?? col.length, col.length, val.length));
      }
    }
    const headers = [...widths.keys()];
    const ansi = config().ansi;
    const color = ansi ? themed(this.level, LogIntent.DATA) : '';
    const rst = ansi ? RESET : '';
    const w = (h: string): number => widths.get(h)!;

    const hBorder = '+' + headers.map((h) => '-'.repeat(w(h) + 2)).join('+') + '+';
    const headerRow = '|' + headers.map((h) => ' ' + truncateCell(h).padEnd(w(h)) + ' ').join('|') + '|';

    const out: string[] = [hBorder];
    if (title) {
      const bold = ansi ? BOLD : '';
      const resetBold = ansi ? RESET : '';
      out.push('|' + bold + center(` ${title} `, headerRow.length - 2) + resetBold + '|');
      out.push(hBorder);
    }
    out.push(headerRow, hBorder);
    for (const row of normalized) {
      const byKey = new Map(row);
      out.push('|' + headers.map((h) => ' ' + truncateCell(byKey.get(h) ?? '').padEnd(w(h)) + ' ').join('|') + '|');
    }
    out.push(hBorder);
    dispatch(this.level, null, color, 'TABLE', '\n' + out.join('\n') + rst);
  }

  private treeInternal(heading: string, f: Fields | undefined, intent: LogIntent, label: string): void {
    if (heading == null || f == null) return;
    this.msg(intent, label, heading);
    const entries = entriesOf(f);
    entries.forEach(([k, v], i) => {
      const prefix = i < entries.length - 1 ? '          ├─ ' : '          └─ ';
      this.msg(intent, label, `${prefix}${k.padEnd(12)}: ${formatValue(redacted(k, v))}`);
    });
  }

  protected msg(intent: LogIntent, label: string, message: unknown): void {
    dispatch(this.level, intent, themed(this.level, intent), label, str(message));
  }
}
