import * as fs from 'node:fs';
import * as path from 'node:path';
import { SECRETS } from './secrets';

/**
 * After the sweep: print every file this run wrote (with a preview of each kind), then run the checks a person would
 * otherwise do by hand. Any failed check fails the run.
 *
 * The log folder is shared with your other runs, so only this run's files count: every trace file name and every
 * attachment folder contains the run id. Other files there are neither listed, checked nor touched.
 */
export default async function globalTeardown(): Promise<void> {
  const root = process.env.SWEEP_LOG_DIR!;
  const runId = process.env.VOID_RUN_ID!;
  const files = (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((rel) => rel.includes(runId))
    .map((rel) => path.join(root, rel))
    .filter((f) => fs.statSync(f).isFile())
    .sort();
  const rel = (f: string): string => path.relative(root, f).split(path.sep).join('/');
  const read = (f: string): string => fs.readFileSync(f, 'utf8');
  const out: string[] = [];
  const p = (s = ''): void => void out.push(s);

  p('');
  p('══════════════════════════ SWEEP OUTPUT ══════════════════════════');
  p(`Folder: ${root}`);
  p(`Run:    ${runId} (only this run's files are listed and checked)`);
  p('');
  for (const f of files) {
    const text = read(f);
    p(`  ${rel(f).padEnd(96)} ${String(text.split('\n').length - 1).padStart(4)} lines ${String(fs.statSync(f).size).padStart(7)} B`);
  }

  // trace kinds: <date>/<kind>/<file>; attachments: <date>/attachments/<csv|json>/<runId>-<worker>/<file>
  const kindOf = (f: string): string => {
    const parts = rel(f).split('/');
    return parts[1] === 'attachments' ? parts.slice(1, 3).join('/') : parts.slice(1, -1).join('/');
  };
  const byKind = new Map<string, string[]>();
  for (const f of files) byKind.set(kindOf(f), [...(byKind.get(kindOf(f)) ?? []), f]);

  for (const [kind, list] of byKind) {
    const f = list[0]!;
    const lines = read(f).replace(/^﻿/, '').split(/\r?\n/);
    const show = kind.startsWith('attachments') ? 24 : 8;
    p('');
    p(`── ${kind} (${list.length} file${list.length > 1 ? 's' : ''}), first ${Math.min(show, lines.length)} lines of ${path.basename(f)}`);
    for (const l of lines.slice(0, show)) p(`   ${l.length > 160 ? l.slice(0, 157) + '...' : l}`);
  }

  // -- Checks ------------------------------------------------------------------------------------------------
  const results: Array<[boolean, string]> = [];
  const check = (ok: boolean, what: string): void => void results.push([ok, what]);

  const all = files.map((f) => [f, read(f)] as const);
  const leaked = Object.values(SECRETS).filter((s) => all.some(([, t]) => t.includes(s)));
  check(leaked.length === 0, `No secret reaches any file${leaked.length ? ` (leaked: ${leaked.join(', ')})` : ''}`);

  const withEsc = all.filter(([, t]) => t.includes('\u001b')).map(([f]) => rel(f));
  check(withEsc.length === 0, `No escape codes in any file${withEsc.length ? ` (found in: ${withEsc.join(', ')})` : ''}`);

  const csvs = files.filter((f) => f.endsWith('.csv'));
  const jsons = files.filter((f) => kindOf(f) === 'attachments/json');
  const links = all
    .filter(([f]) => kindOf(f) === 'debug-trace')
    .flatMap(([, t]) => [...t.matchAll(/TABLE FILES │ attachments\/csv\/(\S+)\.csv/g)].map((m) => m[1]!));
  check(csvs.length > 0 && csvs.length === jsons.length, `One CSV per JSON attachment (${csvs.length} CSV, ${jsons.length} JSON)`);
  check(links.length === csvs.length, `Every attachment is linked from debug-trace (${links.length} links, ${csvs.length} tables)`);
  const missing = links.filter((name) => !csvs.some((f) => rel(f).endsWith(`attachments/csv/${name}.csv`)));
  check(missing.length === 0, `Every linked attachment exists${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

  const traceIds = new Set(
    files
      .filter((f) => kindOf(f) === 'partial-trace')
      .map((f) => /^partial-trace-(.+-(?:main|w\d+))\.log$/.exec(path.basename(f))?.[1]),
  );
  const orphans = [...csvs, ...jsons].filter((f) => {
    const id = path.basename(path.dirname(f)); // the per-parent-log folder: <runId>-<worker>
    return !id || !traceIds.has(id);
  });
  check(orphans.length === 0, `Every attachment sits in its parent log's <runId>-<worker> folder${orphans.length ? ` (no match: ${orphans.map(rel).join(', ')})` : ''}`);

  const badJson = jsons.filter((f) => {
    try {
      const doc = JSON.parse(read(f));
      return !Array.isArray(doc.rows) || !Array.isArray(doc.columns);
    } catch {
      return true;
    }
  });
  check(badJson.length === 0, `Every JSON attachment parses and has columns + rows${badJson.length ? ` (bad: ${badJson.map(rel).join(', ')})` : ''}`);
  const badCsv = csvs.filter((f) => !read(f).startsWith('﻿') || !read(f).includes('\r\n'));
  check(badCsv.length === 0, 'Every CSV has a UTF-8 BOM and CRLF line ends');
  const badNames = [...csvs, ...jsons].filter((f) => !/^\d{3,}-.+\.(csv|json)$/.test(path.basename(f)) || /-untitled\./.test(path.basename(f)));
  check(badNames.length === 0, `Every table file is named <NNN>-<heading>, none untitled${badNames.length ? ` (bad: ${badNames.map(rel).join(', ')})` : ''}`);
  check(all.some(([f, t]) => f.endsWith('.csv') && t.includes('abcdefghijklmnopqrstuvwxyz-0123456789')), 'A cell truncated on the console is complete in the CSV');
  check(all.some(([f, t]) => f.endsWith('.csv') && t.includes("'=SUM(A1:A2)")), 'A formula-like CSV cell is neutralized with a leading apostrophe');

  const workers = new Set([...traceIds].map((id) => id?.split('-').pop()));
  check(workers.size >= 2, `Both workers wrote trace files (${[...workers].join(', ')})`);
  for (const kind of ['partial-trace', 'debug-trace', 'full-trace', 'jsonl']) {
    check(byKind.has(kind), `${kind} files exist`);
  }

  p('');
  p('── Checks');
  for (const [ok, what] of results) p(`   ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  const failed = results.filter(([ok]) => !ok).length;
  p('');
  p(failed === 0 ? `All ${results.length} checks passed. Now look over the console output above.` : `${failed} of ${results.length} checks FAILED.`);
  p('══════════════════════════════════════════════════════════════════');
  // eslint-disable-next-line no-console
  console.log(out.join('\n'));
  if (failed > 0) throw new Error(`Sweep: ${failed} file check(s) failed (see above).`);
}
