# Changelog

All notable changes to `@aryan-vashishth/advanced-logger`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). While the version is below 1.0.0, a minor release may add options but keeps existing defaults and output unchanged unless noted.

## [0.4.0] - 2026-10-16

Gives every action its own console color, writes every logged table to CSV and JSON files, and closes three redaction gaps. **Default console colors change**, **`table()` now requires a title in TypeScript**, secrets in message text are now masked by default, and each logged table now also creates two files. Trace files and JSONL have no colors, so only the masking affects them.

### Changed

- **Every action has its own console color.** Before, all 11 interaction actions (`click`, `input`, `text`, ...) shared one color, the same bold white as a plain INFO line. Now each action has a distinct color within a hue family for its kind: interactions in blues, navigation in teals, observation in pinks, verification in gold, data in violets, success in greens, alerts in reds and oranges (`skip` is muted). Plain `log` lines keep their level's color. Every color has at least 4.5:1 contrast on a dark terminal and is clearly distinct from its neighbors; `palette.test.ts` enforces both.
- The ERROR level red (and the `failed` action, which shares it) is brighter: (248,75,75) instead of (210,48,48), which was under 4.5:1 contrast on a dark terminal.
- **Breaking for TypeScript: `table(rows, title)` requires a title**, which is shown above the table and names its files. `info.table(rows)` without one no longer compiles. At runtime it still works (plain JavaScript, older compiled code): the table renders without a title row, its files are named `untitled`, and a one-time warning asks for a title. `info.log(object)` keeps rendering without a title row and names its files `log`; a logged list's tables are `list-item-N`.
- Table headers stand apart from the data: the title row is a dark violet (`TABLE_TITLE_FG`) and the column-name row a muted mid violet (`TABLE_COLUMNS_FG`), both exported, while borders and data rows keep the table color.
- **Structured redaction works at any depth.** `fields('user', { password })` now prints `"password":"***"`; before, a nested object printed in clear. Arrays, Maps and `toJSON()` results are checked too, and the caller's object is never modified.
- `configure((cfg) => ...)` callbacks are now checked like `configure({...})`. An unknown option or wrong-typed value set in the callback prints one warning and is undone. An array assigned to a Set-typed option (`suppressContains`, `suppressMethodPrefixes`, `includeOnlyPrefixes`) becomes a Set.

### Added

- **Table attachments** (`files.tables`, default `true`, env `VOID_LOG_TABLES`): every logged table also gets a CSV and a JSON file, in one folder per parent log: `<logDir>/<date>/attachments/csv/<runId>-<worker>/<NNN>-<title>.csv` and the same under `attachments/json/`. The folder `<runId>-<worker>` matches the trace files (`<kind>-<runId>-<worker>.log`) the table appears in, `<NNN>` keeps log order, and a DEBUG `TABLE FILES` line after each table in debug-trace and full-trace names both files. Cells hold full values (no `tableCellLimit`) and are redacted like the console. CSV is UTF-8 with a BOM, CRLF line ends and RFC 4180 quoting, and text cells that a spreadsheet would run as a formula get a leading `'`. JSON holds the title, time, level, worker, run id, test, columns and rows. `maxRuns` deletes a run's attachment folders with its logs.
- `LogEvent.table` (`TableData`): a rendered table's rows as data, for custom sinks. `tableFilePath()` is exported.
- `redactText` option (default `true`, env `VOID_LOG_REDACT_TEXT`): masks secrets in free text, in `key=value`, `key: value`, `"key":"value"` and `'key': 'value'` forms where the key contains one of `redactKeys`, plus `Bearer` and `Basic` credentials. It runs once before every output, including the Playwright attachment. It is pattern-based, so it can miss a secret with no key next to it and can mask a harmless value whose key contains a sensitive word (`tokens=3`).
- `recentRunMinutes` option (default `60`, env `VOID_LOG_RECENT_RUN_MINUTES`): how recently a run must have been written to for retention to keep it. Before, this was a fixed hour. `0` protects only the current run.
- `ACTION_FG` (the per-action colors) and the `LogAction` type are exported.
- `LogActions.msg()` takes an optional action name, which picks that action's color.

### Fixed

- A blank entry in `redactKeys` (such as `''`) no longer masks every structured value. Blank entries are ignored, as free-text masking already did.
- A table title longer than the table was cut off on the console. The table now widens to fit it.
- A table title no longer ends with a full style reset, which dropped the background for the rest of that line.

## [0.3.0] - 2026-10-14

Makes mixed logs from parallel runs separable, and stops a missing setup step from scattering or deleting logs. Console and file output are unchanged unless you turn on the new options.

### Added

- `maxRuns` option (env `VOID_LOG_MAX_RUNS`): keeps the newest N runs per trace kind, current run included, and deletes older runs whole. A run's age is its newest file's modification time.
- `consoleWorker` option (default `false`): prefixes console lines with the worker, `w<N> │ ` (or `main │ ` outside Playwright), the same prefix trace-file lines already have.
- `consoleTest` option (default `false`): prefixes console lines with the running test's title, cut to 40 characters. Needs the Playwright fixture.
- A one-time stderr warning in a Playwright worker that has no `VOID_RUN_ID`, meaning `initRun()` was never called in `globalSetup`.
- `runIdMissing()` export, true in that situation.
- `setTestContext(test, title?)` takes an optional short title for the console prefix. The Playwright fixture passes the test's own title.
- `LogEvent.testTitle` for custom sinks.
- README sections on redaction scope (only top-level structured keys are masked; free text and nested objects are not) and on `worker_threads` (not supported).

