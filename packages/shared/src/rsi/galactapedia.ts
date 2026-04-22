// Galactapedia articles via the public GraphQL endpoint at
// /galactapedia/graphql. The endpoint requires a named operation (bare
// queries are 403'd by the WAF) and accepts `first`, `skip`, and cursor args.
//
// IMPORTANT: selecting `_meta` (publishedAt/updatedAt) triggers a 500 from
// the resolver even though introspection says the field exists. The official
// Galactapedia site itself never selects `_meta` — we stick to the fields it
// uses (id, title, slug, thumbnail, categories).
//
// Article page URL: /galactapedia/article/{id}-{slug}

import { z } from 'zod';
import { RSI_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';

const GALACTAPEDIA_URL = `${RSI_BASE_URL}/galactapedia/graphql`;

const Category = z
  .object({
    __typename: z.string().default(''),
    id: z.string().optional(),
    name: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    // `thumbnail` is only requested on the top-level `allCategory` query —
    // the article-side inline fragment doesn't need it. Making it optional
    // here means both use sites share a single schema without separating
    // "article category" vs "top-level category" shapes.
    thumbnail: z
      .object({ url: z.string().nullable().optional() })
      .nullable()
      .optional(),
  })
  .passthrough();

// Shared shape for the tag-on-article inline fragment. Reused across the
// article-tag relation (Article.tags, a union like categories) and the
// top-level tag list (`allTag`). Passing through so any extra server fields
// don't break validation.
const TagNode = z
  .object({
    __typename: z.string().default(''),
    id: z.string().optional(),
    name: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
  })
  .passthrough();

const Article = z
  .object({
    id: z.string(),
    title: z.string().default(''),
    slug: z.string().default(''),
    thumbnail: z
      .object({ url: z.string().nullable().optional() })
      .nullable()
      .optional(),
    categories: z.array(Category).nullable().optional(),
    tags: z.array(TagNode).nullable().optional(),
  })
  .passthrough();

const ArticlesResponse = z.object({
  data: z
    .object({
      allArticle: z
        .object({
          edges: z
            .array(z.object({ node: Article }))
            .default([]),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export interface GalactapediaCategory {
  name: string;
  slug: string;
  /** DatoCMS-hosted category illustration. Empty string when the
   *  category has no thumbnail configured (article-side inline fragments
   *  never populate this either). */
  thumbnailUrl: string;
}

export interface GalactapediaTag {
  name: string;
  slug: string;
}

export interface GalactapediaArticle {
  id: string;
  title: string;
  slug: string;
  thumbnailUrl: string | null;
  categories: GalactapediaCategory[];
  /**
   * Tag associations pulled off each Article node. Primarily consumed by the
   * Tags/Categories tabs in the popup to compute per-slug article counts
   * without a second GraphQL round-trip.
   */
  tags: GalactapediaTag[];
  url: string;
}

async function postGraphql(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await fetchWithTimeout(GALACTAPEDIA_URL, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  if (!response.ok) throw new Error(`galactapedia graphql returned ${response.status}`);
  return (await response.json()) as unknown;
}

function mapArticleNodes(
  edges: ReadonlyArray<{ node: z.infer<typeof Article> }>,
): GalactapediaArticle[] {
  return edges.map(({ node }) => ({
    id: node.id,
    title: node.title,
    slug: node.slug,
    thumbnailUrl: node.thumbnail?.url ?? null,
    categories: (node.categories ?? [])
      .filter((c) => c.__typename === 'Category' && c.name && c.slug)
      // Article-side inline fragment doesn't include thumbnails — fill with
      // '' to satisfy GalactapediaCategory. See comment at the top of the
      // Category zod schema.
      .map((c) => ({ name: c.name as string, slug: c.slug as string, thumbnailUrl: '' })),
    // Tags follow the same union pattern as categories. If the server ever
    // stops exposing `tags` on Article the Zod schema tolerates it (optional),
    // and this mapper just yields an empty array.
    tags: (node.tags ?? [])
      .filter((t) => t.__typename === 'Tag' && t.name && t.slug)
      .map((t) => ({ name: t.name as string, slug: t.slug as string })),
    url: `${RSI_BASE_URL}/galactapedia/article/${node.id}-${node.slug}`,
  }));
}

export async function fetchGalactapediaArticles(
  first = 30,
  skip = 0,
): Promise<GalactapediaArticle[]> {
  // categories is a union (Article_categories = Category | Prime_Field_Document_NotFound),
  // so fields must be inside inline fragments.
  const query = `query Articles($first:Int,$skip:Int){
    allArticle(first:$first,skip:$skip){
      edges{
        node{
          id
          title
          slug
          thumbnail{url}
          categories{
            __typename
            ... on Category{ id name slug }
          }
          tags{
            __typename
            ... on Tag{ id name slug }
          }
        }
      }
    }
  }`;

  const raw = await postGraphql('Articles', query, { first, skip });
  const parsed = ArticlesResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`galactapedia: unexpected shape (${parsed.error.message})`);
  }
  if (parsed.data.errors?.length) {
    throw new Error(parsed.data.errors.map((e) => e.message).join('; '));
  }

  return mapArticleNodes(parsed.data.data?.allArticle?.edges ?? []);
}

/**
 * Size of a single A-Z index page. Largest value the endpoint accepts without
 * truncating. Exposed so callers that stream pages can align their skip values.
 */
export const GALACTAPEDIA_INDEX_PAGE_SIZE = 100;

/** Safety cap on page iteration. ~3000 articles, well above the actual catalogue. */
export const GALACTAPEDIA_INDEX_HARD_CAP_PAGES = 30;

const INDEX_QUERY = `query IndexArticles($first:Int,$skip:Int){
    allArticle(first:$first,skip:$skip,sort:{title:ASC}){
      edges{
        node{
          id
          title
          slug
          thumbnail{url}
          categories{
            __typename
            ... on Category{ id name slug }
          }
          tags{
            __typename
            ... on Tag{ id name slug }
          }
        }
      }
    }
  }`;

export interface GalactapediaIndexPage {
  articles: GalactapediaArticle[];
  /** `false` when the endpoint returned fewer than one full page. */
  hasMore: boolean;
}

/**
 * Fetch a single page of the A-Z index. Exposed so the popup can stream the
 * catalogue in as each page arrives instead of waiting on the full crawl.
 * No deduplication happens here — the caller is expected to merge pages.
 */
export async function fetchGalactapediaIndexPage(skip: number): Promise<GalactapediaIndexPage> {
  const raw = await postGraphql('IndexArticles', INDEX_QUERY, {
    first: GALACTAPEDIA_INDEX_PAGE_SIZE,
    skip,
  });
  const parsed = ArticlesResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`galactapedia index: unexpected shape (${parsed.error.message})`);
  }
  if (parsed.data.errors?.length) {
    throw new Error(parsed.data.errors.map((e) => e.message).join('; '));
  }
  const edges = parsed.data.data?.allArticle?.edges ?? [];
  const articles = mapArticleNodes(edges);
  return { articles, hasMore: edges.length >= GALACTAPEDIA_INDEX_PAGE_SIZE };
}

/**
 * Full article listing for the A-Z Index. Paginates through `allArticle`
 * sequentially until no more results come back. Meant to be cached for a long
 * time (days) — the Galactapedia is slow-moving, and pulling every article
 * costs ~5-15 sequential requests.
 *
 * Used by the background's notify poll, which only needs the final aggregate.
 * The popup streams via `fetchGalactapediaIndexPage` directly so the user sees
 * articles arrive page-by-page.
 */
export async function fetchGalactapediaIndex(): Promise<GalactapediaArticle[]> {
  const accumulated: GalactapediaArticle[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < GALACTAPEDIA_INDEX_HARD_CAP_PAGES; page++) {
    const { articles, hasMore } = await fetchGalactapediaIndexPage(
      page * GALACTAPEDIA_INDEX_PAGE_SIZE,
    );
    if (articles.length === 0) break;
    let added = 0;
    for (const article of articles) {
      if (seen.has(article.id)) continue;
      seen.add(article.id);
      accumulated.push(article);
      added++;
    }
    // If the page was short OR entirely duplicated (some backends loop), stop.
    if (!hasMore || added === 0) break;
  }

  return accumulated;
}

/**
 * Filter `articles` by a case-insensitive title substring. Exposed so the
 * background handler can search against the cached full index (which it owns)
 * instead of re-crawling here.
 *
 * The Galactapedia GraphQL endpoint *does* advertise a `filter:{title:{matches:{pattern}}}`
 * shape, but in practice it 500s on that field (same resolver bug that affects
 * `_meta`). Local filtering over the full catalog is cheap once we have it, so
 * we don't bother poking the server-side filter anymore.
 */
export function filterArticlesByTitle(
  articles: ReadonlyArray<GalactapediaArticle>,
  term: string,
): GalactapediaArticle[] {
  const pattern = term.trim().toLowerCase();
  if (!pattern) return [...articles];
  return articles.filter((a) => a.title.toLowerCase().includes(pattern));
}

/**
 * List all categories. `allCategory` is a DatoCMS-style connection — you must
 * select the full `edges { node { … } }` envelope, not bare scalar fields, or
 * the resolver 500s. The official site uses `GetCategories` with `sort: {name: ASC}`.
 */
const CategoryListResponse = z.object({
  data: z
    .object({
      allCategory: z
        .object({
          edges: z.array(z.object({ node: Category })).default([]),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export async function fetchGalactapediaCategories(): Promise<GalactapediaCategory[]> {
  // `thumbnail { url }` matches the RSI home/galactapedia SPA's own
  // GetCategories call — each category on the official home-page grid
  // uses this illustration.
  const query = `query GetCategories{
    allCategory(sort:{name:ASC},first:100){
      edges{
        node{
          __typename
          id
          name
          slug
          thumbnail { url }
        }
      }
    }
  }`;
  const raw = await postGraphql('GetCategories', query, {});
  const parsed = CategoryListResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`galactapedia categories: unexpected shape (${parsed.error.message})`);
  }
  if (parsed.data.errors?.length) {
    throw new Error(parsed.data.errors.map((e) => e.message).join('; '));
  }
  return (parsed.data.data?.allCategory?.edges ?? [])
    .map((e) => e.node)
    .filter((c) => c.name && c.slug)
    .map((c) => ({
      name: c.name as string,
      slug: c.slug as string,
      thumbnailUrl: c.thumbnail?.url ?? '',
    }));
}

/**
 * List all tags. Tags are a first-class model in DatoCMS-backed Galactapedias.
 * Reuses TagNode (shared with the tag-on-article inline fragment).
 */
const TagListResponse = z.object({
  data: z
    .object({
      allTag: z
        .object({
          edges: z.array(z.object({ node: TagNode })).default([]),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/**
 * List all tags. Like categories, `allTag` is a connection type so fields must
 * go through `edges.node`. The site's own `GetTags` query also requests a
 * separate `totalCount` and per-tag article counts via a follow-up batch; we
 * skip those extras — the tag name + slug is what the popup actually renders.
 */
// --- Single-article (inline reader) --------------------------------------
//
// The popup's Galactapedia module renders articles inline (not a deep-link to
// RSI) so the user doesn't lose their place in the extension. The query is
// literally `ArticleByID` lifted from the pledge-store/galactapedia SPA —
// thumbnail, categories, tags, body (markdown), and related articles are all
// what the site itself requests for the article page.

const ArticleFull = z
  .object({
    id: z.string(),
    title: z.string().default(''),
    slug: z.string().default(''),
    body: z.string().default(''),
    thumbnail: z
      .object({ url: z.string().nullable().optional() })
      .nullable()
      .optional(),
    categories: z.array(Category).nullable().optional(),
    tags: z.array(TagNode).nullable().optional(),
    relatedArticles: z.array(Article).nullable().optional(),
  })
  .passthrough();

const ArticleByIDResponse = z.object({
  data: z
    .object({
      Article: ArticleFull.nullable().optional(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export interface GalactapediaArticleFull {
  id: string;
  title: string;
  slug: string;
  /** Markdown source. Headings are `#`/`##`, paragraphs separated by blank
   *  lines, and inline `[text](url)` links — the bodies don't use any other
   *  markdown construct in practice. */
  body: string;
  thumbnailUrl: string | null;
  categories: GalactapediaCategory[];
  tags: GalactapediaTag[];
  /** Other articles the server curates as related — same shape as the
   *  article list rendered elsewhere. */
  relatedArticles: GalactapediaArticle[];
  url: string;
}

const ARTICLE_BY_ID_QUERY = `query ArticleByID($query: ID!) {
  Article(id: $query) {
    id
    title
    slug
    body
    thumbnail { url }
    categories {
      ... on Category { id name slug __typename }
    }
    tags {
      ... on Tag { id name slug __typename }
    }
    relatedArticles {
      ... on Article {
        id
        title
        slug
        thumbnail { url }
        categories { ... on Category { name slug __typename } }
        tags { ... on Tag { name slug __typename } }
        __typename
      }
    }
  }
}`;

/**
 * Fetch a single article by id. The id is the short slug-prefix from the
 * URL (e.g. `0Gz5DNryvE` from `/galactapedia/article/0Gz5DNryvE-fall-of-caliban`).
 * Returns null when the article doesn't exist or was unpublished.
 */
export async function fetchGalactapediaArticle(
  id: string,
): Promise<GalactapediaArticleFull | null> {
  const raw = await postGraphql('ArticleByID', ARTICLE_BY_ID_QUERY, { query: id });
  const parsed = ArticleByIDResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`galactapedia article: unexpected shape (${parsed.error.message})`);
  }
  if (parsed.data.errors?.length) {
    throw new Error(parsed.data.errors.map((e) => e.message).join('; '));
  }
  const a = parsed.data.data?.Article;
  if (!a) return null;
  return {
    id: a.id,
    title: a.title,
    slug: a.slug,
    body: a.body,
    thumbnailUrl: a.thumbnail?.url ?? null,
    categories: (a.categories ?? [])
      .filter((c) => c.__typename === 'Category' && c.name && c.slug)
      // Article-side inline fragment doesn't fetch the category thumbnail
      // (only the top-level `allCategory` query does). Fill the field with
      // '' so the shape satisfies GalactapediaCategory — the UI already
      // tolerates empty strings and renders a placeholder.
      .map((c) => ({ name: c.name as string, slug: c.slug as string, thumbnailUrl: '' })),
    tags: (a.tags ?? [])
      .filter((t) => t.__typename === 'Tag' && t.name && t.slug)
      .map((t) => ({ name: t.name as string, slug: t.slug as string })),
    relatedArticles: mapArticleNodes(
      (a.relatedArticles ?? []).map((node) => ({ node })),
    ),
    url: `${RSI_BASE_URL}/galactapedia/article/${a.id}-${a.slug}`,
  };
}

// --- Homepage (featured articles + categories) ---------------------------
//
// The /galactapedia landing page fetches a bundled `GetHomepage` payload
// that CIG curates for discovery:
//   - featuredArticle        — the "big card" at the top of the page
//   - inTheNewsArticle       — a secondary curated article
//   - featuredCategory1..4   — four hand-picked categories with thumbnails
//   - articleCount           — total article count for "browse N articles"
//
// We surface the same data in our Home tab. The server rotates the picks
// (daily-ish based on CIG observation) so we cache ~1h, which is long
// enough to make tab switches instant but short enough to see fresh
// features during a single extended session.

const HomepageArticle = z
  .object({
    id: z.string(),
    title: z.string().default(''),
    slug: z.string().default(''),
    body: z.string().default(''),
    thumbnail: z.object({ url: z.string().nullable().optional() }).nullable().optional(),
    categories: z.array(Category).nullable().optional(),
    tags: z.array(TagNode).nullable().optional(),
  })
  .passthrough();

const HomepageCategory = z
  .object({
    id: z.string().optional(),
    name: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    thumbnail: z.object({ url: z.string().nullable().optional() }).nullable().optional(),
  })
  .passthrough();

const HomepageResponse = z.object({
  data: z
    .object({
      Homepage: z
        .object({
          featuredArticle: HomepageArticle.nullable().optional(),
          inTheNewsArticle: HomepageArticle.nullable().optional(),
          featuredCategory1: HomepageCategory.nullable().optional(),
          featuredCategory2: HomepageCategory.nullable().optional(),
          featuredCategory3: HomepageCategory.nullable().optional(),
          featuredCategory4: HomepageCategory.nullable().optional(),
        })
        .nullable()
        .optional(),
      articleCount: z
        .object({ totalCount: z.coerce.number().int().default(0) })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export interface GalactapediaHomeArticle {
  id: string;
  title: string;
  slug: string;
  /** Markdown body — used to derive an excerpt/preview snippet on the
   *  home card; full article still loads via the reader. */
  body: string;
  thumbnailUrl: string | null;
  categories: GalactapediaCategory[];
  tags: GalactapediaTag[];
  url: string;
}

export interface GalactapediaHomepage {
  featuredArticle: GalactapediaHomeArticle | null;
  inTheNewsArticle: GalactapediaHomeArticle | null;
  /** Exactly 4 entries on RSI, but we defensively accept any 0..4 to
   *  survive a partial response (some featured slots left empty). */
  featuredCategories: GalactapediaCategory[];
  articleCount: number;
}

const GET_HOMEPAGE_QUERY = `query GetHomepage {
  Homepage {
    featuredArticle {
      id title slug body
      thumbnail { url }
      categories { ... on Category { name slug __typename } }
      tags { ... on Tag { name slug __typename } }
    }
    inTheNewsArticle {
      id title slug body
      thumbnail { url }
      categories { ... on Category { name slug __typename } }
      tags { ... on Tag { name slug __typename } }
    }
    featuredCategory1 { id name slug thumbnail { url } }
    featuredCategory2 { id name slug thumbnail { url } }
    featuredCategory3 { id name slug thumbnail { url } }
    featuredCategory4 { id name slug thumbnail { url } }
  }
  articleCount: allArticle(first: 1) {
    totalCount
  }
}`;

function mapHomepageArticle(
  raw: z.infer<typeof HomepageArticle> | null | undefined,
): GalactapediaHomeArticle | null {
  if (!raw) return null;
  return {
    id: raw.id,
    title: raw.title,
    slug: raw.slug,
    body: raw.body,
    thumbnailUrl: raw.thumbnail?.url ?? null,
    categories: (raw.categories ?? [])
      .filter((c) => c.__typename === 'Category' && c.name && c.slug)
      .map((c) => ({
        name: c.name as string,
        slug: c.slug as string,
        thumbnailUrl: c.thumbnail?.url ?? '',
      })),
    tags: (raw.tags ?? [])
      .filter((t) => t.__typename === 'Tag' && t.name && t.slug)
      .map((t) => ({ name: t.name as string, slug: t.slug as string })),
    url: `${RSI_BASE_URL}/galactapedia/article/${raw.id}-${raw.slug}`,
  };
}

function mapHomepageCategory(
  raw: z.infer<typeof HomepageCategory> | null | undefined,
): GalactapediaCategory | null {
  if (!raw?.name || !raw.slug) return null;
  return {
    name: raw.name,
    slug: raw.slug,
    thumbnailUrl: raw.thumbnail?.url ?? '',
  };
}

export async function fetchGalactapediaHomepage(): Promise<GalactapediaHomepage> {
  const raw = await postGraphql('GetHomepage', GET_HOMEPAGE_QUERY, {});
  const parsed = HomepageResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`galactapedia homepage: unexpected shape (${parsed.error.message})`);
  }
  if (parsed.data.errors?.length) {
    throw new Error(parsed.data.errors.map((e) => e.message).join('; '));
  }
  const hp = parsed.data.data?.Homepage;
  const featuredCategories = [
    mapHomepageCategory(hp?.featuredCategory1),
    mapHomepageCategory(hp?.featuredCategory2),
    mapHomepageCategory(hp?.featuredCategory3),
    mapHomepageCategory(hp?.featuredCategory4),
  ].filter((c): c is GalactapediaCategory => c !== null);
  return {
    featuredArticle: mapHomepageArticle(hp?.featuredArticle),
    inTheNewsArticle: mapHomepageArticle(hp?.inTheNewsArticle),
    featuredCategories,
    articleCount: parsed.data.data?.articleCount?.totalCount ?? 0,
  };
}

// --- Random article ------------------------------------------------------
//
// Server-side random pick used by the "Random article" button on the
// Home tab. The RSI SPA uses `ArticleByRandomWhere` with a random skip
// offset in [0, totalCount) — we mirror that exactly. The `where` filter
// is optional; RSI's own SPA sometimes passes exclusion lists of recently
// shown articles to avoid immediate repeats, but a single random pick per
// click is plenty for our use case, so we skip that nicety.

const ArticleByRandomResponse = z.object({
  data: z
    .object({
      allArticle: z
        .object({
          edges: z.array(z.object({ node: Article })).default([]),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const ARTICLE_BY_RANDOM_QUERY = `query ArticleByRandomWhere($skip: Int) {
  allArticle(skip: $skip, first: 1) {
    edges {
      node {
        id
        title
        slug
        thumbnail { url }
        categories { ... on Category { id name slug __typename } }
        tags { ... on Tag { id name slug __typename } }
      }
    }
  }
}`;

/**
 * Fetch a random Galactapedia article. Caller passes the total article
 * count (from `fetchGalactapediaHomepage` → `articleCount`) so we can
 * range the random skip — otherwise we'd have to do a second query just
 * to learn the bound, and any stale cached count is fine here (a slightly
 * off bound still yields a random article, just biased toward the
 * earlier-sorted half).
 */
export async function fetchRandomGalactapediaArticle(
  totalCount: number,
): Promise<GalactapediaArticle | null> {
  if (totalCount <= 0) return null;
  const skip = Math.floor(Math.random() * totalCount);
  const raw = await postGraphql('ArticleByRandomWhere', ARTICLE_BY_RANDOM_QUERY, { skip });
  const parsed = ArticleByRandomResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`galactapedia random: unexpected shape (${parsed.error.message})`);
  }
  if (parsed.data.errors?.length) {
    throw new Error(parsed.data.errors.map((e) => e.message).join('; '));
  }
  const edges = parsed.data.data?.allArticle?.edges ?? [];
  const articles = mapArticleNodes(edges);
  return articles[0] ?? null;
}

export async function fetchGalactapediaTags(): Promise<GalactapediaTag[]> {
  const query = `query GetTags{
    allTag(sort:{slug:ASC},first:100){
      edges{
        node{
          __typename
          id
          name
          slug
        }
      }
    }
  }`;
  const raw = await postGraphql('GetTags', query, {});
  const parsed = TagListResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`galactapedia tags: unexpected shape (${parsed.error.message})`);
  }
  if (parsed.data.errors?.length) {
    throw new Error(parsed.data.errors.map((e) => e.message).join('; '));
  }
  return (parsed.data.data?.allTag?.edges ?? [])
    .map((e) => e.node)
    .filter((t) => t.name && t.slug)
    .map((t) => ({ name: t.name as string, slug: t.slug as string }));
}
