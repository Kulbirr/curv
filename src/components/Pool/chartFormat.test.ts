import { describe, expect, it } from 'vitest';
import { formatTokenCompact } from './chartFormat';

describe('formatTokenCompact', () => {
  it('compacts millions with a lowercase m suffix', () => {
    expect(formatTokenCompact(19269483.991575371)).toBe('19.27m');
  });
  it('compacts thousands with a lowercase k suffix', () => {
    expect(formatTokenCompact(3500)).toBe('3.5k');
    expect(formatTokenCompact(1000)).toBe('1k');
  });
  it('compacts billions with a lowercase b suffix', () => {
    expect(formatTokenCompact(2500000000)).toBe('2.5b');
  });
  it('leaves small values readable', () => {
    expect(formatTokenCompact(999)).toBe('999');
    expect(formatTokenCompact(0.5)).toBe('0.5');
    expect(formatTokenCompact(0)).toBe('0');
  });
  it('handles non-finite input', () => {
    expect(formatTokenCompact(NaN)).toBe('-');
    expect(formatTokenCompact(Infinity)).toBe('-');
  });
});
