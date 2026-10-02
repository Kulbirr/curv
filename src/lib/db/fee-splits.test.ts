import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  checkBindingEligibility,
  creatorRemainderBps,
  resolveEffectiveRecipients,
  splitShareRaw,
  validateFeeSplits,
} from '../fee-split-terms';
import { canonicalFeeSplitsTerms } from '../signature-messages';
import { payableRecipients } from '../fee-split-claim';
import { getFeeSplitBindings, insertFeeSplitBinding } from './fee-splits';
import { afterEach, beforeEach } from 'vitest';
import { useTempDb } from '@/test-support/db';

const creator = Keypair.generate().publicKey.toBase58();
const alice = Keypair.generate().publicKey.toBase58();
const bob = Keypair.generate().publicKey.toBase58();

describe('validateFeeSplits', () => {
  it('accepts an empty or absent split list', () => {
    expect(validateFeeSplits(undefined, creator)).toEqual([]);
    expect(validateFeeSplits(null, creator)).toEqual([]);
    expect(validateFeeSplits([], creator)).toEqual([]);
  });

  it('normalizes wallets and strips the @ from handles', () => {
    const out = validateFeeSplits([{ wallet: alice, bps: 2500, handle: '@alice' }], creator);
    expect(out).toEqual([{ wallet: alice, bps: 2500, handle: 'alice' }]);
  });

  it('rejects a share above the 90 percent recipient cap in total', () => {
    expect(() =>
      validateFeeSplits(
        [
          { wallet: alice, bps: 5000 },
          { wallet: bob, bps: 4001 },
        ],
        creator,
      ),
    ).toThrow(/90%/);
  });

  it('rejects the creator as their own recipient', () => {
    expect(() => validateFeeSplits([{ wallet: creator, bps: 100 }], creator)).toThrow(
      /remainder/,
    );
  });

  it('rejects duplicate wallets, bad addresses, and fractional bps', () => {
    expect(() =>
      validateFeeSplits(
        [
          { wallet: alice, bps: 100 },
          { wallet: alice, bps: 100 },
        ],
        creator,
      ),
    ).toThrow(/twice/);
    expect(() => validateFeeSplits([{ wallet: 'not-an-address', bps: 100 }], creator)).toThrow(
      /valid Solana address/,
    );
    expect(() => validateFeeSplits([{ wallet: alice, bps: 12.5 }], creator)).toThrow(
      /whole number/,
    );
  });

  it('rejects more than 10 recipients', () => {
    const many = Array.from({ length: 11 }, () => ({
      wallet: Keypair.generate().publicKey.toBase58(),
      bps: 10,
    }));
    expect(() => validateFeeSplits(many, creator)).toThrow(/At most 10/);
  });
});

describe('creatorRemainderBps', () => {
  it('is 10000 with no recipients and shrinks by the assigned shares', () => {
    expect(creatorRemainderBps([])).toBe(10_000);
    expect(
      creatorRemainderBps([
        { wallet: alice, bps: 2500 },
        { wallet: bob, bps: 1000 },
      ]),
    ).toBe(6_500);
  });
});

describe('splitShareRaw', () => {
  it('takes the exact bps share with bigint math', () => {
    expect(splitShareRaw('1000000', 2500)).toBe('250000');
    expect(splitShareRaw('18446744073709551615', 9000)).toBe('16602069666338596453');
  });

  it('floors and never exceeds the claim', () => {
    expect(splitShareRaw('101', 3333)).toBe('33');
    expect(splitShareRaw('0', 5000)).toBe('0');
    expect(splitShareRaw(null, 5000)).toBe('0');
    expect(splitShareRaw('garbage', 5000)).toBe('0');
  });
});

describe('handle-only split entries', () => {
  it('accepts a handle-only entry with no wallet', () => {
    const out = validateFeeSplits([{ handle: 'zed', bps: 2000 }], creator);
    expect(out).toEqual([{ bps: 2000, handle: 'zed' }]);
  });

  it('rejects an entry with neither wallet nor handle', () => {
    expect(() => validateFeeSplits([{ bps: 1000 }], creator)).toThrow(/needs a Solana wallet/);
  });

  it('rejects duplicate handles case-insensitively', () => {
    expect(() =>
      validateFeeSplits([{ handle: 'Zed', bps: 1000 }, { handle: 'zed', bps: 1000 }], creator),
    ).toThrow(/handle appears twice/);
  });

  it('renders handle-only entries as @handle:bps and sorts by rendered string', () => {
    const terms = canonicalFeeSplitsTerms([
      { wallet: alice, bps: 1000, handle: 'alice' },
      { handle: 'zed', bps: 2000 },
    ]);
    expect(terms).toContain('@zed:2000');
    expect(terms).toContain(`${alice}:1000:alice`);
    const parts = terms.split(',');
    expect([...parts].sort()).toEqual(parts);
  });
});

