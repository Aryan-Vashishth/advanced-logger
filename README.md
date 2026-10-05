# advanced-logger

Self-contained TypeScript port of the VOID `core.logging` package, for Playwright projects.
No runtime dependencies other than `@playwright/test` (optional, only needed for the `advanced-logger/playwright` entry).

Install it as a package (`npm install <path-or-git-url-to-this-repo>`), or copy `src/` directly into your own project (for example `src/logger/`) and import by relative path if you'd rather not take a dependency.

```ts
// tests: import test/expect from the Playwright entry so every test is tagged, bannered and its log attached on failure
import { test, expect } from 'advanced-logger/playwright';
import { info, warn, error, fields } from 'advanced-logger';

info.click('Submit');
info.log('Request', fields('method', 'POST'));
info.table([{ ID: 1, Name: 'Alice' }], 'Users');
```

```ts
// playwright.config.ts: share one run id across workers
globalSetup: './global-setup.ts'   // export default async () => { initRun(); }
```

## Output

| Target | Content |
|---|---|
| Console | Themed lines at or above the root level. Caller suffix shown only at `debug`. |
| `logs/<date>/partial-trace/` | Console-visible lines, plain text |
| `logs/<date>/debug-trace/` | Every level, plain text, caller suffix |
| `logs/<date>/full-trace/` | Every level, plain text, `[CHAIN]` suffix |
| `logs/<date>/jsonl/` | One JSON record per call (opt-in: `VOID_LOG_JSONL=1`) |

Files are written synchronously, one per Playwright worker (`...-w<index>.log`), so parallel workers never interleave and a crash loses nothing.

## Configuration

Environment: `VOID_LOG_LEVEL` (debug/info/warn/error/off), `VOID_LOG_DIR`, `VOID_LOG_ANSI`, `VOID_LOG_JSONL`, `VOID_RUN_ID`, plus standard `NO_COLOR` / `FORCE_COLOR`.
Code: `configure({ level, ansi, callerColor, tsFormat, segmentDivider, tableCellLimit, tableCellLimitEnabled, files, console, redactKeys, attach, ... })`.

The single theme (HIGH_CONTRAST) is on when ANSI is on: `enableAnsi()` / `disableAnsi()`.

## Differences from the Java logger

- Custom themes, `setTheme`, `tsWidth/levelWidth/actionWidth` and `traceArrow` are dropped (the width and arrow settings were never used by the renderer).
- Caller frames from the logger's own folder are excluded by path. Java excluded frames by method-name prefix (`log`, `info`, ...), which also hides user methods such as `login()`; that is not reproduced.
- No file rotation or gzip archives.
- Added: secret redaction in fields/tables, JSONL sink, custom sinks (`addSink`), in-memory capture, Playwright fixture with log attachment, per-worker files.
