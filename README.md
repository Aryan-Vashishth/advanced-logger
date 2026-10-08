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
npm install @aryan-vashishth/advanced-logger@0.2.0
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

Environment: `VOID_LOG_LEVEL` (debug/info/warn/error/off), `VOID_LOG_DIR`, `VOID_LOG_ANSI`, `VOID_LOG_FG`, `VOID_LOG_BG`, `VOID_LOG_JSONL`, `VOID_LOG_CONFIG`, `VOID_RUN_ID`, plus standard `NO_COLOR` / `FORCE_COLOR`. Boolean variables accept `1/true/yes/on` and `0/false/no/off`.
Code: `configure({ level, ansi, fg, bg, callerColor, tsFormat, segmentDivider, tableCellLimit, tableCellLimitEnabled, files, console, redactKeys, attach, ... })`.

The single theme (HIGH_CONTRAST) is on when ANSI is on: `enableAnsi()` / `disableAnsi()`.

### Config file

Put a `logger.config.ts` (or `.js`, `.cjs`, `.json`) in the project root, which is `process.cwd()`. The first one found, in that order, is loaded once per process, the first time the logger is used. Every Playwright worker is its own process, so every worker reads it.

```ts
// logger.config.ts
import { defineConfig } from '@aryan-vashishth/advanced-logger';

export default defineConfig({
  level: 'debug',
  fg: true,
  bg: false,
  redactKeys: ['password', 'token', 'pin'],
  files: { jsonl: true },
  projectRoots: [__dirname],
});
```

The default export is either a plain object (the same shape `configure()` accepts) or a function `(config) => patch`. The function receives a copy of the built-in defaults and returns a patch. `defineConfig()` only adds typing, and its type is exactly `LogConfigPatch`.

Precedence, lowest to highest:

1. Built-in defaults
2. Config file
3. Environment variables (`VOID_LOG_*`, `NO_COLOR`, `FORCE_COLOR`)
4. Explicit `configure()` calls in code

Notes:

- `configure()` inside Playwright's `globalSetup` does **not** reach the workers. `globalSetup` runs in the runner process, and each worker is a separate process with its own logger state. Only environment variables are inherited by workers (that is how `initRun()` shares the run id). A config file does reach them.
- Set `VOID_LOG_CONFIG` to use a different path (absolute, or relative to the working directory). Unlike the default lookup, an explicit path that does not exist is an error.
- No file at all is fine and changes nothing. A file that exists but throws, has the wrong shape, an unknown option name (for example a typo such as `levl`) or a wrongly typed value fails with an error that names the file. It keeps failing on every use until fixed.
- TypeScript files are loaded with `require()`, so Playwright's own transpiler (or Node's type stripping) handles them. Use `.js`, `.cjs` or `.json` if your runner cannot load `.ts`. There is no runtime dependency.
- An invalid `VOID_LOG_LEVEL` is ignored, so it never overrides the config file.
- `NO_COLOR` and `FORCE_COLOR` count as environment variables, so they beat `ansi` in the file. Terminal auto-detection does not: the file beats it.

### Colors: ansi, fg, bg, callerColor

| Option | Env | Default | Controls |
|---|---|---|---|
| `ansi` | `VOID_LOG_ANSI` | auto-detected | Master switch. `false` means no escape codes at all, whatever the other flags say. |
| `fg` | `VOID_LOG_FG` | `true` | Foreground colors: the text color per intent, and the level color on plain `log` lines. Bold goes with it. |
| `bg` | `VOID_LOG_BG` | `true` | The theme background. |
| `callerColor` | none | `false` | Colors the caller suffix separately (console, debug level). |

With `ansi: true`:

| `fg` | `bg` | Console line |
|---|---|---|
| true | true | foreground + background (the 0.1.0 output) |
| true | false | foreground only |
| false | true | background only |
| false | false | no escape codes on the line body |

- The background is a single color for every level. There is no per-level background; the level only picks the foreground, and only on plain `log` lines.
- `callerColor` is its own opt-in and is **not** gated by `fg`/`bg`. With `fg: false, bg: false, callerColor: true` the body is bare and only the caller suffix is colored. `ansi: false` silences it too.
- Tables, trees, rows and every action follow the same flags, including the table title's bold. Plain-text file sinks (partial, debug and full traces, JSONL) never contain escape codes.
- Runtime switches: `enableFg()` / `disableFg()` / `isFgEnabled()` and the `Bg` equivalents.

## Differences from the Java logger

- Custom themes, `setTheme`, `tsWidth/levelWidth/actionWidth` and `traceArrow` are dropped (the width and arrow settings were never used by the renderer).
- Caller frames from the logger's own folder are excluded by path. Java excluded frames by method-name prefix (`log`, `info`, ...), which also hides user methods such as `login()`; that is not reproduced.
- No file rotation or gzip archives.
- Added: secret redaction in fields/tables, JSONL sink, custom sinks (`addSink`), in-memory capture, Playwright fixture with log attachment, per-worker files.
