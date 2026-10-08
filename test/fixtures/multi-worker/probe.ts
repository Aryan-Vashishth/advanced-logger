import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from '../../../src';

/** Record what this worker process sees. Waits so both workers are alive at once. */
export async function probe(name: string): Promise<void> {
  const c = config();
  fs.writeFileSync(
    path.join(process.env.PROBE_DIR!, `${name}.json`),
    JSON.stringify({ pid: process.pid, worker: process.env.TEST_WORKER_INDEX, level: c.level, redactKeys: c.redactKeys }),
  );
  await new Promise((r) => setTimeout(r, 600));
}
