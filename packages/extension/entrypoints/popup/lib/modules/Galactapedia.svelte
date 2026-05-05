<script lang="ts">
  import { sendRsiMessage, RSI_BASE_URL, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    ArrowLeft,
    BookOpen,
    ExternalLink,
    Hash,
    Home as HomeIcon,
    List,
    Loader2,
    Newspaper,
    Shuffle,
    Sparkles,
    Star,
    Tags as TagsIcon,
    X,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import { persistedState } from '../persist.svelte';
  import { createFavorites } from '../favorites.svelte';
  import { errorMessage } from '../error';
  import { runWithDelayedLoading } from '../loading';
  import { safeHref } from '../safe-href';

  type Article = Rsi.GalactapediaArticle;
  type ArticleFull = Rsi.GalactapediaArticleFull;
  type Category = Rsi.GalactapediaCategory;
  type Tag = Rsi.GalactapediaTag;
  type Homepage = Rsi.GalactapediaHomepage;
  type Tab = 'home' | 'articles' | 'categories' | 'tags' | 'index';

  // Inline-reader navigation frames. The reader is a stack so clicking a
  // related article, then another, then going "back" returns to the
  // previous article rather than the list. Stack cleared by the X button.
  type ReaderFrame =
    | { kind: 'article'; id: string }
    | { kind: 'category'; slug: string; name: string }
    | { kind: 'tag'; slug: string; name: string };

  const PAGE = 30;

  const TABS: readonly Tab[] = ['home', 'articles', 'categories', 'tags', 'index'];
  const isTab = (v: unknown): v is Tab =>
    typeof v === 'string' && (TABS as readonly string[]).includes(v);
  // Default to 'home' for new installs; returning users with a persisted
  // 'articles' / 'categories' / etc. stay where they were.
  const tabP = persistedState<Tab>('galactapedia:tab', 'home', isTab);
  // Read-only alias so the many template references stay unchanged; only the
  // assignment in switchTab() needs to go through tabP.value.
  const tab = $derived(tabP.value);

  // Starred articles. Same contract as ships: local per-browser, survives popup
  // open/close, and surfaces favorites first in the Articles grid.
  const favorites = createFavorites('galactapedia');

  // ---- Home tab (featured + random + category picks) ----------------------
  let home = $state<Homepage | null>(null);
  let homeLoading = $state(false);
  let homeError = $state<string | null>(null);
  let homeFromCache = $state(false);
  let randomLoading = $state(false);

  async function loadHome(force = false) {
    homeError = null;
    await runWithDelayedLoading(
      (v) => { homeLoading = v; },
      async () => {
        try {
          const res = await sendRsiMessage({ type: 'galactapedia.home', force });
          home = res.home;
          homeFromCache = res.fromCache;
        } catch (e) {
          homeError = errorMessage(e);
        }
      },
    );
  }

  async function pickRandom() {
    if (randomLoading) return;
    randomLoading = true;
    try {
      const count = home?.articleCount ?? 0;
      if (count === 0) {
        // Fall back to a sensible default — at worst the server clamps
        // skip into its actual range.
        const res = await sendRsiMessage({ type: 'galactapedia.random', totalCount: 1000 });
        if (res.article) openArticle(res.article.id);
        return;
      }
      const res = await sendRsiMessage({ type: 'galactapedia.random', totalCount: count });
      if (res.article) openArticle(res.article.id);
    } catch (e) {
      homeError = errorMessage(e);
    } finally {
      randomLoading = false;
    }
  }

  // Clean excerpt from a markdown body — strip the leading `# TITLE`
  // heading (same as article title) and trim to a readable paragraph.
  function homeExcerpt(body: string, maxChars = 220): string {
    const stripped = body
      .split('\n')
      .filter((l) => !/^#+\s/.test(l.trim()))
      .join(' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // drop markdown links, keep text
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped.length <= maxChars) return stripped;
    return stripped.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
  }

  // ---- Articles tab (paginated browse + title search via cached index) -----
  // Browsing without a search pages through `allArticle` as normal. When the
  // user types a query the background hands the search off to the cached full
  // A-Z index and filters it locally — the GraphQL title-matches filter 500s,
  // and the index is already the best source for comprehensive search results.
  let articles = $state<Article[]>([]);
  // Initial `false` — `loading` only tracks the Articles tab fetch. Left
  // as `true` historically (from when Articles was the default tab), but
  // now that Home is the default it meant the header progress bar stayed
  // stuck on for any tab other than Articles, since the reset only
  // happens inside `loadArticles`'s finally block. The ORed
  // `loading={homeLoading || loading || …}` in ModuleHeader made the
  // spinner+progress bar appear to run forever on the Home/Categories
  // /Tags/Index tabs, even though nothing was actually being fetched.
  let loading = $state(false);
  let loadingMore = $state(false);
  let hasMore = $state(true);
  let error = $state<string | null>(null);
  let fromCache = $state(false);
  let query = $state('');
  let activeSearch = $state<string | null>(null);
  let sentinel = $state<HTMLElement | null>(null);
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  async function loadArticles(skip: number, force = false, search: string | null = activeSearch) {
    error = null;
    await runWithDelayedLoading(
      (v) => {
        if (skip === 0) loading = v;
        else loadingMore = v;
      },
      async () => {
        try {
          const res = await sendRsiMessage({
            type: 'galactapedia.list',
            first: PAGE,
            skip,
            search: search ?? '',
            force,
          });
          if (skip === 0) {
            articles = res.articles;
          } else {
            const existingIds = new Set(articles.map((a) => a.id));
            articles = [...articles, ...res.articles.filter((a) => !existingIds.has(a.id))];
          }
          fromCache = res.fromCache;
          activeSearch = res.search;
          if (res.articles.length < PAGE) hasMore = false;
          else hasMore = true;
        } catch (e) {
          error = errorMessage(e);
        }
      },
    );
  }

  function refreshArticles() {
    articles = [];
    hasMore = true;
    loadArticles(0, true, activeSearch);
  }

  // Debounced search. We only trigger once typing settles — the background
  // serves search results off the cached index, so most requests are instant.
  function onQueryInput() {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      const next = query.trim();
      if (next === (activeSearch ?? '')) return;
      articles = [];
      hasMore = true;
      loading = true;
      loadArticles(0, false, next || null);
    }, 300);
  }

  // Clear any pending debounced search when the module unmounts. Otherwise
  // the timer can fire after the component is torn down and write to state
  // that no longer exists.
  $effect(() => () => {
    if (searchDebounce) clearTimeout(searchDebounce);
  });

  $effect(() => {
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (loading || loadingMore || !hasMore) return;
        loadArticles(articles.length);
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  // Local client-side search for the Categories / Tags / Index tabs. Each has
  // its own query string so switching tabs doesn't clobber an in-progress
  // filter on another tab.
  let categoryQuery = $state('');
  let tagQuery = $state('');
  let indexQuery = $state('');

  // ---- Categories tab --------------------------------------------------------
  let categories = $state<Category[]>([]);
  let categoriesLoading = $state(false);
  let categoriesError = $state<string | null>(null);
  let categoriesFetched = $state(false);

  async function loadCategories(force = false) {
    categoriesError = null;
    await runWithDelayedLoading(
      (v) => { categoriesLoading = v; },
      async () => {
        try {
          const res = await sendRsiMessage({ type: 'galactapedia.categories', force });
          categories = res.categories;
          categoriesFetched = true;
        } catch (e) {
          categoriesError = errorMessage(e);
        }
      },
    );
  }

  // ---- Tags tab --------------------------------------------------------------
  let tags = $state<Tag[]>([]);
  let tagsLoading = $state(false);
  let tagsError = $state<string | null>(null);
  let tagsFetched = $state(false);

  async function loadTags(force = false) {
    tagsError = null;
    await runWithDelayedLoading(
      (v) => { tagsLoading = v; },
      async () => {
        try {
          const res = await sendRsiMessage({ type: 'galactapedia.tags', force });
          tags = res.tags;
          tagsFetched = true;
        } catch (e) {
          tagsError = errorMessage(e);
        }
      },
    );
  }

  // ---- Index tab (A-Z) -------------------------------------------------------
  // On first open (cache miss) the popup streams pages in: we call
  // `galactapedia.indexPage` with increasing skip, append each page to
  // `indexArticles`, and the UI re-renders incrementally — the user sees the
  // A-Z buckets fill in live rather than staring at a spinner. When the last
  // page arrives we commit the aggregate to the background cache so the next
  // open is instant. Subsequent opens read the full cached array via
  // `galactapedia.indexCached` and render everything at once.
  let indexArticles = $state<Article[]>([]);
  let indexLoading = $state(false);
  let indexError = $state<string | null>(null);
  let indexFetched = $state(false);
  let indexFromCache = $state(false);
  let indexStreaming = $state(false);
  const INDEX_PAGE_SIZE = 100;
  const INDEX_HARD_CAP_PAGES = 30;

  async function streamIndex() {
    // Streaming path: popup drives the pagination, background fetches one
    // page per call. Dedupe by id — the endpoint occasionally returns
    // overlapping edges near the tail.
    indexStreaming = true;
    indexArticles = [];
    const seen = new Set<string>();
    const accumulated: Article[] = [];

    try {
      for (let page = 0; page < INDEX_HARD_CAP_PAGES; page++) {
        const res = await sendRsiMessage({
          type: 'galactapedia.indexPage',
          skip: page * INDEX_PAGE_SIZE,
        });
        let added = 0;
        for (const a of res.articles) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          accumulated.push(a);
          added++;
        }
        // Sort-as-we-go so the A-Z buckets stay coherent while streaming.
        // The endpoint already sorts by title ASC, but dedupe+append can
        // shuffle the edges when a tail page overlaps the previous one.
        indexArticles = accumulated
          .slice()
          .sort((a, b) => a.title.localeCompare(b.title));
        if (!res.hasMore || added === 0) break;
      }
      // Cache the aggregate so the next open is instant.
      await sendRsiMessage({
        type: 'galactapedia.indexCommit',
        articles: accumulated,
      });
      indexFromCache = false;
      indexFetched = true;
    } finally {
      indexStreaming = false;
    }
  }

  async function loadIndex(force = false) {
    indexError = null;
    await runWithDelayedLoading(
      (v) => { indexLoading = v; },
      async () => {
        try {
          if (!force) {
            // Fast path: read the cached aggregate if present. Never triggers a
            // crawl — if the cache is empty we fall through to streaming.
            const cached = await sendRsiMessage({ type: 'galactapedia.indexCached' });
            if (cached.articles) {
              indexArticles = cached.articles;
              indexFromCache = true;
              indexFetched = true;
              return;
            }
          }
          await streamIndex();
        } catch (e) {
          indexError = errorMessage(e);
        }
      },
    );
  }

  const indexGroups = $derived.by<Array<{ letter: string; items: Article[] }>>(() => {
    const q = indexQuery.trim().toLowerCase();
    const source = q
      ? indexArticles.filter((a) => a.title.toLowerCase().includes(q))
      : indexArticles;
    const map = new Map<string, Article[]>();
    for (const a of source) {
      const first = (a.title.trim()[0] ?? '#').toUpperCase();
      const bucket = /[A-Z]/.test(first) ? first : '#';
      const arr = map.get(bucket) ?? [];
      arr.push(a);
      map.set(bucket, arr);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([letter, items]) => ({
        letter,
        items: items.slice().sort((x, y) => x.title.localeCompare(y.title)),
      }));
  });

  const indexMatchCount = $derived(
    indexGroups.reduce((n, g) => n + g.items.length, 0),
  );

  // ---- Per-slug article counts (Categories/Tags) -----------------------------
  // Computed from the cached A-Z index. Empty until the index has been fetched
  // at least once — the two-step UX (show all, then enhance) falls out of this:
  // `hasCounts` flips the moment counts are available, at which point zero-
  // count rows drop out and non-zero rows get a `(N)` annotation. No counts ⇒
  // show everything as-is.
  const categoryCounts = $derived.by<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const a of indexArticles) {
      for (const c of a.categories) {
        m.set(c.slug, (m.get(c.slug) ?? 0) + 1);
      }
    }
    return m;
  });

  const tagCounts = $derived.by<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const a of indexArticles) {
      for (const t of a.tags) {
        m.set(t.slug, (m.get(t.slug) ?? 0) + 1);
      }
    }
    return m;
  });

  const hasCounts = $derived(indexFetched && indexArticles.length > 0);

  const filteredCategories = $derived.by<Category[]>(() => {
    const q = categoryQuery.trim().toLowerCase();
    const base = hasCounts
      ? categories.filter((c) => (categoryCounts.get(c.slug) ?? 0) > 0)
      : categories;
    if (!q) return base;
    return base.filter((c) => c.name.toLowerCase().includes(q));
  });

  const filteredTags = $derived.by<Tag[]>(() => {
    const q = tagQuery.trim().toLowerCase();
    const base = hasCounts
      ? tags.filter((t) => (tagCounts.get(t.slug) ?? 0) > 0)
      : tags;
    if (!q) return base;
    return base.filter((t) => t.name.toLowerCase().includes(q));
  });

  function switchTab(next: Tab) {
    tabP.value = next;
    if (next === 'home' && home === null && !homeLoading) void loadHome();
    if (next === 'categories' && !categoriesFetched && !categoriesLoading) void loadCategories();
    if (next === 'tags' && !tagsFetched && !tagsLoading) void loadTags();
    if (next === 'index' && !indexFetched && !indexLoading) void loadIndex();
    // Categories and Tags need the cached full index to compute per-slug
    // article counts. Kick it off in the background on first visit — the list
    // renders straight away off `categories`/`tags`, counts stream in after
    // the index resolves (2-step UX: first show all, then annotate + prune).
    if ((next === 'categories' || next === 'tags') && !indexFetched && !indexLoading) {
      void loadIndex();
    }
  }

  // Initial load: honor the persisted active tab. Previously this always
  // called loadArticles(0), which left Categories / Tags / Index tabs empty
  // when returning to the Galactapedia module — the user had to toggle tabs
  // manually before their cached content appeared.
  //
  // At module-init time `indexFetched` / `indexLoading` are always false so
  // we unconditionally kick loadIndex() for Categories / Tags (same two-step
  // UX as switchTab — list first, counts layer on). loadIndex itself reads
  // the background cache before crawling, so the call is cheap on a hit.
  switch (tabP.value) {
    case 'home':
      void loadHome();
      break;
    case 'articles':
      loadArticles(0);
      break;
    case 'categories':
      void loadCategories();
      void loadIndex();
      break;
    case 'tags':
      void loadTags();
      void loadIndex();
      break;
    case 'index':
      void loadIndex();
      break;
  }

  // ---- Inline reader --------------------------------------------------------
  // When non-empty, the reader overlay hides the tabs view and renders the top
  // frame (an article or a filtered article list for a category/tag). Links
  // within the article body route back here via interceptInlineLink, so a user
  // can browse through related articles without ever leaving the extension.

  let readerStack = $state<ReaderFrame[]>([]);
  const currentFrame = $derived<ReaderFrame | null>(
    readerStack.length > 0 ? readerStack[readerStack.length - 1]! : null,
  );

  // Article being displayed in the current frame. Swapped out whenever
  // currentFrame changes to an article. We key the fetch by frame.id rather
  // than the frame object itself so visiting the same id twice in the stack
  // (forward nav then back) doesn't re-fire the fetch.
  let currentArticle = $state<ArticleFull | null>(null);
  let articleId = $state<string | null>(null);
  let articleLoading = $state(false);
  let articleError = $state<string | null>(null);
  let readerScroll = $state<HTMLElement | null>(null);

  $effect(() => {
    const f = currentFrame;
    if (!f || f.kind !== 'article') {
      articleId = null;
      currentArticle = null;
      return;
    }
    if (articleId === f.id && currentArticle) return;
    articleId = f.id;
    void loadArticle(f.id);
  });

  // Monotonic request counter guards against race conditions when the user
  // navigates rapidly (article → related → another, before the first fetch
  // resolves). Responses that arrive after a newer request are discarded so
  // the UI never renders stale content.
  let articleRequestSeq = 0;
  async function loadArticle(id: string) {
    const requestId = ++articleRequestSeq;
    articleError = null;
    currentArticle = null;
    await runWithDelayedLoading(
      (v) => {
        // Ignore superseded-request resets — the newer request owns the flag.
        if (requestId !== articleRequestSeq) return;
        articleLoading = v;
      },
      async () => {
        try {
          const res = await sendRsiMessage({ type: 'galactapedia.article', id });
          if (requestId !== articleRequestSeq) return; // superseded by a newer click
          currentArticle = res.article;
          // Scroll to top whenever we swap article (either push or back) so the
          // user lands on the title instead of mid-body from the previous frame.
          if (readerScroll) readerScroll.scrollTop = 0;
        } catch (e) {
          if (requestId !== articleRequestSeq) return;
          articleError = errorMessage(e);
        }
      },
    );
  }

  function pushFrame(f: ReaderFrame): void {
    readerStack = [...readerStack, f];
  }
  function popFrame(): void {
    readerStack = readerStack.slice(0, -1);
  }
  function closeReader(): void {
    readerStack = [];
  }

  function openArticle(id: string): void {
    pushFrame({ kind: 'article', id });
  }
  function openCategory(slug: string, fallbackName?: string): void {
    const name = categories.find((c) => c.slug === slug)?.name ?? fallbackName ?? slug;
    // Opening a category list requires the index to be loaded — the filter
    // runs locally against indexArticles. Kick the fetch if needed; the
    // reader view handles its own loading state below.
    if (!indexFetched && !indexLoading) void loadIndex();
    pushFrame({ kind: 'category', slug, name });
  }
  function openTag(slug: string, fallbackName?: string): void {
    const name = tags.find((t) => t.slug === slug)?.name ?? fallbackName ?? slug;
    if (!indexFetched && !indexLoading) void loadIndex();
    pushFrame({ kind: 'tag', slug, name });
  }

  // Parse a Galactapedia URL (absolute or relative) into an inline-nav target.
  // Returns null for anything that isn't a recognised Galactapedia shape —
  // those fall through to the default <a target="_blank"> behaviour.
  function parseGalactapediaLink(href: string):
    | { kind: 'article'; id: string }
    | { kind: 'category'; slug: string }
    | { kind: 'tag'; slug: string }
    | null {
    const m = /\/galactapedia\/(article|category|tag)\/([^?#]+)/.exec(href);
    if (!m) return null;
    const kind = m[1];
    const path = m[2] ?? '';
    if (kind === 'article') {
      // Article URLs are `<id>-<slug>` — id is a 10-12 char alnum prefix.
      // Split on the first dash; if no dash the whole path is the id.
      const dash = path.indexOf('-');
      const id = dash === -1 ? path : path.slice(0, dash);
      if (!id) return null;
      return { kind: 'article', id };
    }
    if (kind === 'category') return { kind: 'category', slug: path };
    if (kind === 'tag') return { kind: 'tag', slug: path };
    return null;
  }

  function interceptInlineLink(e: MouseEvent, href: string): void {
    // Modifier-clicks should keep the default "open in new tab" behaviour
    // so power users can pop a referenced article without losing the
    // reader context.
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    const parsed = parseGalactapediaLink(href);
    if (!parsed) return;
    e.preventDefault();
    if (parsed.kind === 'article') openArticle(parsed.id);
    else if (parsed.kind === 'category') openCategory(parsed.slug);
    else openTag(parsed.slug);
  }

  // --- Markdown renderer -----------------------------------------------------
  // Galactapedia bodies use a narrow markdown subset: `# / ## / …` headings,
  // blank-line-separated paragraphs, and inline `[text](url)` links. Nothing
  // else shows up in practice (no bold/italic/lists/tables/code). We parse
  // into a typed block/segment tree so the Svelte template can render without
  // touching {@html} — keeps link-click interception type-safe and avoids
  // any accidental script injection from the API.

  type InlineSegment =
    | { kind: 'text'; text: string }
    | { kind: 'link'; text: string; href: string };
  type MdBlock =
    | { kind: 'heading'; level: number; text: string }
    | { kind: 'paragraph'; segments: InlineSegment[] };

  function parseInline(text: string): InlineSegment[] {
    const out: InlineSegment[] = [];
    const re = /\[([^\]]+)\]\(([^)]+)\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
      out.push({ kind: 'link', text: m[1]!, href: m[2]! });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
    return out;
  }

  function parseMarkdown(body: string): MdBlock[] {
    const blocks: MdBlock[] = [];
    const lines = body.split('\n');
    let buf: string[] = [];
    const flush = () => {
      if (buf.length === 0) return;
      const text = buf.join(' ').trim();
      if (text) blocks.push({ kind: 'paragraph', segments: parseInline(text) });
      buf = [];
    };
    for (const raw of lines) {
      const line = raw.trim();
      const h = /^(#+)\s+(.+)$/.exec(line);
      if (h) {
        flush();
        blocks.push({ kind: 'heading', level: Math.min(h[1]!.length, 6), text: h[2]!.trim() });
      } else if (!line) {
        flush();
      } else {
        buf.push(line);
      }
    }
    flush();
    return blocks;
  }

  const articleBlocks = $derived<MdBlock[]>(
    currentArticle ? parseMarkdown(currentArticle.body) : [],
  );

  // Articles filtered by the active category/tag frame. Runs locally against
  // the cached A-Z index — avoids a second server round-trip since the
  // category/tag tabs already stream the index in and categoryCounts/tagCounts
  // already rely on it.
  const frameArticles = $derived.by<Article[]>(() => {
    const f = currentFrame;
    if (!f) return [];
    if (f.kind === 'category') {
      return indexArticles
        .filter((a) => a.categories.some((c) => c.slug === f.slug))
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title));
    }
    if (f.kind === 'tag') {
      return indexArticles
        .filter((a) => a.tags.some((t) => t.slug === f.slug))
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title));
    }
    return [];
  });
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader
    title="Galactapedia"
    loading={articleLoading || homeLoading || loading || loadingMore || categoriesLoading || tagsLoading || indexLoading}
    fromCache={currentFrame
      ? false
      : tab === 'home'
        ? homeFromCache
        : tab === 'index'
          ? indexFromCache
          : fromCache}
    onRefresh={() => {
      if (currentFrame?.kind === 'article' && currentFrame.id) {
        void loadArticle(currentFrame.id);
        return;
      }
      if (tab === 'home') void loadHome(true);
      else if (tab === 'articles') refreshArticles();
      else if (tab === 'categories') void loadCategories(true);
      else if (tab === 'tags') void loadTags(true);
      else if (tab === 'index') void loadIndex(true);
    }}
  >
    {#snippet meta()}
      {#if currentFrame}
        <!-- Reader-mode meta is rendered in the breadcrumb strip below. -->
      {:else if tab === 'home'}
        {#if home && home.articleCount > 0}
          <span class="text-[10px] text-slate-500">{home.articleCount} articles</span>
        {/if}
      {:else if tab === 'articles'}
        <span
          class="text-[10px] text-slate-500"
          title={activeSearch
            ? `Title-match hits for "${activeSearch}" in the cached A-Z index`
            : 'Articles loaded so far — scroll down to page in more'}
        >
          {articles.length}
          {#if activeSearch}
            match{articles.length === 1 ? '' : 'es'} for "{activeSearch}"
          {:else}
            loaded{hasMore ? '+' : ''}
          {/if}
        </span>
      {:else if tab === 'categories'}
        <span class="text-[10px] text-slate-500">
          {filteredCategories.length}{categoryQuery.trim() ? `/${categories.length}` : ''}
        </span>
      {:else if tab === 'tags'}
        <span class="text-[10px] text-slate-500">
          {filteredTags.length}{tagQuery.trim() ? `/${tags.length}` : ''}
        </span>
      {:else if tab === 'index'}
        <span class="text-[10px] text-slate-500">
          {#if indexStreaming}
            streaming · {indexArticles.length} so far
          {:else}
            {indexMatchCount}{indexQuery.trim() ? `/${indexArticles.length}` : ''}
          {/if}
        </span>
      {/if}
    {/snippet}
    {#snippet controls()}
      {#if currentFrame}
        <!-- No search controls while reading — back/close are in the
             breadcrumb strip. -->
      {:else if tab === 'home'}
        <button
          type="button"
          onclick={pickRandom}
          disabled={randomLoading}
          title="Open a random article"
          class="inline-flex items-center gap-1 rounded-md bg-sky-500/20 px-2 py-1 text-[11px] font-semibold text-sky-300 ring-1 ring-sky-500/40 transition hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {#if randomLoading}
            <Loader2 class="size-3 animate-spin" />
          {:else}
            <Shuffle class="size-3" />
          {/if}
          Random
        </button>
      {:else if tab === 'articles'}
        <input
          type="search"
          placeholder="Search articles…"
          bind:value={query}
          oninput={onQueryInput}
          title="Title search across the full catalog"
          class="min-w-0 flex-1 max-w-48 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
        />
      {:else if tab === 'categories'}
        <input
          type="search"
          placeholder="Filter categories…"
          bind:value={categoryQuery}
          title="Local name filter"
          class="min-w-0 flex-1 max-w-48 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
        />
      {:else if tab === 'tags'}
        <input
          type="search"
          placeholder="Filter tags…"
          bind:value={tagQuery}
          title="Local name filter"
          class="min-w-0 flex-1 max-w-48 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
        />
      {:else if tab === 'index'}
        <input
          type="search"
          placeholder="Filter index…"
          bind:value={indexQuery}
          title="Local title filter"
          class="min-w-0 flex-1 max-w-48 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
        />
      {/if}
    {/snippet}
  </ModuleHeader>

  {#if currentFrame}
    <!-- Reader breadcrumb / back strip. Replaces the tabs so the user has
         a single navigation affordance while reading. The depth counter
         gives a discreet hint that Back vs Close do different things when
         we've nested multiple articles. -->
    <div class="flex items-center gap-2 border-b border-slate-800 bg-slate-950/40 px-3 py-1.5 text-xs">
      <button
        type="button"
        onclick={popFrame}
        title="Back"
        aria-label="Back"
        class="rounded p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
      >
        <ArrowLeft class="size-3.5" />
      </button>
      <div class="min-w-0 flex-1 truncate text-slate-400">
        {#if currentFrame.kind === 'article'}
          <span class="text-[10px] uppercase tracking-wider text-slate-500">Article</span>
          <span class="ml-1.5 text-slate-200">{currentArticle?.title ?? '…'}</span>
        {:else if currentFrame.kind === 'category'}
          <span class="text-[10px] uppercase tracking-wider text-slate-500">Category</span>
          <span class="ml-1.5 text-slate-200">{currentFrame.name}</span>
        {:else}
          <span class="text-[10px] uppercase tracking-wider text-slate-500">Tag</span>
          <span class="ml-1.5 text-slate-200">{currentFrame.name}</span>
        {/if}
      </div>
      {#if readerStack.length > 1}
        <span class="text-[10px] text-slate-400">depth {readerStack.length}</span>
      {/if}
      <button
        type="button"
        onclick={closeReader}
        title="Close reader"
        aria-label="Close reader"
        class="rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-rose-300"
      >
        <X class="size-3.5" />
      </button>
    </div>

    <div bind:this={readerScroll} class="flex-1 overflow-y-auto p-3">
      {#if currentFrame.kind === 'article'}
        {#if articleError}
          <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
            <AlertTriangle class="mt-0.5 size-4 shrink-0" />
            <div>
              <p class="font-semibold">Failed to load article</p>
              <p class="mt-1 break-all text-rose-300/80">{articleError}</p>
            </div>
          </div>
        {:else if articleLoading || !currentArticle}
          <div class="flex h-full items-center justify-center text-slate-500">
            <Loader2 class="size-5 animate-spin" />
          </div>
        {:else}
          {@const art = currentArticle}
          {@const isFav = favorites.has(art.id)}
          <article class="mx-auto max-w-prose tab:max-w-5xl">
            {#if art.thumbnailUrl}
              <div class="mb-3 aspect-[16/9] overflow-hidden rounded bg-slate-950">
                <img src={art.thumbnailUrl} alt="" class="size-full object-cover" />
              </div>
            {/if}
            <header class="mb-3 flex items-start gap-2">
              <h1 class="flex-1 text-lg font-semibold text-slate-100">{art.title}</h1>
              <button
                type="button"
                onclick={() => favorites.toggle(art.id)}
                title={isFav ? 'Remove from favorites' : 'Add to favorites'}
                aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                aria-pressed={isFav}
                class="shrink-0 rounded p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-amber-300 {isFav ? 'text-amber-400' : ''}"
              >
                <Star class="size-4 {isFav ? 'fill-amber-400' : ''}" />
              </button>
              <a
                href={art.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open on RSI"
                aria-label="Open on RSI"
                class="shrink-0 rounded p-1.5 text-slate-500 transition hover:bg-slate-800 hover:text-sky-300"
              >
                <ExternalLink class="size-4" />
              </a>
            </header>
            {#if art.categories.length > 0 || art.tags.length > 0}
              <div class="mb-3 flex flex-wrap gap-1.5 text-[11px]">
                {#each art.categories as c (c.slug)}
                  <button
                    type="button"
                    onclick={() => openCategory(c.slug, c.name)}
                    class="inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-300 ring-1 ring-sky-500/30 transition hover:bg-sky-500/20"
                  >
                    <Hash class="size-2.5" />
                    {c.name}
                  </button>
                {/each}
                {#each art.tags as t (t.slug)}
                  <button
                    type="button"
                    onclick={() => openTag(t.slug, t.name)}
                    class="inline-flex items-center gap-1 rounded-full bg-slate-900/70 px-1.5 py-0.5 text-slate-300 ring-1 ring-slate-800 transition hover:bg-slate-800 hover:text-slate-100"
                  >
                    <TagsIcon class="size-2.5" />
                    {t.name}
                  </button>
                {/each}
              </div>
            {/if}
            <div class="space-y-3 text-sm leading-relaxed text-slate-300">
              {#each articleBlocks as block, i (i)}
                <!-- Per-block error boundary. Galactapedia content is
                     parsed from RSI's GraphQL response (which may
                     occasionally ship a block with an unexpected
                     shape — pre-release content, half-localised
                     entries, etc.). Without this, a single bad
                     block tears down the entire article render via
                     the parent module-level boundary in App.svelte;
                     the user has to click "Reload module" to recover.
                     With it, the broken block degrades to a one-line
                     fallback and the rest of the article still
                     reads. -->
                <svelte:boundary>
                  {#if block.kind === 'heading'}
                    {#if block.level === 1}
                      <h2 class="mt-4 text-base font-semibold uppercase tracking-wider text-sky-300">{block.text}</h2>
                    {:else if block.level === 2}
                      <h3 class="mt-3 text-sm font-semibold text-slate-100">{block.text}</h3>
                    {:else}
                      <h4 class="mt-2 text-[13px] font-semibold text-slate-200">{block.text}</h4>
                    {/if}
                  {:else}
                    <p>
                      {#each block.segments as seg, j (j)}
                        {#if seg.kind === 'text'}{seg.text}{:else}
                          <a
                            href={safeHref(seg.href)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onclick={(e) => interceptInlineLink(e, seg.href)}
                            class="text-sky-400 underline decoration-sky-700 underline-offset-2 hover:decoration-sky-400"
                          >{seg.text}</a>
                        {/if}
                      {/each}
                    </p>
                  {/if}
                  {#snippet failed()}
                    <p class="text-[11px] italic text-rose-400/70">
                      [Galactapedia rendering error — skipping this block]
                    </p>
                  {/snippet}
                </svelte:boundary>
              {/each}
            </div>
            {#if art.relatedArticles.length > 0}
              <section class="mt-6 border-t border-slate-800 pt-3">
                <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Related</p>
                <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2 tab:grid-cols-3 tab:2xl:grid-cols-4">
                  {#each art.relatedArticles as r (r.id)}
                    <li>
                      <button
                        type="button"
                        onclick={() => openArticle(r.id)}
                        class="group flex w-full items-center gap-2 rounded-md bg-slate-900/70 p-2 text-left ring-1 ring-slate-800 transition hover:ring-sky-600"
                      >
                        {#if r.thumbnailUrl}
                          <div class="size-10 shrink-0 overflow-hidden rounded bg-slate-950">
                            <img src={r.thumbnailUrl} alt="" loading="lazy" class="size-full object-cover" />
                          </div>
                        {:else}
                          <div class="flex size-10 shrink-0 items-center justify-center rounded bg-slate-950 text-slate-700">
                            <BookOpen class="size-4" />
                          </div>
                        {/if}
                        <div class="min-w-0 flex-1">
                          <p class="line-clamp-2 text-xs font-medium text-slate-100">{r.title}</p>
                          {#if r.categories.length > 0}
                            <p class="mt-0.5 line-clamp-1 text-[10px] text-slate-500">
                              {r.categories.map((c) => c.name).join(' · ')}
                            </p>
                          {/if}
                        </div>
                      </button>
                    </li>
                  {/each}
                </ul>
              </section>
            {/if}
          </article>
        {/if}
      {:else}
        {@const frameName = currentFrame.name}
        {@const frameKind = currentFrame.kind}
        <!-- Category / Tag frame: filtered article list. The filter runs
             locally against the cached A-Z index, so we only render after
             the index is loaded. If the index is still streaming we show a
             progress hint. -->
        {#if !indexFetched && indexLoading}
          <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <Loader2 class="size-5 animate-spin" />
            <p class="text-[11px] italic">Loading catalog (first-time only)…</p>
          </div>
        {:else if frameArticles.length === 0}
          <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
            <BookOpen class="size-8" />
            <p class="text-xs italic">No articles in {frameKind} "{frameName}".</p>
          </div>
        {:else}
          <p class="mb-2 text-[10px] text-slate-500">
            {frameArticles.length} article{frameArticles.length === 1 ? '' : 's'} in {frameKind}
            "<span class="text-slate-300">{frameName}</span>"
          </p>
          <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 4xl:grid-cols-5">
            {#each frameArticles as a (a.id)}
              {@const isFav = favorites.has(a.id)}
              <li class="relative">
                <button
                  type="button"
                  onclick={() => openArticle(a.id)}
                  class="group flex w-full items-center gap-2 rounded-md bg-slate-900/70 p-2 text-left ring-1 ring-slate-800 transition hover:ring-sky-600
                    {isFav ? 'ring-amber-500/60' : ''}"
                >
                  {#if a.thumbnailUrl}
                    <div class="size-12 shrink-0 overflow-hidden rounded bg-slate-950">
                      <img src={a.thumbnailUrl} alt="" loading="lazy" class="size-full object-cover" />
                    </div>
                  {:else}
                    <div class="flex size-12 shrink-0 items-center justify-center rounded bg-slate-950 text-slate-700">
                      <BookOpen class="size-5" />
                    </div>
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="line-clamp-2 text-xs font-medium text-slate-100">{a.title}</p>
                    {#if a.categories.length > 0}
                      <p class="mt-0.5 line-clamp-1 text-[10px] text-slate-500">
                        {a.categories.map((c) => c.name).join(' · ')}
                      </p>
                    {/if}
                  </div>
                </button>
                <button
                  type="button"
                  class="absolute right-1 top-1 rounded p-1 text-slate-500 transition hover:bg-slate-950 hover:text-amber-300 {isFav ? 'text-amber-400' : ''}"
                  onclick={(e) => { e.stopPropagation(); favorites.toggle(a.id); }}
                  title={isFav ? 'Remove from favorites' : 'Add to favorites'}
                  aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                  aria-pressed={isFav}
                >
                  <Star class="size-3 {isFav ? 'fill-amber-400' : ''}" />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  {:else}

  <div class="flex border-b border-slate-800 bg-slate-950/20 px-3 text-xs">
    <button
      type="button"
      onclick={() => switchTab('home')}
      class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'home'
        ? 'text-sky-300'
        : 'text-slate-400 hover:text-slate-200'}"
    >
      <HomeIcon class="size-3" />
      Home
      {#if tab === 'home'}<span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>{/if}
    </button>
    <button
      type="button"
      onclick={() => switchTab('articles')}
      class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'articles'
        ? 'text-sky-300'
        : 'text-slate-400 hover:text-slate-200'}"
    >
      <BookOpen class="size-3" />
      Articles
      {#if tab === 'articles'}<span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>{/if}
    </button>
    <button
      type="button"
      onclick={() => switchTab('categories')}
      class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'categories'
        ? 'text-sky-300'
        : 'text-slate-400 hover:text-slate-200'}"
    >
      <Hash class="size-3" />
      Categories
      {#if tab === 'categories'}<span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>{/if}
    </button>
    <button
      type="button"
      onclick={() => switchTab('tags')}
      class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'tags'
        ? 'text-sky-300'
        : 'text-slate-400 hover:text-slate-200'}"
    >
      <TagsIcon class="size-3" />
      Tags
      {#if tab === 'tags'}<span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>{/if}
    </button>
    <button
      type="button"
      onclick={() => switchTab('index')}
      class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'index'
        ? 'text-sky-300'
        : 'text-slate-400 hover:text-slate-200'}"
    >
      <List class="size-3" />
      Index
      {#if tab === 'index'}<span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>{/if}
    </button>
  </div>

  <div class="flex-1 overflow-y-auto p-3">
    {#if tab === 'home'}
      <!-- Galactapedia Home — mirrors the /galactapedia landing page:
           one big featured article, a secondary "in the news" card, four
           featured categories with thumbnails, and a Random button in the
           module header. Everything clickable opens in the inline reader. -->
      {#if homeError}
        <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Failed to load home</p>
            <p class="mt-1 break-all text-rose-300/80">{homeError}</p>
          </div>
        </div>
      {:else if homeLoading && !home}
        <div class="flex h-full items-center justify-center text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if home}
        <div class="mx-auto flex max-w-6xl flex-col gap-4">
          <!-- Featured + In the news always side-by-side in both popup
               and tab modes. Cards share the same vertical layout so
               they read as twins rather than one being a hero and one
               a secondary. -->
          <div class="grid grid-cols-2 gap-3">
            {#if home.featuredArticle}
              {@const fa = home.featuredArticle}
              <button
                type="button"
                onclick={() => openArticle(fa.id)}
                class="group flex flex-col overflow-hidden rounded-lg bg-slate-900/70 text-left ring-1 ring-slate-800 transition hover:ring-sky-600"
              >
                <div class="relative aspect-[16/9] overflow-hidden bg-slate-950">
                  {#if fa.thumbnailUrl}
                    <img
                      src={fa.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      class="size-full object-cover transition group-hover:scale-105"
                    />
                  {:else}
                    <div class="flex size-full items-center justify-center text-slate-700">
                      <BookOpen class="size-12" />
                    </div>
                  {/if}
                  <span class="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-sky-500/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-50">
                    <Sparkles class="size-2.5" /> Featured
                  </span>
                </div>
                <div class="flex flex-1 flex-col gap-1.5 p-3">
                  <h2 class="text-sm font-semibold text-slate-100">{fa.title}</h2>
                  {#if fa.categories.length > 0}
                    <p class="text-[10px] uppercase tracking-wider text-sky-400">
                      {fa.categories.map((c) => c.name).join(' · ')}
                    </p>
                  {/if}
                  <p class="line-clamp-4 text-[11px] leading-relaxed text-slate-400">
                    {homeExcerpt(fa.body, 280)}
                  </p>
                </div>
              </button>
            {/if}
            {#if home.inTheNewsArticle}
              {@const ina = home.inTheNewsArticle}
              <button
                type="button"
                onclick={() => openArticle(ina.id)}
                class="group flex flex-col overflow-hidden rounded-lg bg-slate-900/70 text-left ring-1 ring-slate-800 transition hover:ring-amber-600"
              >
                <div class="relative aspect-[16/9] overflow-hidden bg-slate-950">
                  {#if ina.thumbnailUrl}
                    <img
                      src={ina.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      class="size-full object-cover transition group-hover:scale-105"
                    />
                  {:else}
                    <div class="flex size-full items-center justify-center text-slate-700">
                      <Newspaper class="size-10" />
                    </div>
                  {/if}
                  <span class="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-50">
                    <Newspaper class="size-2.5" /> In the news
                  </span>
                </div>
                <div class="flex flex-1 flex-col gap-1.5 p-3">
                  <h3 class="text-sm font-semibold text-slate-100">{ina.title}</h3>
                  {#if ina.categories.length > 0}
                    <p class="text-[10px] uppercase tracking-wider text-amber-400">
                      {ina.categories.map((c) => c.name).join(' · ')}
                    </p>
                  {/if}
                  <p class="line-clamp-4 text-[11px] leading-relaxed text-slate-400">
                    {homeExcerpt(ina.body, 280)}
                  </p>
                </div>
              </button>
            {/if}
          </div>

          <!-- Featured categories — full-width 4-up grid on its own row so
               both the category images and their labels breathe. Stacks
               to 2 columns on narrow screens. -->
          {#if home.featuredCategories.length > 0}
            <section class="flex flex-col gap-2">
              <p class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Featured categories
              </p>
              <ul class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {#each home.featuredCategories as c (c.slug)}
                  <li>
                    <button
                      type="button"
                      onclick={() => openCategory(c.slug, c.name)}
                      class="group flex w-full flex-col overflow-hidden rounded-md bg-slate-900/70 text-left ring-1 ring-slate-800 transition hover:ring-sky-600"
                    >
                      <div class="aspect-[4/3] overflow-hidden bg-slate-950">
                        {#if c.thumbnailUrl}
                          <img
                            src={c.thumbnailUrl}
                            alt=""
                            loading="lazy"
                            class="size-full object-cover transition group-hover:scale-105"
                          />
                        {:else}
                          <div class="flex size-full items-center justify-center text-slate-700">
                            <Hash class="size-8" />
                          </div>
                        {/if}
                      </div>
                      <div class="flex items-center gap-1 p-1.5">
                        <Hash class="size-3 shrink-0 text-sky-400" />
                        <span class="truncate text-xs text-slate-200">{c.name}</span>
                      </div>
                    </button>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}

          <!-- Random prompt at the bottom too, big clickable card -->
          <button
            type="button"
            onclick={pickRandom}
            disabled={randomLoading}
            class="group flex items-center gap-3 rounded-lg border border-dashed border-slate-700 bg-slate-900/30 px-4 py-3 text-left transition hover:border-sky-600 hover:bg-slate-900/60 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40 transition group-hover:bg-sky-500/30">
              {#if randomLoading}
                <Loader2 class="size-5 animate-spin" />
              {:else}
                <Shuffle class="size-5" />
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-slate-100">Discover a random article</p>
              <p class="text-[11px] text-slate-400">
                Pick one of {home.articleCount} Galactapedia entries at random.
              </p>
            </div>
          </button>
        </div>
      {/if}

    {:else if tab === 'articles'}
      {#if error}
        <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Failed to load Galactapedia</p>
            <p class="mt-1 break-all text-rose-300/80">{error}</p>
          </div>
        </div>
      {:else if loading && articles.length === 0}
        <div class="flex h-full items-center justify-center text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if articles.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
          <BookOpen class="size-8" />
          <p class="text-xs italic">
            {#if activeSearch}No articles match "{activeSearch}".{:else}No articles loaded.{/if}
          </p>
        </div>
      {:else}
        {@const sortedArticles = articles
          .slice()
          .sort((a, b) => (favorites.has(a.id) ? 0 : 1) - (favorites.has(b.id) ? 0 : 1))}
        <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 4xl:grid-cols-5">
          {#each sortedArticles as a (a.id)}
            {@const isFav = favorites.has(a.id)}
            <li class="virt-item relative">
              <button
                type="button"
                onclick={() => openArticle(a.id)}
                class="group flex w-full items-center gap-2 rounded-md bg-slate-900/70 p-2 text-left ring-1 ring-slate-800 transition hover:ring-sky-600
                  {isFav ? 'ring-amber-500/60' : ''}"
              >
                {#if a.thumbnailUrl}
                  <div class="size-12 shrink-0 overflow-hidden rounded bg-slate-950">
                    <img
                      src={a.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      class="size-full object-cover transition group-hover:scale-105"
                    />
                  </div>
                {:else}
                  <div class="flex size-12 shrink-0 items-center justify-center rounded bg-slate-950 text-slate-700">
                    <BookOpen class="size-5" />
                  </div>
                {/if}
                <div class="min-w-0 flex-1">
                  <p class="line-clamp-2 text-xs font-medium text-slate-100">{a.title}</p>
                  {#if a.categories.length > 0}
                    <p class="mt-0.5 line-clamp-1 text-[10px] text-slate-500">
                      {a.categories.map((c) => c.name).join(' · ')}
                    </p>
                  {/if}
                </div>
              </button>
              <button
                type="button"
                class="absolute right-1 top-1 rounded p-1 text-slate-500 transition hover:bg-slate-950 hover:text-amber-300 {isFav
                  ? 'text-amber-400'
                  : ''}"
                onclick={(e) => {
                  e.stopPropagation();
                  favorites.toggle(a.id);
                }}
                title={isFav ? 'Remove from favorites' : 'Add to favorites'}
                aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                aria-pressed={isFav}
              >
                <Star class="size-3 {isFav ? 'fill-amber-400' : ''}" />
              </button>
            </li>
          {/each}
        </ul>

        <div
          bind:this={sentinel}
          class="mt-4 flex h-10 items-center justify-center text-xs text-slate-500"
        >
          {#if loadingMore}
            <Loader2 class="size-4 animate-spin" />
          {:else if !hasMore}
            <span class="italic">End of {activeSearch ? 'results' : 'catalog'}.</span>
          {/if}
        </div>
      {/if}

    {:else if tab === 'categories'}
      {#if categoriesError}
        <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Failed to load categories</p>
            <p class="mt-1 break-all text-rose-300/80">{categoriesError}</p>
          </div>
        </div>
      {:else if categoriesLoading && categories.length === 0}
        <div class="flex h-full items-center justify-center text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if categories.length === 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">No categories.</p>
      {:else if filteredCategories.length === 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">
          No categories match "{categoryQuery.trim()}".
        </p>
      {:else}
        <ul class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 4xl:grid-cols-8">
          {#each filteredCategories as c (c.slug)}
            {@const count = categoryCounts.get(c.slug) ?? 0}
            <li>
              <button
                type="button"
                onclick={() => openCategory(c.slug, c.name)}
                class="group flex w-full flex-col overflow-hidden rounded-md bg-slate-900/70 text-left ring-1 ring-slate-800 transition hover:ring-sky-600"
              >
                <div class="relative aspect-[4/3] overflow-hidden bg-slate-950">
                  {#if c.thumbnailUrl}
                    <img
                      src={c.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      class="size-full object-cover transition group-hover:scale-105"
                    />
                  {:else}
                    <div class="flex size-full items-center justify-center text-slate-700">
                      <Hash class="size-8" />
                    </div>
                  {/if}
                  {#if hasCounts && count > 0}
                    <span class="absolute right-1 top-1 rounded bg-slate-950/80 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-300 ring-1 ring-slate-700/70">
                      {count}
                    </span>
                  {/if}
                </div>
                <div class="flex items-center gap-1 p-1.5">
                  <Hash class="size-3 shrink-0 text-sky-400" />
                  <span class="truncate text-xs text-slate-200">{c.name}</span>
                </div>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

    {:else if tab === 'tags'}
      {#if tagsError}
        <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Failed to load tags</p>
            <p class="mt-1 break-all text-rose-300/80">{tagsError}</p>
          </div>
        </div>
      {:else if tagsLoading && tags.length === 0}
        <div class="flex h-full items-center justify-center text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if tags.length === 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">No tags.</p>
      {:else if filteredTags.length === 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">
          No tags match "{tagQuery.trim()}".
        </p>
      {:else}
        <ul class="flex flex-wrap gap-1.5">
          {#each filteredTags as t (t.slug)}
            {@const count = tagCounts.get(t.slug) ?? 0}
            <li>
              <button
                type="button"
                onclick={() => openTag(t.slug, t.name)}
                class="inline-flex items-center gap-1 rounded-full bg-slate-900/70 px-2 py-0.5 text-[11px] text-slate-300 ring-1 ring-slate-800 transition hover:bg-sky-500/10 hover:text-sky-300 hover:ring-sky-600"
              >
                <TagsIcon class="size-2.5" />
                {t.name}
                {#if hasCounts && count > 0}
                  <span class="text-slate-500">({count})</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}

    {:else if tab === 'index'}
      {#if indexError}
        <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Failed to load index</p>
            <p class="mt-1 break-all text-rose-300/80">{indexError}</p>
          </div>
        </div>
      {:else if indexLoading && indexArticles.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
          <Loader2 class="size-5 animate-spin" />
          <p class="text-[11px] italic">
            Crawling the full catalog (first time only — cached for a few days).
          </p>
          <p class="text-[10px] text-slate-400">Results will appear as each page arrives.</p>
        </div>
      {:else if indexArticles.length === 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">Index is empty.</p>
      {:else if indexMatchCount === 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">
          No articles match "{indexQuery.trim()}".
        </p>
      {:else}
        <div class="mb-3 flex flex-wrap gap-1">
          {#each indexGroups as g (g.letter)}
            <a
              href="#galactapedia-letter-{g.letter}"
              class="inline-flex size-6 items-center justify-center rounded bg-slate-900/70 text-[11px] font-semibold text-slate-300 ring-1 ring-slate-800 transition hover:bg-sky-500/10 hover:text-sky-300 hover:ring-sky-600"
            >
              {g.letter}
            </a>
          {/each}
        </div>
        {#each indexGroups as g (g.letter)}
          <div id="galactapedia-letter-{g.letter}" class="virt-item-lg mt-3 scroll-mt-3">
            <div class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-sky-400">
              {g.letter}
            </div>
            <ul class="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 4xl:grid-cols-6">
              {#each g.items as a (a.id)}
                <li>
                  <button
                    type="button"
                    onclick={() => openArticle(a.id)}
                    class="block w-full truncate rounded bg-slate-900/50 px-2 py-1 text-left text-[11px] text-slate-300 ring-1 ring-inset ring-slate-800/60 transition hover:ring-sky-600"
                  >
                    {a.title}
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      {/if}
    {/if}
  </div>
  {/if}
</section>
