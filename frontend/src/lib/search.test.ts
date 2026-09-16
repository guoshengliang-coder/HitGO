import { describe, expect, it } from 'vitest';
import { matchesQuery } from './search';

describe('matchesQuery', () => {
  it('matches everything for a blank query', () => {
    expect(matchesQuery('九月投放', '')).toBe(true);
    expect(matchesQuery(null, '   ')).toBe(true);
  });

  it('is a trimmed, case-insensitive substring match', () => {
    expect(matchesQuery('Spring Promo 九月', '  promo ')).toBe(true);
    expect(matchesQuery('九月投放 A', '投放')).toBe(true);
    expect(matchesQuery('九月投放 A', '十月')).toBe(false);
    expect(matchesQuery(undefined, 'a')).toBe(false);
  });
});
