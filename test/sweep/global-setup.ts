import * as path from 'node:path';
import { initRun } from '../../src';

/**
 * The sweep's logger config and one run id for both workers (all via env, which workers inherit). Output goes where
 * the logger writes by default, ./logs (or VOID_LOG_DIR if you set it). Nothing is deleted there: the teardown checks
 * only the files of this run, found by its run id.
 */
export default async function globalSetup(): Promise<void> {
  process.env.VOID_LOG_CONFIG = path.resolve(__dirname, 'logger.config.ts');
  // Colors on even when the reporter pipes worker output (no TTY).
  process.env.VOID_LOG_ANSI = '1';
  // Resolved here, in the runner, so the teardown reads the same folder the workers write to.
  process.env.SWEEP_LOG_DIR = path.resolve(process.env.VOID_LOG_DIR || 'logs');
  process.env.VOID_LOG_DIR = process.env.SWEEP_LOG_DIR;
  initRun();
}
