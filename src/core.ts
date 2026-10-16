import { resolveCaller } from './caller';
import { config, formatTs, infoLimitHint, levelEnabled, workerLabel } from './config';
import { type LogEvent, type TableData, activeSinks } from './sinks';
import { maskText } from './redact';
import { type LevelName, type LogAction, LogIntent, resolveStyle } from './theme';

let currentTest: string | undefined;
let currentTitle: string | undefined;

/**
 * Tag subsequent events with the running test: `test` (the full path) goes to jsonl records, `title` (default: `test`)
 * to the consoleTest prefix. Set by the Playwright fixture.
 */
export function setTestContext(test: string | undefined, title?: string): void {
  currentTest = test;
  currentTitle = test === undefined ? undefined : (title ?? test);
}
export const getTestContext = (): string | undefined => currentTest;

/**
 * Single funnel for every log call. Sinks are asked first so no stack is captured
 * when nothing would write the event.
 */
export function dispatch(
  level: LevelName,
  intent: LogIntent | null,
  color: string,
  label: string,
  message: string | null | undefined,
  /** A rendered table's rows as data (sinks may write it out, e.g. the CSV/JSON attachments). */
  table?: TableData,
): void {
  const cfg = config();
  // Before truncation and every sink, so no output (console, files, jsonl, report attachment) holds the secret.
  if (cfg.redactText && message != null) message = maskText(message, cfg.redactKeys);
  const limit = cfg.infoLogsCharLimit;
  // Only INFO lines that the console would show, and never pre-colored blocks (tables, which have tableCellLimit).
  if (
    level === 'INFO' &&
    intent !== null &&
    limit != null &&
    limit > 0 &&
    message != null &&
    message.length > limit &&
    levelEnabled(cfg.level, 'INFO')
  ) {
    const total = message.length;
    emit(level, intent, color, label, `${message.slice(0, limit)}... (${total} chars)`);
    emit(
      'WARN',
      LogIntent.BASE,
      themed('WARN', LogIntent.BASE),
      'WARN',
      `INFO log exceeded the ${limit} char threshold (${total} chars). Refer to the debug logs to see the full text. ${infoLimitHint()}`,
    );
    // A plain log() line is labelled with its own level; the full-text copy is a DEBUG line, so relabel it.
    // BASE lines take the level's color, so the copy turns DEBUG grey; an action line keeps its own color.
    emit('DEBUG', intent, intent === LogIntent.BASE ? themed('DEBUG', intent) : color, label === level ? 'DEBUG' : label, message);
    return;
  }
  emit(level, intent, color, label, message, table);
}

function emit(
  level: LevelName,
  intent: LogIntent | null,
  color: string,
  label: string,
  message: string | null | undefined,
  table?: TableData,
): void {
  const cfg = config();
  const sinks = activeSinks().filter((s) => s.accepts(level, cfg));
  if (sinks.length === 0) return;

  const time = new Date();
  const { caller, chain } = resolveCaller(cfg);
  const ev: LogEvent = {
    time,
    ts: formatTs(cfg, time),
    level,
    intent,
    label,
    message: message ?? 'null',
    color,
    caller,
    chain,
    worker: workerLabel(),
    test: currentTest,
    testTitle: currentTitle,
    table,
  };
  for (const s of sinks) {
    try {
      s.write(ev, cfg);
    } catch (err) {
      // A logger must never fail a test. Report once to stderr and carry on.
      process.stderr.write(`[advanced-logger] sink failed: ${(err as Error).message}\n`);
    }
  }
}

export function themed(level: LevelName, intent: LogIntent, action?: LogAction): string {
  return config().ansi ? resolveStyle(level, intent, action) : '';
}
