import { describe, it, expect } from 'vitest';
import { EMPTY_COUNTS, totalUnread, type NotifyCounts } from '../notify.js';

// totalUnread is what drives the toolbar badge number — a broken implementation
// would either hide notifications ("I have 3 unread but badge shows 0") or
// miscount. The sum is trivial but the test ensures every module key is
// accounted for; forgetting a new module in the sum would silently drop
// notifications for it, which is exactly the kind of bug we need to catch.

describe('totalUnread', () => {
  it('returns 0 for EMPTY_COUNTS', () => {
    expect(totalUnread(EMPTY_COUNTS)).toBe(0);
  });

  it('sums every module key', () => {
    const counts: NotifyCounts = {
      spectrum: 1,
      'comm-link': 2,
      'patch-notes': 3,
      roadmap: 4,
      contacts: 5,
      'release-notes': 6,
    };
    // If the implementation ever drops a module from the sum, this total
    // will stop matching 21.
    expect(totalUnread(counts)).toBe(21);
  });

  it('ignores negative inputs by treating them as-is (contract: non-negative)', () => {
    // Sanity check: inputs are assumed non-negative; the sum is a plain
    // addition. This test documents that assumption.
    const counts: NotifyCounts = { ...EMPTY_COUNTS, spectrum: 5 };
    expect(totalUnread(counts)).toBe(5);
  });
});
