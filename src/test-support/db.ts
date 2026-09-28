import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import bs58 from 'bs58';
import { _testCloseDb, _testUseDb } from '@/lib/db';

/**
 * Point the DB singleton at a throwaway SQLite file for one test.
 * Call `db.cleanup()` when done (afterEach). Never touches the real
 * data/stockcurve.db and never touches the network.
 */
export function useTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'stockcurve-test-'));
  const dbPath = join(dir, 'test.db');
  _testUseDb(dbPath);
  return {
    dir,
    dbPath,
    cleanup() {
      _testCloseDb();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A random valid base58 Solana address (for registry fixtures). */
export function randomAddress(): string {
  return bs58.encode(randomBytes(32));
}
