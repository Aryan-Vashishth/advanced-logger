import { test, expect } from '../src/playwright';
import {
  LogActions,
  debug,
  info,
  warn,
  error,
  fields,
  configure,
  resetConfig,
  setTableCellLimit,
  disableTableCellLimit,
} from '../src';

/**
 * Visual tour: exercises every console visual the logger can produce (every action
 * label, every data shape, every theme/level combination) so the real colored output
 * can be eyeballed in a terminal. Run with, from the repo root:
 *
 *   npx playwright test --config=test/playwright.config.ts test/visual-tour.spec.ts --reporter=list --workers=1
 *
 * These tests carry no content assertions on purpose — the point is the printed output,
 * not a pass/fail check on it. A thrown error is still a real failure.
 */

const LEVELS: Array<[string, LogActions]> = [
  ['DEBUG', debug],
  ['INFO', info],
  ['WARN', warn],
  ['ERROR', error],
];

const banner = (title: string): void => {
  // Plain console.log so section headers stand out from the themed logger lines.
  // eslint-disable-next-line no-console
  console.log(`\n=== ${title} ===`);
};

test.beforeEach(() => {
  configure({ ansi: true, level: 'debug', githubAnnotations: false, console: true });
});

test.afterAll(() => {
  resetConfig();
});

test.describe('interaction visuals', () => {
  test('every INTERACTION label at every level', () => {
    banner('INTERACTION x LEVEL');
    for (const [name, actions] of LEVELS) {
      actions.click(`[${name}] Submit button`);
      actions.checkbox(`[${name}] Accept terms`);
      actions.text(`[${name}] Welcome back`);
      actions.input(`[${name}] user@example.com`);
      actions.dropdown(`[${name}] Country: Canada`);
      actions.toggle(`[${name}] Dark mode: on`);
      actions.upload(`[${name}] resume.pdf`);
      actions.hover(`[${name}] Tooltip trigger`);
      actions.clear(`[${name}] Search box`);
      actions.key(`[${name}] Enter`);
      actions.password('hunter2', `[${name}] login password`);
    }
  });

  test('password masking: value, label-less, null, undefined, empty', () => {
    banner('PASSWORD edge cases');
    info.password('hunter2', 'with label');
    info.password('hunter2');
    info.password(null);
    info.password(undefined);
    info.password('');
  });
});

test.describe('navigation visuals', () => {
  test('every NAVIGATION label at every level', () => {
    banner('NAVIGATION x LEVEL');
    for (const [name, actions] of LEVELS) {
      actions.navigate(`[${name}] /dashboard`);
      actions.tab(`[${name}] Settings tab`);
      actions.frame(`[${name}] #payment-iframe`);
      actions.breadcrumb(`[${name}] Home / Account / Billing`);
    }
  });
});

test.describe('observe + verify visuals', () => {
  test('every OBSERVE and VERIFY label at every level', () => {
    banner('OBSERVE + VERIFY x LEVEL');
    for (const [name, actions] of LEVELS) {
      actions.wait(`[${name}] network idle`);
      actions.search(`[${name}] "checkout button"`);
      actions.result(`[${name}] 3 matches found`);
      actions.verifying(`[${name}] order total equals $42.00`);
    }
  });
});

test.describe('success + alert visuals', () => {
  test('every SUCCESS and ALERT label at every level', () => {
    banner('SUCCESS + ALERT x LEVEL');
    for (const [name, actions] of LEVELS) {
      actions.success(`[${name}] checkout completed`);
      actions.complete(`[${name}] upload finished`);
      actions.error(`[${name}] 500 from /api/orders`);
      actions.failed(`[${name}] assertion failed`);
      actions.timeout(`[${name}] waited 30s for selector`);
      actions.validation(`[${name}] email format invalid`);
      actions.fallback(`[${name}] using cached response`);
      actions.skip(`[${name}] feature flag disabled`);
    }
  });
});

test.describe('data visuals: grid + table', () => {
  test('grid label at every level', () => {
    banner('GRID x LEVEL');
    for (const [name, actions] of LEVELS) actions.grid(`[${name}] 4x4 product grid rendered`);
  });

  test('table: string form (no grid, just a labelled line)', () => {
    banner('TABLE: string form');
    info.table('ad-hoc note instead of a real table');
  });

  test('table: empty array -> "No rows to display."', () => {
    banner('TABLE: empty array');
    info.table([]);
  });

  test('table: empty object -> "No data to display."', () => {
    banner('TABLE: empty object');
    info.table({});
  });

  test('table: null -> "No rows to display."', () => {
    banner('TABLE: null');
    info.table(null);
  });

  test('table: single row object, no title', () => {
    banner('TABLE: single row, no title');
    info.table({ ID: 1, Name: 'Alice', Role: 'Admin' });
  });

  test('table: multi-row with a title', () => {
    banner('TABLE: multi-row with title');
    info.table(
      [
        { ID: 1, Name: 'Alice', Role: 'Admin' },
        { ID: 2, Name: 'Bob', Role: 'Viewer' },
        { ID: 3, Name: 'Carol', Role: 'Editor' },
      ],
      'Users',
    );
  });

  test('table: heterogeneous rows (missing columns render blank)', () => {
    banner('TABLE: heterogeneous rows');
    info.table([{ ID: 1, Name: 'Alice' }, { ID: 2, Name: 'Bob', Note: 'late signup' }]);
  });

  test('table: a Map as a single row', () => {
    banner('TABLE: Map row');
    info.table(fields('ID', 1, 'Name', 'Alice'));
  });

  test('table: sensitive keys are redacted', () => {
    banner('TABLE: redaction');
    info.table({ user: 'bob', password: 'hunter2', apiToken: 'abc-123' });
  });

  test('table: cell truncation at a tight limit', () => {
    banner('TABLE: cell truncation (limit=10)');
    setTableCellLimit(10);
    info.table({ Bio: 'This value is much longer than the configured cell limit' });
    disableTableCellLimit();
  });

  test('table: every ERROR-level render (background differs from INFO)', () => {
    banner('TABLE: at ERROR level');
    error.table([{ Code: 500, Message: 'Internal Server Error' }], 'Failure');
  });
});

