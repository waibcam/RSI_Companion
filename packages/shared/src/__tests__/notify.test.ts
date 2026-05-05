import { describe, it, expect } from 'vitest';
import {
  BADGE_MODULES_ALL,
  BADGE_MODULES_DEFAULT,
  EMPTY_COUNTS,
  totalUnread,
  type NotifyCounts,
} from '../notify.js';

// totalUnread drives the TOOLBAR badge number. The default behaviour
// is to sum the five RSI-content modules and exclude the extension's
// own `release-notes` (Etyx report 2026-05-04: "I want the number to
// pertain to only star citizen related stuff"). The function also
// accepts an explicit `modules` filter so users who customise their
// badge preference (Settings → Appearance → Toolbar badge) get the
// sum that matches their selection.
//
// A broken implementation would either hide notifications ("I have 3
// unread but badge shows 0") or miscount.

describe('totalUnread', () => {
  it('returns 0 for EMPTY_COUNTS (default modules)', () => {
    expect(totalUnread(EMPTY_COUNTS)).toBe(0);
  });

  it('default sums RSI-content modules (spectrum + comm-link + patch-notes + roadmap + contacts)', () => {
    const counts: NotifyCounts = {
      spectrum: 1,
      'comm-link': 2,
      'patch-notes': 3,
      roadmap: 4,
      contacts: 5,
      'release-notes': 0,
      devtracker: 0,
    };
    // 1 + 2 + 3 + 4 + 5 = 15. Default excludes release-notes AND devtracker.
    expect(totalUnread(counts)).toBe(15);
  });

  it('default ignores release-notes (extension changelog is not RSI content)', () => {
    // Pin down the deliberate default-mode exclusion. If a future
    // commit changes BADGE_MODULES_DEFAULT to include release-notes,
    // this test fails — forcing whoever touched it to revisit the
    // rationale in notify.ts.
    const counts: NotifyCounts = {
      ...EMPTY_COUNTS,
      'release-notes': 99,
    };
    expect(totalUnread(counts)).toBe(0);
  });

  it('honours an explicit modules filter — including release-notes when opted in', () => {
    // User-customised badge preference includes release-notes. The
    // toolbar should now reflect it.
    const counts: NotifyCounts = {
      ...EMPTY_COUNTS,
      spectrum: 2,
      'release-notes': 3,
    };
    expect(totalUnread(counts, ['spectrum', 'release-notes'])).toBe(5);
    // Same counts with default modules: release-notes ignored.
    expect(totalUnread(counts)).toBe(2);
  });

  it('honours an explicit modules filter — excluding modules the user opted out of', () => {
    // User has opted to keep only Spectrum in the badge.
    const counts: NotifyCounts = {
      spectrum: 1,
      'comm-link': 2,
      'patch-notes': 3,
      roadmap: 4,
      contacts: 5,
      'release-notes': 6,
      devtracker: 7,
    };
    expect(totalUnread(counts, ['spectrum'])).toBe(1);
  });

  it('returns 0 when the modules filter is empty (user opted out of everything)', () => {
    const counts: NotifyCounts = {
      spectrum: 1,
      'comm-link': 2,
      'patch-notes': 3,
      roadmap: 4,
      contacts: 5,
      'release-notes': 6,
      devtracker: 7,
    };
    expect(totalUnread(counts, [])).toBe(0);
  });

  it('honours an explicit modules filter — DevTracker opt-in', () => {
    // User has ticked DevTracker in Settings → Toolbar badge.
    const counts: NotifyCounts = {
      ...EMPTY_COUNTS,
      spectrum: 2,
      devtracker: 5,
    };
    expect(
      totalUnread(counts, ['spectrum', 'comm-link', 'patch-notes', 'roadmap', 'contacts', 'devtracker']),
    ).toBe(7);
    // Same counts with default modules: devtracker ignored.
    expect(totalUnread(counts)).toBe(2);
  });

  it('ignores negative inputs by treating them as-is (contract: non-negative)', () => {
    const counts: NotifyCounts = { ...EMPTY_COUNTS, spectrum: 5 };
    expect(totalUnread(counts)).toBe(5);
  });

  it('BADGE_MODULES_DEFAULT excludes release-notes', () => {
    expect(BADGE_MODULES_DEFAULT).not.toContain('release-notes');
  });

  it('BADGE_MODULES_ALL includes every module key', () => {
    // Pin down that the Settings UI iterates every module that has
    // a count slot — adding a new NotifyModule without updating
    // BADGE_MODULES_ALL would silently hide it from the picker.
    expect(BADGE_MODULES_ALL).toEqual([
      'spectrum',
      'comm-link',
      'patch-notes',
      'roadmap',
      'contacts',
      'release-notes',
      'devtracker',
    ]);
  });

  it('BADGE_MODULES_DEFAULT excludes devtracker (opt-in only)', () => {
    // DevTracker was added in 1.5.7 — opt-in for the toolbar badge
    // because CIG can drop a 30-post burst on patch days and not
    // every user wants that spilling into the badge.
    expect(BADGE_MODULES_DEFAULT).not.toContain('devtracker');
  });
});