### Changed

- `configure({...})` now checks its patch with the config file's validator. An unknown option or a wrongly typed value prints one stderr warning and is skipped; the rest of the patch still applies. It never throws. Before, any key and value were stored as given. The callback form, `configure((cfg) => ...)`, is not checked.
- Retention (`maxLogFiles` and `maxRuns`) never deletes a run that has a file modified in the last hour, so another runner or CI shard writing to the same folder keeps its files. Neither limit is a hard cap.
- GitHub annotation lines carry the `consoleWorker` / `consoleTest` prefix when those options are on.

### Fixed

- Without `initRun()`, each Playwright worker used its own run id, so with `maxLogFiles` set it could delete a sibling worker's live log files as "older". Retention is now off in such a worker.

## [0.2.0] - 2026-10-13

Adds a project config file, independent color toggles, INFO truncation and log retention. With no config file and no new options set, output is identical to 0.1.0.

### Added

- Project config file: `logger.config.ts`, `.js`, `.cjs` or `.json` in the working directory, or the path in `VOID_LOG_CONFIG`. It is loaded once per process, so every Playwright worker reads it. It default-exports an object or a `(config) => patch` function. `defineConfig()` types it.
- Config precedence, lowest to highest: built-in defaults, config file, environment variables, `configure()` calls.
- Strict config file validation: a file that throws, has the wrong shape, has an unknown option or has a wrongly typed value fails with an error naming the file, on every use until fixed. An explicit `VOID_LOG_CONFIG` that does not exist is an error.
- `fg` and `bg` options (env `VOID_LOG_FG`, `VOID_LOG_BG`) to turn the foreground colors and the theme background on and off independently. Bold, including table titles, follows `fg`.
- `enableFg()`, `disableFg()`, `isFgEnabled()` and the `Bg` equivalents.
- `infoLogsCharLimit` option (env `VOID_LOG_INFO_LOGS_CHAR_LIMIT`): INFO lines longer than the limit print truncated with the total char count, followed by a WARN saying where to raise the limit and a DEBUG line with the full text. Tables are excluded.
- `maxLogFiles` option (env `VOID_LOG_MAX_FILES`): keeps the newest N files per trace kind across date folders. The current run's files are never deleted, and only files named like the logger's own output are touched.
- `ARCHITECTURE.md`, shipped in the package, describing the internals end to end.
- README installation, entry points, quick start and uninstall sections.

### Changed

- Configuration is built lazily on first use, not at import, so an environment variable changed between import and the first log call is now honored.
- With `fg` and `bg` both off, console lines carry no escape codes on the line body, not even a lone reset.
- Environment variables apply only when set and valid. An invalid `VOID_LOG_LEVEL` is ignored instead of overriding a lower layer.

## [0.1.0] - 2026-10-05

First release on npm. A self-contained TypeScript port of the VOID `core.logging` package for Playwright projects, with no runtime dependencies.

### Added

- Level loggers `debug`, `info`, `warn` and `error`, each with intent-based actions such as `click`, `log`, `success`, `failed`, `password` (masked), `table`, `tree` and `row`, plus `fields()` for structured values.
- Console sink with the HIGH_CONTRAST theme. ANSI is auto-detected and controlled by `VOID_LOG_ANSI`, `NO_COLOR` and `FORCE_COLOR`. A caller suffix is shown at `debug` level, optionally colored with `callerColor`.
- Plain-text trace files under `logs/<date>/`: `partial-trace` (console-visible lines), `debug-trace` (every level, caller suffix) and `full-trace` (every level, `[CHAIN]` suffix). They are written synchronously, one file per Playwright worker, with every line prefixed `w<N> │ `.
- Opt-in JSONL sink (`VOID_LOG_JSONL=1`) with one JSON record per call, including `worker` and `test`.
- Secret redaction of structured values by key (`redactKeys`).
- Custom sinks (`addSink`, `removeSink`) and in-memory capture (`captureLogs`).
- Caller and in-project chain resolution, with filters (`suppressContains`, `suppressMethodPrefixes`, `includeOnlyPrefixes`, `projectRoots`).
- Table cell truncation (`tableCellLimit`).
- GitHub Actions `::error::` / `::warning::` annotations.
- Playwright entry (`@aryan-vashishth/advanced-logger/playwright`): a drop-in `test` / `expect` whose auto fixture tags each test, logs `TEST START` / `TEST END` and attaches the test's log to the report (`attach`: `on-failure` by default).
- `initRun()` to share one run id across Playwright workers via `VOID_RUN_ID` / `VOID_RUN_DATE`.
- Environment variables `VOID_LOG_LEVEL`, `VOID_LOG_DIR`, `VOID_LOG_ANSI`, `VOID_LOG_JSONL` and `VOID_RUN_ID`, and `configure()` for code.

[0.4.0]: https://www.npmjs.com/package/@aryan-vashishth/advanced-logger/v/0.4.0
[0.3.0]: https://www.npmjs.com/package/@aryan-vashishth/advanced-logger/v/0.3.0
[0.2.0]: https://www.npmjs.com/package/@aryan-vashishth/advanced-logger/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/@aryan-vashishth/advanced-logger/v/0.1.0
