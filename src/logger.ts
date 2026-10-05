import { LogActions } from './actions';

/** Level instances. `info.click("...")`, `warn.log("...")`, `error.failed("...")`. */
export const debug = new LogActions('DEBUG');
export const info = new LogActions('INFO');
export const warn = new LogActions('WARN');
export const error = new LogActions('ERROR');
