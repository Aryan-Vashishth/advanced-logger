# advanced-logger: architecture (A to Z)

Package: `@aryan-vashishth/advanced-logger` (version in `package.json`).
A TypeScript logger for Playwright test projects. It is a port of the Java `core.logging` package ("VOID") with additions.
Runtime dependencies: none. `@playwright/test` is an optional peer dependency, needed only by the `/playwright` entry.

This document describes the code as it is. File and symbol names are exact. Behavior claims are backed by tests in `test/`.

---

## 1. What it does, in one paragraph

Test code calls `info.click('Submit')`, `warn.log('x')`, `error.table(rows, 'Failures')` and so on. Every call goes through one function (`dispatch` in `src/core.ts`), which builds a `LogEvent` and hands it to a list of sinks. Sinks write to the console (colored, one color per action), to three plain-text trace files, optionally to a JSONL file, to a CSV and a JSON file per logged table, to an in-memory buffer (used to attach the log to a Playwright report on failure), and to any custom sink. Configuration comes from four layers (defaults, config file, env vars, `configure()` calls). Each Playwright worker is a separate process with its own logger state, writing its own files.

## 2. Repository layout

```
src/
  index.ts        public API barrel (main entry)
  playwright.ts   Playwright entry: `test` (with auto fixture), `expect`, `initRun`
  logger.ts       the four level instances: debug, info, warn, error
  actions.ts      LogActions class (all action methods), fields(), formatValue()
  core.ts         dispatch(): the single funnel; INFO truncation; themed(); test context
  config.ts       LogConfig, defaults, layered build, configure(), env parsing, run id
  configFile.ts   logger.config.* discovery, loading, validation
  theme.ts        LogIntent, the one built-in theme, ACTION_FG (per-action colors), resolveStyle()
  redact.ts       maskText(): free-text secret masking (redactText)
  ansi.ts         escape-code factory, color catalog, stripAnsi
  caller.ts       stack parsing: "caller" suffix and "[CHAIN]"
  sinks.ts        Sink interface, built-in sinks, file writing, retention, registry
test/
  logger.test.ts, logger.aggressive.test.ts   core behavior (vitest)
  colors.test.ts        fg/bg/ansi/callerColor matrix
  config-file.test.ts   discovery, forms, precedence, failures
  truncate.test.ts      infoLogsCharLimit + its hint
  retention.test.ts     maxRuns, maxLogFiles, recent/missing-run-id guards
  separable.test.ts     consoleWorker, consoleTest, missing initRun() warning, configure() validation
  multi-worker.test.ts  spawns real Playwright with 2 workers (fixtures/multi-worker/)
  table-files.test.ts   CSV/JSON table attachments: names, contents, redaction, retention
  palette.test.ts, redaction.test.ts   per-action colors; nested and free-text redaction
  sweep/                npm run sweep: manual check of every console visual and every file, with file checks
  *.spec.ts, playwright*.config.ts, global-setup.ts   Playwright e2e/demo specs
dist/             tsc output (CommonJS, ES2022), gitignored, what npm publishes
```

Build: `tsc -p tsconfig.build.json` (module CommonJS, moduleResolution Node10, declarations + source maps, rootDir `src`). `prepare` runs the build on `npm install`/publish. Tests: `npm run test:unit` (vitest, `test/**/*.test.ts`), `npm run test:e2e` (Playwright, 2 workers, `test/*.spec.ts`, fixtures ignored), `npm test` runs both.

Published entry points (`package.json` `exports`):

| Import path | File | Purpose |
|---|---|---|
| `@aryan-vashishth/advanced-logger` | `dist/index.js` | `info/warn/error/debug`, `configure`, `defineConfig`, helpers |
| `@aryan-vashishth/advanced-logger/playwright` | `dist/playwright.js` | drop-in `test`/`expect` with logging fixture |

## 3. Module dependency graph

```
index.ts ──► logger ──► actions ──► core ──► caller
                          │          │ ├────► sinks
                          │          │ └────► theme
                          ├──► config ◄──────────────┐
                          └──► theme, ansi           │
config ──► configFile (runtime)      theme ──► config (runtime, reads fg/bg)
config ──► theme (type only)         configFile ──► config (types only)
sinks ──► config, theme, ansi        caller ──► config (type only)
playwright ──► config, core, sinks, logger
```

