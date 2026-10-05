import { test, expect } from '../src/playwright';
import { info, warn, fields, configure } from '../src';

class LoginPage {
  login(user: string): void {
    info.click(`Sign in as ${user}`);
    info.password('hunter2', 'password field');
  }
}

test('a passing test logs steps', async () => {
  new LoginPage().login('alice');
  info.navigate('/dashboard');
  info.log('Request', fields('method', 'POST', 'password', 'x', 'ids', [1, 2]));
  info.table([{ ID: 1, Name: 'Alice' }, { ID: 2, Name: 'Bob' }], 'Users');
  info.success('done');
});

test('a second test in parallel', async () => {
  warn.timeout('slow response');
  info.verifying('title');
  expect(1).toBe(1);
});