test.describe('data visuals: row', () => {
  test('row: populated, empty, null, redacted', () => {
    banner('ROW: all shapes');
    info.row({ environment: 'staging', retries: 3 });
    info.row({});
    info.row(null);
    info.row({ user: 'bob', password: 'hunter2' });
  });
});

test.describe('data visuals: tree + resolved', () => {
  test('tree: fields object, pairs form, heading-only no-op', () => {
    banner('TREE: all shapes');
    info.tree('Request', fields('method', 'POST', 'timeout', 5000));
    info.tree('Request', 'method', 'POST', 'timeout', 5000);
    info.tree('No fields at all'); // intentionally a silent no-op
  });

  test('resolved: message-only, with fields, with a stray unpaired value', () => {
    banner('RESOLVED: all shapes');
    info.resolved('Locator resolved');
    info.resolved('Locator', { role: 'button', name: 'Submit' });
    info.resolved('Locator', 'a-stray-value-with-no-partner');
  });
});

test.describe('log() overload visuals', () => {
  test('every log() overload shape', () => {
    banner('LOG(): all overloads');
    info.log('plain message');
    info.log({ a: 1, b: 2 });
    info.log([10, 20, 30]);
    info.log([{ a: 1 }, { b: 2 }]);
    info.log('Heading', { k: 'v' });
    info.log('Heading', 'k1', 'v1', 'k2', 'v2');
    info.log('Heading', 'k1', 'v1', 'orphan-key');
    info.log('Heading', [1, 2, 3]);
    info.log('Heading', 42);
    info.log(null);
    info.log(new Error('demo error for stack rendering'));
    info.log(''); // empty message: still a valid, labelled blank line
  });
});

test.describe('multiline + whitespace visuals', () => {
  test('a message with every supported line-break variant', () => {
    banner('MULTILINE: every break variant');
    warn.log('line one\nline two\r\nline three line four line five\u0085line six\u000bline seven');
  });
});

test.describe('theme on vs off', () => {
  test('ansi on vs ansi off, same lines', () => {
    banner('ANSI: on vs off');
    configure({ ansi: true });
    info.click('Themed line (ansi on)');
    error.failed('Themed alert line (ansi on)');
    configure({ ansi: false });
    info.click('Plain line (ansi off)');
    error.failed('Plain alert line (ansi off)');
    configure({ ansi: true });
  });
});

test.describe('level filtering visuals', () => {
  test('root level = warn hides debug/info from console', () => {
    banner('LEVEL FILTER: root=warn');
    configure({ level: 'warn' });
    debug.log('invisible: below root level');
    info.log('invisible: below root level');
    warn.log('visible: at root level');
    error.log('visible: above root level');
    configure({ level: 'debug' });
  });

  test('root level = off silences the console entirely', () => {
    banner('LEVEL FILTER: root=off (expect nothing printed below this line)');
    configure({ level: 'off' });
    error.failed('invisible: root is off');
    configure({ level: 'debug' });
  });
});

test.describe('GitHub Actions annotation visuals', () => {
  test('error/warn lines also emit ::error::/::warning:: workflow commands', () => {
    banner('GITHUB ANNOTATIONS');
    configure({ githubAnnotations: true });
    error.failed('this becomes a ::error:: workflow command too');
    warn.timeout('this becomes a ::warning:: workflow command too');
    info.log('this stays a plain line, no annotation');
    configure({ githubAnnotations: false });
  });
});

test.describe('caller suffix visual (debug level only)', () => {
  function deeplyNestedHelper(): void {
    info.log('look for the caller chain suffix after this line (debug level only)');
  }

  test('debug level prints a caller suffix; info does not', () => {
    banner('CALLER SUFFIX: debug vs info');
    configure({ level: 'debug' });
    deeplyNestedHelper();
    configure({ level: 'info' });
    deeplyNestedHelper();
    configure({ level: 'debug' });
  });
});

test('sanity: nothing above threw', () => {
  expect(true).toBe(true);
});