Two potential cycles are deliberately broken with `import type`: `config.ts` imports only the *type* `LevelName` from `theme.ts`, and `configFile.ts` imports only *types* from `config.ts`. `theme.ts` imports `config()` at runtime (to read `fg`/`bg`). Do not add runtime imports in the other direction.

## 4. The call path (the most important flow)

```
info.click('Submit')                         actions.ts  LogActions.click
  └► this.msg(LogIntent.INTERACTION, 'CLICK [>]', m, 'click')
       └► dispatch('INFO', intent, themed(level,intent,'click'), label, str(m))     core.ts
            1. cfg = config()                         (lazy build on first call, see §6)
            2. redactText: message = maskText(...)    (see §3, redaction)
            3. INFO truncation branch (see §11)       may emit 3 events and return
            4. emit(...):
                 a. sinks = activeSinks().filter(s => s.accepts(level, cfg))
                 b. if none accept: return            (no stack is ever captured)
                 c. resolveCaller(cfg)                caller.ts: parse new Error().stack
                 d. build LogEvent {time, ts, level, intent, label, message, color,
                                    caller, chain, worker, test}
                 e. for each sink: try { sink.write(ev, cfg) } catch -> one stderr line
```

Key properties:

- **Single funnel.** Everything (actions, tables, trees, Playwright fixture banner lines) ends in `dispatch`. Cross-cutting features (free-text masking, truncation) live there.
- **Cheap rejection first.** `Sink.accepts(level, cfg)` runs before any stack capture, which is the expensive part. If the root level hides the line and file sinks are off, no stack is captured.
- **A logger never fails a test.** A throwing sink is caught and reported once per call on stderr. The one deliberate exception is a broken config file (see §7), which throws.
- **Color is baked at call time.** `themed()` computes the escape prefix when the action is called and stores it in `LogEvent.color`. Sinks do not recompute it.

### Level instances and actions

`logger.ts` exports four `LogActions` instances: `debug`, `info`, `warn`, `error`. `LogActions` (`actions.ts`) has one method per action, each a thin wrapper `this.msg(intent, label, message)`:

| Intent | Methods (label) |
|---|---|
| INTERACTION | click, checkbox, text, input, dropdown, toggle, upload, hover, clear, key, password (masked) |
| NAVIGATION | navigate, tab, frame, breadcrumb |
| OBSERVE | wait, search, result |
| VERIFY | verifying |
| SUCCESS | success, complete, resolved |
| ALERT | error, failed, timeout, validation, fallback, skip |
| DATA | grid, table, row |
| BASE | log, tree |

Composite methods:

