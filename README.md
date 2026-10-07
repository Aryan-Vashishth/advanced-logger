# advanced-logger

Self-contained TypeScript port of the VOID `core.logging` package, for Playwright projects.
No runtime dependencies other than `@playwright/test` (optional, only needed for the `@aryan-vashishth/advanced-logger/playwright` entry).

## Installation

Published on npm as [`@aryan-vashishth/advanced-logger`](https://www.npmjs.com/package/@aryan-vashishth/advanced-logger). No registry login or token is needed, because the package is public.

```bash
npm install @aryan-vashishth/advanced-logger
```

Pin an exact version if you want reproducible installs:

```bash
npm install @aryan-vashishth/advanced-logger@0.1.0
```

Requirements:

- TypeScript types are bundled (`dist/*.d.ts`). The compiled output targets ES2022, and it is tested on Node 24.
- For the Playwright entry, `@playwright/test` >= 1.40.0 must be installed in your project (it is an optional peer dependency).

Check the installed version with `npm ls @aryan-vashishth/advanced-logger`, and update with `npm update @aryan-vashishth/advanced-logger`.

### Entry points

| Import | Use |
|---|---|
| `@aryan-vashishth/advanced-logger` | `info`, `warn`, `error`, `debug`, `fields`, `configure`, ... for page objects and helpers |
| `@aryan-vashishth/advanced-logger/playwright` | Drop-in `test` / `expect` that tag each test, print a banner and attach the log on failure |

### Quick start in a Playwright project

1. Install the package (above).
2. Create `global-setup.ts` so all workers share one run id:

   ```ts
   import { initRun } from '@aryan-vashishth/advanced-logger';
   export default async () => { initRun(); };
   ```

3. Reference it in `playwright.config.ts`: `globalSetup: './global-setup.ts'`.
4. In specs, import `test` and `expect` from `@aryan-vashishth/advanced-logger/playwright` instead of `@playwright/test`.
5. Run your tests. Logs are written under `./logs/<date>/` (change with `VOID_LOG_DIR`).

If the caller chain (`[CHAIN]` in `full-trace`) comes out empty, set the project root explicitly. It defaults to the working directory:

```ts
import { configure } from '@aryan-vashishth/advanced-logger';
configure({ projectRoots: [__dirname] });
```

### Uninstall or migrate from a git install

```bash
npm uninstall @aryan-vashishth/advanced-logger
```

If you previously installed from the GitHub URL, remove that dependency entry first so the lockfile stops recording `git+ssh://` addresses, then install from npm as shown above.

You can also copy `src/` into your own project (for example `src/logger/`) and import by relative path if you would rather not take a dependency.

## Usage

```ts
// tests: import test/expect from the Playwright entry so every test is tagged, bannered and its log attached on failure
import { test, expect } from '@aryan-vashishth/advanced-logger/playwright';
import { info, warn, error, fields } from '@aryan-vashishth/advanced-logger';

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
