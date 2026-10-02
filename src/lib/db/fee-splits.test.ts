import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { creatorRemainderBps, splitShareRaw, validateFeeSplits } from '../fee-split-terms';

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
