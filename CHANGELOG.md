# Changelog

All notable changes to `@aryan-vashishth/advanced-logger`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). While the version is below 1.0.0, a minor release may add options but keeps existing defaults and output unchanged unless noted.

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

[0.3.0]: https://www.npmjs.com/package/@aryan-vashishth/advanced-logger/v/0.3.0
[0.2.0]: https://www.npmjs.com/package/@aryan-vashishth/advanced-logger/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/@aryan-vashishth/advanced-logger/v/0.1.0
