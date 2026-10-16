import { test } from '../../src/playwright';
import { ACTION_FG, configure, debug, error, fields, info, warn, type LogAction } from '../../src';
import { SECRETS } from './secrets';

/**
 * Manual sweep (npm run sweep). No assertions: the point is to look at the console and the files.
 * The automatic checks run once at the end, in global-teardown.ts.
 *
 * Every test runs with the config in logger.config.ts (level debug, both console prefixes, every file kind).
 */

const say = (title: string): void => {
  // Plain console.log, so section headers stand apart from logger lines.
  // eslint-disable-next-line no-console
  console.log(`\n──── ${title} ────`);
};

const FAMILIES: Array<[string, LogAction[]]> = [
  ['Interaction (blues)', ['click', 'hover', 'checkbox', 'toggle', 'dropdown', 'input', 'text', 'password', 'clear', 'key', 'upload']],
  ['Navigation (teals)', ['navigate', 'tab', 'frame', 'breadcrumb']],
  ['Observe (pinks)', ['wait', 'search', 'result']],
  ['Verify (gold)', ['verifying']],
  ['Data (violets)', ['grid', 'table', 'row']],
  ['Success (greens)', ['success', 'complete', 'resolved']],
  ['Alert (reds, oranges; skip muted)', ['failed', 'error', 'timeout', 'validation', 'fallback', 'skip']],
];

function act(action: LogAction, msg: string): void {
  if (action === 'row') return info.row({ action: 'row', sample: msg });
  if (action === 'table') return info.table(msg);
  if (action === 'password') return info.password('pw-value', msg);
  (info as unknown as Record<string, (m: string) => void>)[action]!(msg);
}

test.describe('sweep', () => {
  test('1 action palette: every action in its own color', () => {
    for (const [family, actions] of FAMILIES) {
      say(family);
      for (const a of actions) act(a, `${a} sample line`);
    }
    say(`(${Object.keys(ACTION_FG).length} actions; neighbors should look different, families should look related)`);
  });

  test('2 levels: plain log lines and one action per level', () => {
    say('Plain log at each level: DEBUG grey, INFO white, WARN amber, ERROR red');
    debug.log('debug line');
    info.log('info line');
    warn.log('warn line');
    error.log('error line');
    say('An action keeps its color at every level');
    debug.click('debug click');
    info.click('info click');
    warn.click('warn click');
    error.click('error click');
  });

  test('3 tables: console grid plus a CSV and JSON attachment each', () => {
    say('Titled table with tricky cells (comma, quote, newline, formula, nested, null, number)');
    info.table(
      [
        { id: 1, name: 'Ann, Lee', quote: 'say "hi"', note: 'line1\nline2', formula: '=SUM(A1:A2)', nested: { a: 1 }, empty: null },
        { id: 2, name: 'Bo', quote: '', note: 'plain', formula: '-5', nested: [1, 2], empty: undefined },
      ],
      'Users, special cells',
    );
    say('Untitled table, heterogeneous rows (missing columns stay blank)');
    info.table([{ a: 1 }, { b: 2 }, { a: 3, c: 'x' }], 'Heterogeneous rows');
    say('A Map as a single row');
    info.table(new Map<string, unknown>([['k1', 'v1'], ['k2', 42]]) as unknown as Record<string, unknown>, 'Map row');
    say('log(object) renders a table too');
    info.log({ order: 'A-17', total: 99.5, currency: 'EUR' });
    say('Table at WARN and ERROR level');
    warn.table([{ check: 'latency', ms: 950 }], 'Slow');
    error.table([{ check: 'status', code: 500 }], 'Failed calls');
    say('Long cell: truncated on the console only, full in the attachments');
    configure({ tableCellLimit: 12, tableCellLimitEnabled: true });
    info.table([{ long: 'abcdefghijklmnopqrstuvwxyz-0123456789' }], 'Truncated cell');
    configure({ tableCellLimitEnabled: false });
    say('Empty tables write no attachment');
    info.table([], 'Empty');
    info.table('string form: a TABLE line, no attachment');
  });

  test('4 redaction: structured at any depth, and free text', () => {
    say('Structured: key match at top level and nested (should show ***)');
    info.log('Login', fields('password', SECRETS.password, 'user', { name: 'ann', secret: SECRETS.nested }));
    info.row({ user: 'ann', apiKey: SECRETS.apiKey });
    info.table([{ user: 'ann', token: SECRETS.cell }], 'Redacted table');
    say('Free text (redactText): key=value, key: value, JSON, URL query, Bearer');
    info.log(`password=${SECRETS.password}`);
    info.input(`token: ${SECRETS.token}`);
    info.log(`{"user":"ann","password":"${SECRETS.password}"}`);
    info.navigate(`GET /api?access_token=${SECRETS.token}&page=2`);
    info.log(`Authorization: Bearer ${SECRETS.bearer}`);
    info.password(SECRETS.password, 'login form');
  });

  test('5 truncation: long INFO line (limit 120 in this sweep)', () => {
    say('Truncated INFO + WARN with the hint + DEBUG with the full text');
    info.click('x'.repeat(200));
  });

  test('6 tree, row, resolved', () => {
    info.tree('Request', 'method', 'POST', 'url', '/api/orders', 'retries', 2);
    info.row({ status: 201, durationMs: 182 });
    info.resolved('Order created', fields('id', 'A-17', 'items', 3));
  });

  test('7 color toggles: fg/bg on and off (restored afterwards)', () => {
    for (const [fg, bg] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      configure({ fg, bg });
      info.click(`fg=${fg} bg=${bg}`);
    }
    configure({ fg: true, bg: true, callerColor: true });
    info.click('callerColor on: the caller suffix has its own grey');
    configure({ callerColor: false });
  });

  // Two tests that log at the same time, so the console shows w0/w1 and test-title prefixes interleaving.
  for (const name of ['8a parallel worker', '8b parallel worker']) {
    test(name, async () => {
      for (let i = 1; i <= 4; i++) {
        info.wait(`${name}: step ${i}`);
        await new Promise((r) => setTimeout(r, 120));
      }
    });
  }
});