- `log(...)` is overloaded: string; object/array/map (table or indexed list); `(heading, fields)` or `(heading, k, v, ...)` (tree); `(heading, value)`.
- `table(rows, title)` renders an ASCII table through `renderTable`, then calls `dispatch(level, null, color, 'TABLE', ...)` with **intent `null`** (a pre-colored block). `table("text")` is just a TABLE line. The title is required by the type. At runtime a missing or blank title is allowed (plain JS, older code): `warnOnce` asks for one, the table renders without a title row, and its files get the heading `untitled`. `tableInternal(data, title, heading)` separates the console title row (`title`, may be undefined) from the file heading: `log(object)` uses no title row and the heading `log`, a logged list's items `list item N`. A title longer than the table widens the last column instead of being cut.
- `row`, `tree`, `resolved` emit several `msg()` lines (one `dispatch` each).
- Redaction, structured: `redacted(key, v)` prints `***` when the key contains any of `redactKeys` (case-insensitive substring), else returns `redactDeep(v)`: a copy with sensitive keys masked at any depth in plain objects, Maps and arrays (a `toJSON()` result is redacted instead of the object; cycles become `[Circular]`; the caller's object is never touched). Used by tree, table and row.
- Redaction, free text (`redact.ts`, when `redactText`): `dispatch` runs `maskText(message, redactKeys)` before truncation and before any sink, so every output is masked. It masks the value in `key=value`, `key: value`, `"key":"value"` and `'key': 'value'` when the key contains a sensitive word, plus `Bearer|Basic <credentials>`. The pair regex is built from `redactKeys` and cached per key list. Pattern-based, so it can miss or over-mask (README lists the limits).
- Colors: `msg(intent, label, m, action?)` passes the action name (`'click'`, ...) so `themed()` can pick the action's own color (§10).
- Malformed arguments never throw (`safeFields` keeps a dangling key under `(unpaired)`); `fields()` itself throws on an odd count by design.

## 5. The event model

```ts
interface LogEvent {
  time: Date; ts: string;          // ts is pre-formatted via cfg.tsFormat
  level: 'DEBUG'|'INFO'|'WARN'|'ERROR';
  intent: LogIntent | null;        // null = pre-colored block (table)
  label: string;                   // e.g. 'CLICK [>]', 'INFO', 'TABLE'
  message: string;                 // may be multi-line
  color: string;                   // resolved ANSI prefix; '' means none
  caller: string;                  // "Callee.method ← Caller.method", plain text
  chain: string;                   // in-project call chain, leaf first, plain text
  worker: string;                  // 'w<TEST_WORKER_INDEX>' or 'main'
  test?: string;                   // full title path, set by the Playwright fixture (jsonl)
  testTitle?: string;              // the test's own title (consoleTest prefix)
  table?: TableData;               // a rendered table as data: {title, headers, rows, file}
}
interface Sink { accepts(level, cfg): boolean; write(ev, cfg): void }
```

Rendered line shape: `<ts> │ <label> │ <message line>` where `│` is `cfg.segmentDivider`. Multi-line messages are split on a Java-`\R`-equivalent regex (`LINE_BREAKS`) and each line gets its own prefix.

## 6. Configuration

### 6.1 `LogConfig` (every option)

| Option | Type / default | Meaning |
|---|---|---|
| `level` | `'debug'\|'info'\|'warn'\|'error'\|'off'`, `info` | Root threshold for console + partial-trace |
| `ansi` | bool, auto-detected | Master color switch. `false` overrides `fg`, `bg`, `callerColor` |
| `fg` | bool, `true` | Foreground colors (intent color; level color on BASE lines; bold) |
| `bg` | bool, `true` | The theme background (one constant, `BG_BLACK`, for all levels) |
| `callerColor` | bool, `false` | Color the caller suffix separately (console, debug level). Independent of fg/bg |
| `infoLogsCharLimit` | number\|null, `null` | INFO truncation limit (§11). null/0 = off |
| `maxRuns` | number\|null, `null` | Retention per trace kind, in whole runs (§12). null/0 = off |
| `recentRunMinutes` | number, `60` | Retention never deletes a run touched this recently (§12). 0 = off |
| `maxLogFiles` | number\|null, `null` | Retention per trace kind, in files (§12). null/0 = off |
| `consoleWorker` | bool, `false` | Console lines prefixed `w<N> │ ` (§9) |
| `consoleTest` | bool, `false` | Console lines prefixed with the test title, max 40 chars (§9) |
| `tsFormat` | string\|fn, `yyyy-MM-dd HH:mm:ss.SSS` | Java-style pattern or `(Date)=>string` |
| `segmentDivider` | string, `' │ '` | Column separator |
| `tableCellLimit`, `tableCellLimitEnabled` | 40, false | Truncate table/row cells |
| `suppressContains`, `suppressMethodPrefixes`, `includeOnlyPrefixes` | Sets | Caller/chain frame filters (§8) |
| `projectRoots` | string[], `[cwd]` | Frames under these form the `[CHAIN]` |
| `console` | bool, true | Console sink on/off |
| `files` | `{debugTrace, partialTrace, fullTrace, jsonl, tables}` | Per-file toggles (jsonl default false; tables, the CSV/JSON table attachments, default true) |
| `logDir` | string, `./logs` | Output root |
| `githubAnnotations` | bool, `GITHUB_ACTIONS==='true'` | Emit `::error::`/`::warning::` lines |
| `redactKeys` | string[] | Keys masked in structured output (any depth) and, with `redactText`, in free text |
| `redactText` | bool, `true` | Mask `key=value`-style secrets and `Bearer`/`Basic` credentials in message text (§3) |
| `attach` | `'on-failure'\|'always'\|'never'` | Playwright attachment policy |

`LogConfigPatch` = `Partial<LogConfig>` with the Set-typed fields accepting any iterable and `files` partial. It is the type `configure()` and config files accept.

### 6.2 Layers and precedence (lowest to highest)

1. **Built-in defaults**: `builtinDefaults(env)` in `config.ts`. Only terminal/CI heuristics for `ansi` and `GITHUB_ACTIONS` for annotations read the environment here.
2. **Config file** (`logger.config.*`, §7).
3. **Environment variables**: `applyEnv()`.
4. **`configure()` calls** in code mutate the live object afterwards, so they always win.

Environment variables: `VOID_LOG_LEVEL`, `VOID_LOG_DIR`, `VOID_LOG_ANSI`, `VOID_LOG_FG`, `VOID_LOG_BG`, `VOID_LOG_JSONL`, `VOID_LOG_TABLES`, `VOID_LOG_INFO_LOGS_CHAR_LIMIT`, `VOID_LOG_MAX_RUNS`, `VOID_LOG_MAX_FILES`, `VOID_LOG_RECENT_RUN_MINUTES`, `VOID_LOG_REDACT_TEXT`, `VOID_LOG_CONFIG`, `VOID_RUN_ID`, `VOID_RUN_DATE`, plus `NO_COLOR` / `FORCE_COLOR`. Booleans: `1/true/yes/on` true, anything else non-empty false. An invalid level or non-numeric limit is ignored (so it cannot override a lower layer). `NO_COLOR`/`FORCE_COLOR` count as env-level (they beat `ansi` in a file); terminal auto-detection counts as default-level (the file beats it). See `explicitAnsi()` vs `heuristicAnsi()`.

### 6.3 Lazy, per-process state

`config.ts` holds module state `CURRENT: LogConfig | undefined`.

- `config()` returns `CURRENT ?? build()`. The first call in a process builds the config (including reading the config file). Every process, including each Playwright worker, does this independently.
- `build()` sets `CURRENT = cfg` early as a **re-entrancy guard**: a config file that imports this package and touches `config()` while loading sees the defaults instead of recursing. On failure it sets `CURRENT = undefined` and rethrows, so every later call throws again (no silent fallback to defaults).
- `configure(patch | fn)`, the `enable*/disable*` mutators, and every internal reader go through `config()`, so they trigger the load first. Therefore a `configure()` call made before any log call still sits above the file.
- `configure(patch)` runs the patch through `checkPatch` (the config file's validator, §7) with the source label `configure()`. Unlike a file, it never throws: each problem is written to stderr once per process (`WARNED`, cleared by `resetConfig()`) and that key is left out; the rest applies. A non-object patch warns and is ignored.
- `configure(fn)` snapshots the config (`cloneConfig`), runs the callback on the live object, then `checkLive` turns arrays assigned to the three Set-typed options into Sets and runs `checkPatch` over the whole live config with the label `configure() callback`. Each problem warns once and is undone: a wrong-typed option goes back to its snapshot value, an unknown option or `files` entry is deleted. `checkPatch` reports each problem with its key (`PatchProblem`) for this.
- `resetConfig()` clears `CURRENT`, forgets the cached config file (`forgetConfigFile()` deletes it from `require.cache`), and rebuilds. Used by tests.
- A mutable `LIMIT_SOURCE` records which layer set `infoLogsCharLimit` (`default|file|env|code`) for the truncation hint.

**Process model consequence** (verified by `multi-worker.test.ts`): `configure()` inside Playwright's `globalSetup` runs in the runner process and does **not** reach workers. Only env vars are inherited. That is why `initRun()` communicates through `process.env.VOID_RUN_ID`/`VOID_RUN_DATE`, and why the config file exists.

## 7. Config file loading (`configFile.ts`)

- Discovery in `process.cwd()`: `logger.config.ts`, `.js`, `.cjs`, `.json`, first existing wins (`CONFIG_FILE_NAMES`). No file: silently fine, behavior identical to 0.1.0.
- `VOID_LOG_CONFIG` overrides the path (resolved against cwd). An explicit path that does not exist **throws** (deliberate: a typo should not be silent).
- Loaded with a lazy `require(file)` inside `loadConfigFile`. Under Playwright, its TypeScript hook transpiles `.ts`; under plain Node, type stripping or CJS handles it. No transpiler dependency. `unwrapDefault` handles `__esModule` interop (`export default`), `module.exports =`, and JSON.
- Forms: a plain object (`LogConfigPatch`) or `(config: LogConfig) => LogConfigPatch`. The function receives a **clone** of the defaults (`cloneConfig`), so it cannot mutate live state. `defineConfig()` is an identity helper for typing.
- Validation (table `KEYS`): `checkPatch(value, where)` returns the clean patch plus one message per problem (unknown option name, such as a typo like `levl`; wrong type; bad `files` sub-key), and drops `undefined` values. `validatePatch` throws the first problem for a file; `configure()` warns about each one instead (§6.3). File error messages contain the absolute file path; load failures (`fail()`) wrap the original in `cause`.
- Loaded once per process (Node's require cache plus `CURRENT`). `loadedConfigFile()` exposes the path for messages.

## 8. Caller and chain resolution (`caller.ts`)

Parses `new Error().stack` (limit raised to 60 temporarily) with `FRAME_RE`. `displayName()` turns frames into readable names:

- `Class.method` when V8 reports a type (instance, static, async, class-field arrow all verified); `Class.(constructor)` for `new`.
- Free functions and plain-object types (`Object`, `Module`, `Function`, ...) become `<fileBase>.<function>`.
- Frames inside the logger's own folder (`SELF_DIR`, computed at load from this file's path) are always dropped. This replaces the Java logger's method-name-prefix suppression, so user methods like `login()` are not hidden.

Two outputs:

- `caller`: first surviving frame is the callee, the next frame with a different display name is the caller: `Callee ← Caller`.
- `chain`: every surviving frame under `projectRoots` (excluding `node_modules`/`node:`), consecutive duplicates collapsed, leaf first, joined by ` ← `.

Filters: `suppressMethodPrefixes`, `includeOnlyPrefixes` (path or display prefix), `suppressContains` (default `node_modules`, `node:`, `<anonymous>`).

If the chain comes out empty, `projectRoots` does not cover the test code; set `configure({ projectRoots: [__dirname] })`.

## 9. Output sinks (`sinks.ts`)

`activeSinks()` returns, in order: console, partial-trace, debug-trace, full-trace, jsonl, capture, then custom sinks (`addSink`/`removeSink`).

| Sink | accepts | Content |
|---|---|---|
| console | `cfg.console` and level ≥ root | Colored line; caller suffix only when root level is `debug` |
| partial-trace | file toggle and level ≥ root | Same lines as console, plain text |
| debug-trace | file toggle, **all levels** | Plain text + caller suffix |
| full-trace | file toggle, **all levels** | Plain text + `[CHAIN] <chain>` suffix |
| jsonl | `files.jsonl` | One JSON record per event (opt-in) |
| table files | `files.tables`, **all levels**; acts only on events with `ev.table.file` | `attachments/{csv,json}/<runId>-<worker>/<NNN>-<heading>.{csv,json}` per table |
| capture | an active capture exists and level ≥ root | In-memory lines for the Playwright attachment |

Files: `<logDir>/<runDate>/<kind>/<kind>-<runId>-<worker>.log` (`traceFilePath`). Writes are **synchronous** (`fs.writeSync` on cached fds in `FD_CACHE`), one file per worker, so parallel workers never interleave and a crash loses nothing. Every file line is prefixed `w<N> │ ` and passes through `stripAnsi`, so **plain-text sinks never contain escape codes** regardless of color flags. `closeAllFiles()` closes fds (and clears prune bookkeeping).

Table attachments (`tableFilesSink`): `renderTable` (actions.ts) asks `nextTableFile(cfg, heading)` for a name, `<runId>-<worker>/<NNN>-<slug>`. The folder `<runId>-<worker>` is the part all of this worker's trace files share (`<kind>-<runId>-<worker>.log`), so each parent log has its own folder under `attachments/csv/` and `attachments/json/`. `NNN` comes from a per-process counter that is never reset; a number whose CSV or JSON already exists (another process with the same run id and worker label) is skipped, never overwritten. `headingSlug` lowercases the heading, turns every run of non-letters/digits (Unicode `p{L}p{N}`) into `-`, cuts at 40 chars, and falls back to `table`. The table is dispatched with a `TableData` payload: headers in render order and rows as plain objects, already redacted by key at any depth (`redactDeep`) and never truncated; `file` is the relative name. The sink writes both files with `writeFileSync` (`tableFilePath` joins the folder); with `redactText` it masks each string value and the title (`maskStrings`), never the serialized text, which would break JSON. CSV (`tableToCsv`): BOM, CRLF, RFC 4180 quoting, objects as JSON, a leading `'` on text cells starting with `= + - @` (except plain negative numbers). JSON (`tableToJson`): `{title, time, level, worker, runId, test, columns, rows}`, with a replacer for Map, Set, bigint and Error. After the table, `renderTable` dispatches a DEBUG `TABLE FILES │ attachments/csv/<file>.csv | attachments/json/<file>.json` line, so debug-trace and full-trace point to the files. Custom sinks see `ev.table` too.

Console rendering (`consoleSink`):
- Opt-in prefix (`consolePrefix`), placed before the timestamp and inside the color block: `w<N> │ ` when `consoleWorker`, then `<testTitle> │ ` when `consoleTest` and a test is running (line breaks flattened, cut to `TEST_TAG_MAX` = 40 chars with `...`). The worker part uses a literal ` │ `, like the file prefix, not `segmentDivider`. The GitHub annotation text carries the same prefix. File sinks do not use it: they are already per worker, and tests are bracketed by `TEST START`/`TEST END`.
- `ansi` off: plain.
- `ansi` on: `wrap(s) = ev.color ? ev.color + s + RESET : s`. When `fg` and `bg` are both off, `ev.color` is `''` and the body is bare (no stray reset).
- `callerColor` on and a caller exists: body wrapped, then `div + CALLER_FG + caller + RESET`. Not gated by `fg`/`bg`; only `ansi:false` silences it.
- `githubAnnotations`: after each line, `::error::`/`::warning::` for ERROR/ALERT/WARN events.

## 10. Color model (`theme.ts`, `ansi.ts`)

One built-in theme (HIGH_CONTRAST). `resolveStyle(level, intent, action?)` = foreground + background:

- Foreground: for `BASE` intent, `LEVEL_FG[level]` (white, amber, red, grey, all bold). Otherwise `ACTION_FG[action] + BOLD` when the line has an action, else `INTENT_FG[intent]` (the family's anchor color, for custom `LogActions` subclasses that call `msg` without an action). Neither depends on the level.
- `ACTION_FG` gives each of the 31 actions its own 24-bit color inside its intent's hue family: interaction blues, navigation teals, observe pinks, verify gold, data violets, success greens, alert reds and oranges. ERROR and `failed` share `ERROR_RED` (248,75,75). The values were chosen in OKLCH and are enforced by `palette.test.ts`: contrast at least 4.5 on `#1e1e1e`, CIEDE2000 at least 10 within a family and 12 across families (including the INFO and WARN level colors). Change a color only with that test passing.
- Background: constant `BG_BLACK` for every level (there is no per-level background).
- `config().fg` false drops the foreground part; `config().bg` false drops the background; both false returns `''`.
- `themed(level, intent, action?)` in `core.ts` returns `''` when `ansi` is off, else `resolveStyle`. The DEBUG copy made by INFO truncation reuses the original line's color unless it is a BASE line (which turns DEBUG grey).
- Tables: the title row is wrapped as `TABLE_TITLE_FG + BOLD + line + color` and the column-name row as `TABLE_COLUMNS_FG + BOLD + line + color`, then the table's own style is restored so the background continues. Both are darker than the body and differ from each other: the title is dark and saturated (4.66:1 on `#1e1e1e`, CIEDE2000 25.8 from the body), the columns a muted mid shade of the same hue (6.15:1; 15.6 from the body, 14.9 from the title). A more saturated column color would drift into the observe pinks; `palette.test.ts` checks all of this. Only when a style exists and `fg` is on (these are foregrounds). Borders and data rows use the table color.

`ansi.ts` is a catalog and factory (`sgr`, `fg16`, `rgbFg`, ... named `FG_*`, `BG_*`, `RGB_FG`, ...), plus `stripAnsi` and `fgFromStyle`.

## 11. INFO truncation (`infoLogsCharLimit`, in `dispatch`)

Condition: `level==='INFO'`, `intent !== null` (tables excluded; they have `tableCellLimit`), limit > 0, message longer than the limit, and INFO is visible at the root level (otherwise nothing is truncated or warned, since the traces already hold the full text).

Then three events are emitted via `emit()`:

1. INFO, original label: `message.slice(0, limit) + '... (<total> chars)'`
2. WARN, label `WARN`: `INFO log exceeded the <limit> char threshold (<total> chars). Refer to the debug logs to see the full text. <hint>`
3. DEBUG, same label (a plain `log` line's `INFO` label becomes `DEBUG`), full text.

`infoLimitHint()` (in `config.ts`) tells the reader what to edit, depending on `LIMIT_SOURCE`: the config file's absolute path, the env var name, or the `configure()` call.

## 12. Log file retention (`maxRuns`, `maxLogFiles`, in `sinks.ts`)

`pruneOnce(cfg, kind)` runs after the first write of each kind in a process (guarded by `PRUNED`). It lists `<logDir>/*/<kind>/<kind>-*.(log|jsonl)` across all date folders and groups files by run id, parsed from `<kind>-<runId>-<main|wN>.<ext>` (a name without a worker suffix counts as its own run). A run's age is its newest file's mtime.

- `maxLogFiles`: of the files outside the current run, the newest `maxLogFiles - currentRunFiles` are kept.
- `maxRuns`: of the runs other than the current one, the newest `maxRuns - 1` are kept; older runs are marked whole.
- A file goes if either limit marks it. Then two guards apply: files whose name contains the current run id are never marked (parallel workers share it), and a run whose newest file is younger than `recentRunMinutes` (default 60; 0 = no such guard) is never deleted, because another runner or CI shard may still be writing it. Neither limit is a hard cap.
- Skipped entirely when `runIdMissing()` (§13): without a shared run id, each worker's "current run" is its own pid-based id, and its siblings' live files would look like an older run.

Kinds are described by `pruneSpec(kind)`: folder, the names this logger owns, the run-id regex, and whether files sit in per-worker folders. Besides the four trace kinds there are `table-csv` and `table-json` (folders `attachments/csv`, `attachments/json`), whose files sit one level down in `<runId>-<worker>` folders (`perWorkerFolders`): `listKind` reads the run id from the folder name, so a table heading can never confuse it, and folders or files not named like the logger's own are left alone. Attachments are pruned by `maxRuns` only (`byFileCount: false`): a table count says nothing about runs. Folders left empty are removed upward (worker folder, kind, `attachments`, date), never `logDir` itself. Best effort; all errors swallowed.

## 13. Run identity and workers (`config.ts`)

- `initRun()` (call from `globalSetup`) sets `process.env.VOID_RUN_ID` and `VOID_RUN_DATE` if absent, so every worker (which inherits env) shares one run id. `getRun()` falls back to a per-process id if unset.
- `runIdMissing()` is true in a Playwright worker (`TEST_WORKER_INDEX` set) without `VOID_RUN_ID`, meaning `initRun()` was never called in the runner. Then `traceFilePath` writes one stderr warning per process (`RUN_ID_WARNED`, reset by `closeAllFiles()`) and retention is off (§12). A worker cannot fix this itself: env it sets is not seen by its siblings.
- Only process-based workers are supported. A `worker_threads` thread starts with a copy of its parent's `process.env`, so it gets the same `workerLabel()` and run id, and appends to the same files through its own fds, with no way to tell its lines apart.
- `workerLabel()` is `w<TEST_WORKER_INDEX>` under Playwright, else `main`. It appears in file names, line prefixes and events.

## 14. Playwright integration (`playwright.ts`)

`test = base.extend({ voidLog: [fn, { auto: true }] })`: an auto fixture active for every test. Per test it: sets the test context (`setTestContext(titlePath.join(' > '), title)`: the path tags JSONL records, the title feeds `consoleTest`), starts a `captureLogs()` buffer, logs `TEST START`, runs the test, then logs `TEST END | status | ms` (`error.failed` on failure, `info.success` otherwise), and attaches the captured text as `void-log` per `cfg.attach` (`on-failure` default). It also re-exports `expect` and `initRun`. Tests import `test`/`expect` from this entry instead of `@playwright/test`.

## 15. Extension points

- **Custom sink**: `addSink({ accepts(level,cfg){...}, write(ev,cfg){...} })`. Receives the same `LogEvent`; `ev.color` is ANSI, strip it for plain output.
- **In-memory capture**: `captureLogs()` returns `{ text(), stop() }`.
- **New action**: add a method in `LogActions` calling `this.msg(intent, label, m, 'name')`, give `name` a color in `ACTION_FG` (in its intent's hue family), and add it to `FAMILIES` in `palette.test.ts`; that test then checks the color's contrast and distance from the others. For a new intent, add it to `LogIntent` and `INTENT_FG` in `theme.ts`.
- **New config option**: add to `LogConfig` and `builtinDefaults`; add to the `KEYS` table in `configFile.ts` (validation); optionally an env var in `applyEnv`; document in README; add tests. `LogConfigPatch` updates automatically.

## 16. Invariants and gotchas (read before changing code)

1. Everything goes through `dispatch`. Do not write to sinks directly.
2. Do not capture a stack before `accepts()` has approved at least one sink.
3. `config.ts` <-> `theme.ts`/`configFile.ts` cycles are avoided with `import type`. Keep it that way.
4. File sinks must stay escape-free: they rely on `stripAnsi` at write time.
5. `intent === null` means "pre-colored block" (tables). Truncation and `callerColor` logic assume this.
6. `configure()` must go through `config()` so the config file is loaded first; never touch `CURRENT` directly elsewhere.
7. A bad config file must keep throwing (no silent fallback). `build()` resets `CURRENT` on failure for this reason.
8. Files are written synchronously on purpose; do not buffer.
9. Default console colors changed once, deliberately, in 0.4.0 (per-action colors). Any further change to default colors is a minor version, needs a CHANGELOG entry, and must keep `palette.test.ts` passing. Files never contain colors.
10. Config is built lazily at first use (not at import). An env var changed between import and the first log call is honored; this is the one intentional difference from 0.1.0.
11. In regexes written inside template literals, escape backslashes (`\\.`); a past bug came from exactly this.
12. Retention must never run in a worker without a shared run id (`runIdMissing()`), and must never delete the current run or a run touched within `recentRunMinutes` (unless it is 0).
13. `configure()` never throws on bad input, in either form; it warns and skips (or reverts). Only a config file fails loudly.
14. New output options that change line format default to off, so existing console and file output stays byte-identical. The one exception is masking secrets (`redactText`, on since 0.4.0): leaking a secret by default is worse than changing a line.
15. Free-text masking runs in `dispatch` before truncation and before any sink. Do not move it into a sink, or some outputs would hold the secret.

## 17. Differences from the Java logger

Dropped: custom themes, `setTheme`, width/arrow settings, file rotation and gzip archives. Changed: caller frames are excluded by path rather than method-name prefix. Added: secret redaction, JSONL sink, custom sinks, in-memory capture, Playwright fixture with attachment, per-worker files, config file, `fg`/`bg`, INFO truncation, file and run retention, console worker/test prefixes, per-action colors, nested and free-text redaction.

## 18. Testing map

| Behavior | Test file |
|---|---|
| Console/file output, levels, caller/chain, redaction, malformed input | `logger.test.ts`, `logger.aggressive.test.ts` |
| fg/bg/ansi/callerColor combinations across all actions, env parsing | `colors.test.ts` |
| Discovery order, forms, precedence, `VOID_LOG_CONFIG`, loud failures | `config-file.test.ts` |
| Truncation text, WARN/DEBUG lines, hint by source | `truncate.test.ts` |
| Retention by files and runs, protection of current and recent runs, missing run id, foreign files | `retention.test.ts` |
| consoleWorker/consoleTest prefixes, missing-run-id warning, `configure()` patch and callback validation | `separable.test.ts` |
| Per-action colors, palette contrast and distance limits | `palette.test.ts` (+ `helpers/color-metrics.ts`) |
| Nested redaction, free-text masking | `redaction.test.ts` |
| Table CSV/JSON attachments: names, link line, formatting, redaction, retention | `table-files.test.ts` |
| Everything at once, by eye, plus automatic file checks | `npm run sweep` (`test/sweep/`; writes to `./logs` like any run, and checks only its own run id's files) |
| Real Playwright, 2 workers, `.ts` config, `globalSetup` isolation, console prefixes, shared vs split run id | `multi-worker.test.ts` + `fixtures/multi-worker/` |
| Visual/e2e demos | `*.spec.ts` via `test/playwright.config.ts` |

Tests use `resetConfig()` plus `configure({ logDir: tmp, ansi: false, tsFormat: () => 'TS' })` for deterministic output, and spy on `process.stdout.write`. Config-file tests `chdir` into a temp dir so no stray `logger.config.*` leaks in.
