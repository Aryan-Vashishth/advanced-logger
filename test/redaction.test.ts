import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAllFiles, configure, fields, info, resetConfig } from '../src';
import { maskText } from '../src/redact';

let tmp: string;
let out: string[];

beforeEach(() => {
  resetConfig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advanced-logger-red-'));
  configure({ logDir: tmp, ansi: false, githubAnnotations: false, tsFormat: () => 'TS' });
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeAllFiles();
  fs.rmSync(tmp, { recursive: true, force: true });
  resetConfig();
});

const printed = (): string => out.join('');

describe('nested redaction (structured values)', () => {
  it('nestedObjectInAField_masksItsSensitiveKeys', () => {
    info.log('Login', fields('user', { name: 'ann', password: 'hunter2' }));
    expect(printed()).not.toContain('hunter2');
    expect(printed()).toContain('"password":"***"');
    expect(printed()).toContain('"name":"ann"');
  });

  it('anyDepth_arraysAndMaps', () => {
    const payload = { users: [{ id: 1, auth: { apiKey: 'k-1' } }], meta: new Map([['token', 't-1']]) };
    info.log('Payload', fields('body', payload));
    expect(printed()).not.toContain('k-1');
    expect(printed()).not.toContain('t-1');
  });

  it('doesNotMutateTheCallersObject', () => {
    const user = { password: 'hunter2', nested: { secret: 's' } };
    info.log('User', fields('user', user));
    expect(user).toEqual({ password: 'hunter2', nested: { secret: 's' } });
  });

  it('cycles_printCircular_insteadOfLooping', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => info.log('Cyclic', fields('a', a))).not.toThrow();
    expect(printed()).toContain('[Circular]');
  });

  it('toJSON_resultIsRedacted', () => {
    const creds = { toJSON: () => ({ user: 'ann', password: 'hunter2' }) };
    info.log('Creds', fields('creds', creds));
    expect(printed()).not.toContain('hunter2');
  });

  it('rowAndTable_cellsAreRedactedByKey', () => {
    info.row({ user: 'ann', password: 'hunter2' });
    info.table([{ user: 'ann', token: 'abc123' }], 'T');
    expect(printed()).not.toContain('hunter2');
    expect(printed()).not.toContain('abc123');
  });

  it('customRedactKeys_applyAtDepth', () => {
    configure({ redactKeys: ['pin'] });
    info.log('Card', fields('card', { number: '4111', pin: '1234' }));
    expect(printed()).not.toContain('1234');
    expect(printed()).toContain('4111');
  });
});

describe('free-text masking (redactText)', () => {
  const keys = ['password', 'token', 'secret', 'authorization', 'apikey', 'api_key'];
  const cases: Array<[string, string]> = [
    ['password=hunter2', 'password=***'],
    ['login with password: hunter2 now', 'login with password: *** now'],
    ['{"user":"ann","password":"hunter2"}', '{"user":"ann","password":"***"}'],
    ["{'token': 'abc'}", "{'token': '***'}"],
    ['GET /api?access_token=abc123&page=2', 'GET /api?access_token=***&page=2'],
    ['Authorization: Bearer eyJhbGciOi.abc.def', 'Authorization: Bearer ***'],
    ['header Basic dXNlcjpwYXNz==', 'header Basic ***'],
    ['PASSWORD=Hunter2', 'PASSWORD=***'],
    ['db_password=x;user=ann', 'db_password=***;user=ann'],
    ['clientSecret = s3cr3t, retry=1', 'clientSecret = ***, retry=1'],
  ];

  it.each(cases)('%s', (input, expected) => {
    expect(maskText(input, keys)).toBe(expected);
  });

  it('textWithoutSecrets_isUnchanged', () => {
    for (const t of ['Click: Submit', 'status=200 ok', 'password reset page opened', 'a=b c=d']) {
      expect(maskText(t, keys)).toBe(t);
    }
  });

  it('alreadyMasked_staysAsIs', () => {
    expect(maskText('password=***', keys)).toBe('password=***');
  });

  it('noKeys_onlyAuthSchemesAreMasked', () => {
    expect(maskText('password=x Bearer abc', [])).toBe('password=x Bearer ***');
  });

  it('onByDefault_inConsole_andInEveryFile', () => {
    configure({ files: { jsonl: true } });
    info.log('password=hunter2');
    expect(printed()).toContain('password=***');
    for (const kind of ['partial-trace', 'debug-trace', 'full-trace', 'jsonl']) {
      const dir = path.join(tmp, fs.readdirSync(tmp)[0]!, kind);
      const text = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), 'utf8');
      expect(text, kind).not.toContain('hunter2');
    }
  });

  it('appliesToActionsAndHeadings_too', () => {
    info.input('token=abc123');
    info.log('Request', 'Authorization', 'Bearer abc.def');
    expect(printed()).not.toContain('abc123');
    expect(printed()).not.toContain('abc.def');
  });

  it('maskingRunsBeforeInfoTruncation_soTheDebugCopyIsMaskedToo', () => {
    configure({ level: 'debug', infoLogsCharLimit: 10 });
    info.log('token=abc123 and a long tail of text');
    expect(printed()).not.toContain('abc123');
  });

  it('off_passesTextThrough', () => {
    configure({ redactText: false });
    info.log('password=hunter2');
    expect(printed()).toContain('hunter2');
  });

  it('env_VOID_LOG_REDACT_TEXT', () => {
    const saved = process.env.VOID_LOG_REDACT_TEXT;
    try {
      process.env.VOID_LOG_REDACT_TEXT = '0';
      expect(resetConfig().redactText).toBe(false);
      process.env.VOID_LOG_REDACT_TEXT = 'yes';
      expect(resetConfig().redactText).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.VOID_LOG_REDACT_TEXT;
      else process.env.VOID_LOG_REDACT_TEXT = saved;
    }
  });
});

describe('redaction edge cases', () => {
  it('datesAndErrorsInsideFields_printAsBefore', () => {
    const when = new Date('2030-01-02T03:04:05.000Z');
    info.log('Event', fields('meta', { when, err: new Error('boom') }));
    expect(printed()).toContain('2030-01-02T03:04:05.000Z');
  });

  it('blankRedactKey_isIgnored_insteadOfMaskingEverything', () => {
    configure({ redactKeys: ['', '  ', 'pin'] });
    info.row({ user: 'ann', pin: '1234' });
    expect(printed()).toContain('ann');
    expect(printed()).not.toContain('1234');
    expect(maskText('user=ann', ['', ' '])).toBe('user=ann');
  });

  it('regexCharactersInRedactKeys_areMatchedLiterally', () => {
    expect(maskText('api.key=abc apixkey=def', ['api.key'])).toBe('api.key=*** apixkey=def');
    expect(maskText('a+b=1', ['a+b'])).toBe('a+b=***');
  });

  it('redactKeyChanges_takeEffectImmediately_inFreeText', () => {
    info.log('pin=1234');
    configure({ redactKeys: ['pin'] });
    info.log('pin=5678');
    expect(printed()).toContain('pin=1234'); // 'pin' was not a redact key yet
    expect(printed()).toContain('pin=***');
  });

  it('jsonlRecords_holdTheMaskedMessage', () => {
    configure({ files: { jsonl: true } });
    info.log('token=abc123');
    const dir = path.join(tmp, fs.readdirSync(tmp)[0]!, 'jsonl');
    const rec = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), 'utf8').trim());
    expect(rec.message).toBe('token=***');
  });
});
