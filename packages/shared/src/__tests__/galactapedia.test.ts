import { describe, it, expect } from 'vitest';
import { filterArticlesByTitle } from '../rsi/galactapedia.js';
import type { GalactapediaArticle } from '../rsi/galactapedia.js';

// filterArticlesByTitle is the hot path for the Galactapedia search box:
// the popup hands typed queries off to it and renders the result list.
// The function is pure, so a handful of fixtures covers the contract.
const article = (id: string, title: string): GalactapediaArticle => {
  const slug = title.toLowerCase().replace(/\s+/g, '-');
  return {
    id,
    title,
    slug,
    thumbnailUrl: null,
    categories: [],
    tags: [],
    url: `https://robertsspaceindustries.com/galactapedia/article/${id}-${slug}`,
  };
};

const CATALOG: GalactapediaArticle[] = [
  article('1', 'Stanton'),
  article('2', 'Pyro'),
  article('3', 'UEE Navy'),
  article('4', 'Roberts Space Industries'),
];

describe('filterArticlesByTitle', () => {
  it('returns a copy of the full list when the term is empty', () => {
    const out = filterArticlesByTitle(CATALOG, '');
    expect(out).toHaveLength(CATALOG.length);
    expect(out).not.toBe(CATALOG);
  });

  it('treats whitespace-only input as empty', () => {
    const out = filterArticlesByTitle(CATALOG, '   ');
    expect(out).toHaveLength(CATALOG.length);
  });

  it('matches case-insensitively on title substring', () => {
    const out = filterArticlesByTitle(CATALOG, 'ROBERTS');
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('Roberts Space Industries');
  });

  it('returns an empty list when no title matches', () => {
    const out = filterArticlesByTitle(CATALOG, 'xyzzy');
    expect(out).toEqual([]);
  });

  it('does not match on slug / id / other fields', () => {
    // Query equals a slug token — must not match because we only scan titles.
    const out = filterArticlesByTitle(CATALOG, 'space-industries');
    expect(out).toEqual([]);
  });
});