describe('checkBindingEligibility', () => {
  const recipients = [{ wallet: alice, bps: 1000 }, { handle: 'zed', bps: 2000 }];

  it('accepts a fresh binding to an unbound handle-only entry', () => {
    expect(() => checkBindingEligibility(recipients, [], 1, bob, creator)).not.toThrow();
  });

  it('rejects binding an already-bound entry (immutability)', () => {
    const bindings = [{ poolAddress: 'pool', entryIndex: 1, wallet: bob, boundAt: 1 }];
    expect(() => checkBindingEligibility(recipients, bindings, 1, bob, creator)).toThrow(
      /already has a wallet bound/,
    );
  });

  it('rejects binding a wallet already effective for another entry', () => {
    const bindings = [{ poolAddress: 'pool', entryIndex: 0, wallet: bob, boundAt: 1 }];
    expect(() => checkBindingEligibility(recipients, bindings, 1, bob, creator)).toThrow(
      /already used by another split entry/,
    );
  });

  it('rejects binding the creator wallet', () => {
    expect(() => checkBindingEligibility(recipients, [], 1, creator, creator)).toThrow(
      /creator wallet cannot be bound/,
    );
  });

  it('rejects binding a wallet entry with a different wallet (proof of control)', () => {
    expect(() => checkBindingEligibility(recipients, [], 0, bob, creator)).toThrow(
      /registered to a different wallet/,
    );
  });

  it('accepts the registered wallet binding its own entry (proof of control)', () => {
    expect(() =>
      checkBindingEligibility([{ wallet: bob, bps: 1000 }], [], 0, bob, creator),
    ).not.toThrow();
  });

  it('rejects an invalid wallet address', () => {
    expect(() => checkBindingEligibility(recipients, [], 1, 'not-an-address', creator)).toThrow(
      /not a valid Solana address/,
    );
  });
});

describe('resolveEffectiveRecipients', () => {
  it('prefers the bound wallet and marks the entry bound', () => {
    const recipients = [{ wallet: alice, bps: 1000 }, { handle: 'zed', bps: 2000 }];
    const bindings = [{ poolAddress: 'pool', entryIndex: 1, wallet: bob, boundAt: 1 }];
    const effective = resolveEffectiveRecipients(recipients, bindings);
    expect(effective[0]).toMatchObject({ effectiveWallet: alice, bound: true });
    expect(effective[1]).toMatchObject({ effectiveWallet: bob, bound: true });
  });

  it('leaves handle-only entries unbound with no effective wallet', () => {
    const effective = resolveEffectiveRecipients([{ handle: 'zed', bps: 2000 }], []);
    expect(effective[0]).toMatchObject({ effectiveWallet: undefined, bound: false });
  });
});

describe('payableRecipients', () => {
  it('skips handle-only entries with no bound wallet', () => {
    const recipients = [{ wallet: alice, bps: 1000 }, { handle: 'zed', bps: 2000 }];
    const payable = payableRecipients(recipients, []);
    expect(payable.map((r) => r.wallet)).toEqual([alice]);
  });

  it('pays a bound handle-only entry to its bound wallet', () => {
    const recipients = [{ handle: 'zed', bps: 2000 }];
    const bindings = [{ poolAddress: 'pool', entryIndex: 0, wallet: bob, boundAt: 1 }];
    const payable = payableRecipients(recipients, bindings);
    expect(payable).toHaveLength(1);
    expect(payable[0].wallet).toBe(bob);
  });
});

describe('insertFeeSplitBinding (first-wins backstop)', () => {
  let db: Awaited<ReturnType<typeof useTempDb>>;
  beforeEach(async () => {
    db = await useTempDb();
  });
  afterEach(async () => {
    await db.cleanup();
  });

  it('returns true on the first insert and false once a binding exists', async () => {
    const pool = Keypair.generate().publicKey.toBase58();
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    expect(await insertFeeSplitBinding(pool, 0, w1)).toBe(true);
    // A racing second signature for the same entry loses: the row is untouched.
    expect(await insertFeeSplitBinding(pool, 0, w2)).toBe(false);
    const bindings = await getFeeSplitBindings(pool);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ poolAddress: pool, entryIndex: 0, wallet: w1 });
  });
});
