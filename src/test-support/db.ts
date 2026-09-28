import { randomBytes } from 'crypto';
import bs58 from 'bs58';
import { _testCloseDb, _testUseDb } from '@/lib/db';

/**
 * Point the DB singleton at a throwaway Postgres schema for one test.
 * Call `await db.cleanup()` when done (afterEach). Never touches the real
 * database. Tests use TEST_DATABASE_URL, defaulting to a local Postgres
 * (see src/lib/db/index.ts).
 */
export async function useTempDb() {
  const schema = await _testUseDb();
  return {
    schema,
    async cleanup() {
      await _testCloseDb();
    },
  };
}

/** A random valid base58 Solana address (for registry fixtures). */
export function randomAddress(): string {
  return bs58.encode(randomBytes(32));
}
