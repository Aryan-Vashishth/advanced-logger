import { resolveCaller } from './caller';
import { config, formatTs, infoLimitHint, levelEnabled, workerLabel } from './config';
import { type LogEvent, activeSinks } from './sinks';
import { type LevelName, LogIntent, resolveStyle } from './theme';

let currentTest: string | undefined;

/** Tag subsequent events (jsonl records) with the running test. Set by the Playwright fixture. */
export const setTestContext = (title: string | undefined): void => void (currentTest = title);
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
): void {
  const cfg = config();
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
    emit('DEBUG', intent, themed('DEBUG', intent), label === level ? 'DEBUG' : label, message);
    return;
  }
  emit(level, intent, color, label, message);
}

function emit(
  level: LevelName,
  intent: LogIntent | null,
  color: string,
  label: string,
  message: string | null | undefined,
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

export function themed(level: LevelName, intent: LogIntent): string {
  return config().ansi ? resolveStyle(level, intent) : '';
}
