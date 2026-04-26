import { describe, it, expect } from 'vitest';
import { buildCommunityHubPostUrl } from '../rsi/community-hub.js';

// The Community Hub Discover/Gameplay/Tutorial tabs all link out to RSI
// post pages. Through 1.2.1 we built `/community-hub/user/{nickname}/post/{slug}`,
// which 404s — RSI collapsed the per-user routes during their late-2025
// hub rework and the new canonical path is `/community-hub/post/{slug}-{uid}`.
// These tests pin the new format so we don't silently regress next time
// somebody refactors the URL builder.

describe('buildCommunityHubPostUrl', () => {
  it('produces /community-hub/post/{slug}-{uid} when both fields are present', () => {
    const url = buildCommunityHubPostUrl('tool-haul-matrix', 'idrMZOEZR5iqm');
    expect(url).toBe(
      'https://robertsspaceindustries.com/community-hub/post/tool-haul-matrix-idrMZOEZR5iqm',
    );
  });

  it('does NOT include the legacy /user/{nickname}/ segment', () => {
    const url = buildCommunityHubPostUrl('some-post', 'abc123');
    expect(url).not.toContain('/user/');
    expect(url).toContain('/community-hub/post/some-post-abc123');
  });

  it('returns empty string when slug is missing (so callers can skip rendering a link)', () => {
    expect(buildCommunityHubPostUrl('', 'abc123')).toBe('');
  });

  it('returns empty string when uid is missing (avoids producing a slug-only path that would 404)', () => {
    expect(buildCommunityHubPostUrl('some-post', '')).toBe('');
  });
});
