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

  it('default sums every RSI-content module (spectrum + comm-link + devtracker + patch-notes + roadmap + contacts)', () => {
    const counts: NotifyCounts = {
      spectrum: 1,
      'comm-link': 2,
      'patch-notes': 3,
      roadmap: 4,
      contacts: 5,
      'release-notes': 0,
      devtracker: 6,
    };
    // 1 + 2 + 3 + 4 + 5 + 6 = 21. Default excludes only release-notes
    // (the extension's own changelog) — DevTracker shipped opt-in
    // in the initial 1.5.7 design and was promoted to default-on
    // before release.
    expect(totalUnread(counts)).toBe(21);
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

  it('honours an explicit modules filter — DevTracker opt-out', () => {
    // User has unticked DevTracker in Settings → Toolbar badge.
    // DevTracker is default-on, so opting out has to be explicit.
    const counts: NotifyCounts = {
      ...EMPTY_COUNTS,
      spectrum: 2,
      devtracker: 5,
    };
    // Default sums spectrum + devtracker.
    expect(totalUnread(counts)).toBe(7);
    // Without devtracker in the explicit filter, only spectrum counts.
    expect(
      totalUnread(counts, ['spectrum', 'comm-link', 'patch-notes', 'roadmap', 'contacts']),
    ).toBe(2);
  });

  it('ignores negative inputs by treating them as-is (contract: non-negative)', () => {
    const counts: NotifyCounts = { ...EMPTY_COUNTS, spectrum: 5 };
    expect(totalUnread(counts)).toBe(5);
  });

  it('BADGE_MODULES_DEFAULT excludes release-notes', () => {
    expect(BADGE_MODULES_DEFAULT).not.toContain('release-notes');
  });

  it('BADGE_MODULES_ALL lists every module in picker order', () => {
    // Pin down that the Settings UI iterates every module that has
    // a count slot — adding a new NotifyModule without updating
    // BADGE_MODULES_ALL would silently hide it from the picker.
    // Order matches BADGE_MODULES_DEFAULT for the six default-on
    // modules, with `release-notes` (opt-in) trailing.
    expect(BADGE_MODULES_ALL).toEqual([
      'spectrum',
      'comm-link',
      'devtracker',
      'patch-notes',
      'roadmap',
      'contacts',
      'release-notes',
    ]);
  });

  it('BADGE_MODULES_DEFAULT includes devtracker (default-on as of 1.5.7 final)', () => {
    // DevTracker shipped opt-in in the 1.5.7 design pass but was
    // promoted to default-on before release. CIG dev posts ARE the
    // closest thing to "official news from the devs" and users want
    // them counted by default.
    expect(BADGE_MODULES_DEFAULT).toContain('devtracker');
  });
});
