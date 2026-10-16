import { BOLD, RESET } from './ansi';
import { config, truncateCell, warnOnce } from './config';
import { dispatch, themed } from './core';
import { type TableData, nextTableFile } from './sinks';
import { type LevelName, type LogAction, LogIntent, TABLE_HEADER_FG } from './theme';

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

/** A blank entry in redactKeys is ignored: every key contains '', so it would mask everything. */
function sensitive(key: string): boolean {
  const k = key.toLowerCase();
  return config().redactKeys.some((r) => r.trim() !== '' && k.includes(r.toLowerCase()));
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

/**
 * '***' when the key is sensitive; otherwise the value, with sensitive keys masked at any depth inside objects, Maps
 * and arrays. Returns a copy, never touching the caller's object; a cycle prints as '[Circular]'.
 */
const redacted = (key: string, v: unknown): unknown => (sensitive(key) ? '***' : redactDeep(v, new WeakSet()));

function redactDeep(v: unknown, seen: WeakSet<object>): unknown {
  if (v === null || typeof v !== 'object' || v instanceof Error || v instanceof Date) return v;
  if (seen.has(v)) return '[Circular]';
  // Redact what JSON.stringify would print, so a toJSON() result is checked too.
  const json = (v as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    let j: unknown;
    try {
      j = json.call(v);
    } catch {
      return v; // formatValue falls back to String(v) when serializing throws
    }
    if (j !== v) return redactDeep(j, seen);
  }
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => redactDeep(x, seen));
    if (isMap(v)) return new Map([...v.entries()].map(([k, x]) => [k, sensitive(String(k)) ? '***' : redactDeep(x, seen)]));
    if (isRecord(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = sensitive(k) ? '***' : redactDeep(x, seen);
      return out;
    }
    return v;
  } finally {
    seen.delete(v);
  }
}

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
 * One instance per level (debug/info/warn/error). Every action method has its own foreground (ACTION_FG, in its
 * intent's hue family) on the theme background; plain log lines use the level's foreground.
 */
export class LogActions {
  constructor(readonly level: LevelName) {}

  // -- INTERACTION
  click(m: unknown): void { this.msg(LogIntent.INTERACTION, 'CLICK [>]', m, 'click'); }
  checkbox(m: unknown): void { this.msg(LogIntent.INTERACTION, 'CHECKBOX [x]', m, 'checkbox'); }
  text(m: unknown): void { this.msg(LogIntent.INTERACTION, 'TEXT [T]', m, 'text'); }
  input(m: unknown): void { this.msg(LogIntent.INTERACTION, 'INPUT [>>]', m, 'input'); }
  dropdown(m: unknown): void { this.msg(LogIntent.INTERACTION, 'DROPDOWN [v]', m, 'dropdown'); }
  toggle(m: unknown): void { this.msg(LogIntent.INTERACTION, 'TOGGLE [o]', m, 'toggle'); }
  upload(m: unknown): void { this.msg(LogIntent.INTERACTION, 'UPLOAD [^]', m, 'upload'); }
  hover(m: unknown): void { this.msg(LogIntent.INTERACTION, 'HOVER [*]', m, 'hover'); }
  clear(m: unknown): void { this.msg(LogIntent.INTERACTION, 'CLEAR [-]', m, 'clear'); }
  key(m: unknown): void { this.msg(LogIntent.INTERACTION, 'KEY [#]', m, 'key'); }
  /** Logs the password masked, never the value. */
  password(text: string | null | undefined, label?: string): void {
    this.msg(LogIntent.INTERACTION, 'PASSWORD [**]', label === undefined ? mask(text) : `${mask(text)} | ${label}`, 'password');
  }

  // -- NAVIGATION
  navigate(m: unknown): void { this.msg(LogIntent.NAVIGATION, 'NAVIGATE [=>]', m, 'navigate'); }
  tab(m: unknown): void { this.msg(LogIntent.NAVIGATION, 'TAB [->]', m, 'tab'); }
  frame(m: unknown): void { this.msg(LogIntent.NAVIGATION, 'FRAME [{}]', m, 'frame'); }
  breadcrumb(m: unknown): void { this.msg(LogIntent.NAVIGATION, 'BREADCRUMB [/]', m, 'breadcrumb'); }

  // -- OBSERVE
  wait(m: unknown): void { this.msg(LogIntent.OBSERVE, 'WAIT [~]', m, 'wait'); }
  search(m: unknown): void { this.msg(LogIntent.OBSERVE, 'SEARCHED [*]', m, 'search'); }
  result(m: unknown): void { this.msg(LogIntent.OBSERVE, 'RESULT [:]', m, 'result'); }

  // -- VERIFY
  verifying(m: unknown): void { this.msg(LogIntent.VERIFY, 'VERIFY [?]', m, 'verifying'); }

  // -- SUCCESS
  success(m: unknown): void { this.msg(LogIntent.SUCCESS, 'SUCCESS [+]', m, 'success'); }
  complete(m: unknown): void { this.msg(LogIntent.SUCCESS, 'COMPLETE [+]', m, 'complete'); }

  // -- ALERT
  error(m: unknown): void { this.msg(LogIntent.ALERT, 'ERROR [x]', m, 'error'); }
  failed(m: unknown): void { this.msg(LogIntent.ALERT, 'FAILED [x]', m, 'failed'); }
  timeout(m: unknown): void { this.msg(LogIntent.ALERT, 'TIMEOUT [!!]', m, 'timeout'); }
  validation(m: unknown): void { this.msg(LogIntent.ALERT, 'VALIDATION [?!]', m, 'validation'); }
  fallback(m: unknown): void { this.msg(LogIntent.ALERT, 'FALLBACK [<-]', m, 'fallback'); }
  skip(m: unknown): void { this.msg(LogIntent.ALERT, 'SKIP [>>]', m, 'skip'); }

  // -- DATA
  grid(m: unknown): void { this.msg(LogIntent.DATA, 'GRID [#]', m, 'grid'); }

  /**
   * `table("text")` logs a TABLE line. `table(row | rows, title)` renders an ASCII table under that title, and (with
   * files.tables) writes its CSV and JSON files named `<NNN>-<title>`. The title is required; called without one
   * (plain JS, older code), the table still renders, without a title row, and its files are named `untitled`, with
   * a one-time warning.
   */
  table(data: string): void;
  table(data: Row | Row[] | null | undefined, title: string): void;
  table(data: unknown, title?: string): void {
    if (typeof data === 'string') return this.msg(LogIntent.DATA, 'TABLE [=]', data, 'table');
    const titled = typeof title === 'string' && title.trim() !== '';
    if (!titled) {
      warnOnce(
        "[advanced-logger] table() was called without a title. Pass one, as in info.table(rows, 'Users'): it is " +
          "shown above the table and names the table's CSV and JSON files. Untitled tables' files are named 'untitled'.",
      );
    }
    this.tableInternal(data, titled ? title : undefined, titled ? title! : 'untitled');
  }

  /** `title` is the console title row (none when undefined); `heading` names the CSV/JSON files. */
  private tableInternal(data: unknown, title: string | undefined, heading: string): void {
    if (data == null || (Array.isArray(data) && data.length === 0) || (isFields(data) && entriesOf(data).length === 0)) {
      return this.msg(LogIntent.DATA, 'TABLE', Array.isArray(data) || data == null ? 'No rows to display.' : 'No data to display.', 'table');
    }
    this.renderTable(Array.isArray(data) ? (data as Row[]) : [data as Row], title, heading);
  }

  /** Aligned `key : value` lines. */
  row(data: Row | null | undefined): void {
    if (data == null || entriesOf(data).length === 0) return this.msg(LogIntent.DATA, 'ROW', '(empty)', 'row');
    const entries = entriesOf(data);
    const w = Math.max(...entries.map(([k]) => k.length));
    for (const [k, v] of entries) {
      this.msg(LogIntent.DATA, 'ROW', `${k.padEnd(w)} : ${truncateCell(redacted(k, v))}`, 'row');
    }
  }

  // -- tree / resolved

  tree(heading: string, fieldsOrFirst?: Fields | unknown, ...rest: unknown[]): void {
    this.treeInternal(heading, this.toFields(fieldsOrFirst, rest), LogIntent.BASE, 'LOG');
  }

  /** `resolved("msg")` or `resolved("heading", fields | ...pairs)` as a SUCCESS tree. */
  resolved(heading: string, fieldsOrFirst?: Fields | unknown, ...rest: unknown[]): void {
    if (fieldsOrFirst === undefined && rest.length === 0) return this.msg(LogIntent.SUCCESS, 'RESOLVED [ok]', heading, 'resolved');
    this.treeInternal(heading, this.toFields(fieldsOrFirst, rest), LogIntent.SUCCESS, 'RESOLVED', 'resolved');
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
    // log(object) has no title to show; its table files are named 'log'.
    if (isMap(obj) || isRecord(obj)) return this.tableInternal(obj, undefined, 'log');
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
        this.tableInternal(item, undefined, `list item ${i}`);
      } else {
        this.msg(LogIntent.BASE, 'LOG', prefix + formatValue(item));
      }
    });
  }

  private renderTable(rows: Row[], title: string | undefined, heading: string): void {
    const normalized = rows.map((r) => entriesOf(r).map(([k, v]) => [k, redacted(k, v)] as [string, unknown]));
    const widths = new Map<string, number>();
    for (const row of normalized) {
      for (const [col, raw] of row) {
        const val = truncateCell(raw);
        widths.set(col, Math.max(widths.get(col) ?? col.length, col.length, val.length));
      }
    }
    const headers = [...widths.keys()];
    // themed() is '' when ansi is off or both fg and bg are off; the table's own bold/reset follow it.
    const color = themed(this.level, LogIntent.DATA, 'table');
    const styled = color !== '';
    const rst = styled ? RESET : '';
    const w = (h: string): number => widths.get(h)!;
    if (title) {
      // Widen the last column so a title longer than the table fits instead of being cut.
      const inner = headers.reduce((n, h) => n + w(h) + 3, -1);
      const need = title.length + 2;
      if (inner < need) widths.set(headers.at(-1)!, w(headers.at(-1)!) + need - inner);
    }

    const hBorder = '+' + headers.map((h) => '-'.repeat(w(h) + 2)).join('+') + '+';
    const headerRow = '|' + headers.map((h) => ' ' + truncateCell(h).padEnd(w(h)) + ' ').join('|') + '|';

    // The title and column-name rows are a darker shade of the table color (bold, like the rest). It is a
    // foreground, so it follows fg; after it, the table's own style is restored (background included).
    const headerStyled = styled && config().fg;
    const hdr = (line: string): string => (headerStyled ? TABLE_HEADER_FG + BOLD + line + color : line);

    const out: string[] = [hBorder];
    if (title) {
      out.push(hdr('|' + center(` ${title} `, headerRow.length - 2) + '|'));
      out.push(hBorder);
    }
    out.push(hdr(headerRow), hBorder);
    for (const row of normalized) {
      const byKey = new Map(row);
      out.push('|' + headers.map((h) => ' ' + truncateCell(byKey.get(h) ?? '').padEnd(w(h)) + ' ').join('|') + '|');
    }
    out.push(hBorder);

    const cfg = config();
    const file = nextTableFile(cfg, heading);
    const table: TableData = { title, headers, rows: normalized.map((r) => Object.fromEntries(r)), file };
    dispatch(this.level, null, color, 'TABLE', '\n' + out.join('\n') + rst, table);
    if (file !== undefined) {
      // Links the table in the traces to its files. DEBUG, so the console shows it only at level debug.
      const where = `attachments/csv/${file}.csv | attachments/json/${file}.json`;
      dispatch('DEBUG', LogIntent.DATA, themed('DEBUG', LogIntent.DATA, 'table'), 'TABLE FILES', where);
    }
  }

  private treeInternal(heading: string, f: Fields | undefined, intent: LogIntent, label: string, action?: LogAction): void {
    if (heading == null || f == null) return;
    this.msg(intent, label, heading, action);
    const entries = entriesOf(f);
    entries.forEach(([k, v], i) => {
      const prefix = i < entries.length - 1 ? '          ├─ ' : '          └─ ';
      this.msg(intent, label, `${prefix}${k.padEnd(12)}: ${formatValue(redacted(k, v))}`, action);
    });
  }

  /** `action` picks the line's own color within its intent family; without it the intent's color is used. */
  protected msg(intent: LogIntent, label: string, message: unknown, action?: LogAction): void {
    dispatch(this.level, intent, themed(this.level, intent, action), label, str(message));
  }
}
