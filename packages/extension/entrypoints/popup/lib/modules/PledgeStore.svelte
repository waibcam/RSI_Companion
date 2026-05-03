<script lang="ts">
  import { sendRsiMessage, RSI_BASE_URL, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    ArrowRight,
    ExternalLink,
    Filter,
    Gift,
    HandCoins,
    Loader2,
    Package,
    Palette,
    Rocket,
    RefreshCw,
    ShoppingCart,
    Star,
    Store as StoreIcon,
    Ship as ShipIcon,
    TicketCheck,
    Trash2,
    TriangleAlert,
    Warehouse,
    Wrench,
    X,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import ShipReader from '../components/ShipReader.svelte';
  import StoreItemReader from '../components/StoreItemReader.svelte';
  import { authState } from '../state.svelte';
  import { persistedState } from '../persist.svelte';
  import { errorMessage } from '../error';

  type PledgeShip = Rsi.PledgeShip;
  type StoreItem = Rsi.StoreItem;
  type StoreCategoryId = Rsi.StoreCategoryId;
  type CcuCatalogue = Rsi.CcuCatalogue;
  type CcuShip = CcuCatalogue['ships'][number];
  type Tab = 'store' | 'upgrade' | 'cart' | 'shortcuts';
  type PledgeCart = Rsi.PledgeCart;

  // The pledge store has 10 user-visible categories. Rather than turn them
  // into top-level tabs (cramped + cognitive overload), we expose three
  // tabs — Store / Upgrades / Shortcuts — and let the Store tab render a
  // horizontal pills strip for category selection. Ships keeps its
  // dedicated `pledge.shipList` query (richer fields: manufacturer,
  // production status, crew); everything else flows through one unified
  // `pledge.browse` call. The same card component renders both via a
  // simple shape adapter.

  const TABS: readonly Tab[] = ['store', 'upgrade', 'cart', 'shortcuts'];
  const isTab = (v: unknown): v is Tab =>
    typeof v === 'string' && (TABS as readonly string[]).includes(v);
  // Old 'ships'/'browse'/'packages'/'paints'/'merch' values fall back to
  // 'store' via validator rejection — same content, just reorganized.
  const tabP = persistedState<Tab>('pledge:tab', 'store', isTab);
  const tab = $derived(tabP.value);

  // Category catalogue (10 entries). Ships is id 'ships' and handled on
  // its own data path; everything else hits the generic browse.
  const CATEGORIES: readonly Rsi.StoreCategoryConfig[] = [
    { id: 'ships' as const, label: 'Ships', path: '/pledge/ships' },
    { id: 'ship-packs' as const, label: 'Ship Packs', path: '/store/pledge/browse/ship-packs' },
    { id: 'game-packages' as const, label: 'Game Packages', path: '/store/pledge/browse/game-packages' },
    { id: 'paints' as const, label: 'Paints', path: '/store/pledge/browse/paints' },
    { id: 'gear' as const, label: 'Gear', path: '/store/pledge/browse/gear' },
    { id: 'merchandise' as const, label: 'Merchandise', path: '/store/pledge/browse/merchandise' },
    { id: 'add-ons' as const, label: 'Add-Ons', path: '/store/pledge/browse/add-ons' },
    { id: 'event-tickets' as const, label: 'Event Tickets', path: '/store/pledge/browse/event-tickets' },
    { id: 'gift-cards' as const, label: 'Gift Cards', path: '/store/pledge/browse/gift-cards' },
    { id: 'uec' as const, label: 'UEC', path: '/store/pledge/browse/uec' },
  ];

  const CATEGORY_ICONS: Record<StoreCategoryId, typeof Rocket> = {
    ships: Rocket,
    'ship-packs': Package,
    'game-packages': Gift,
    paints: Palette,
    gear: Wrench,
    merchandise: ShoppingCart,
    'add-ons': Star,
    'event-tickets': TicketCheck,
    'gift-cards': HandCoins,
    uec: HandCoins,
  };

  const categoryP = persistedState<StoreCategoryId>(
    'pledge:category',
    'ships',
    (v): v is StoreCategoryId =>
      typeof v === 'string' && CATEGORIES.some((c) => c.id === v),
  );
  const category = $derived(categoryP.value);

  // ---- Ships (rich) --------------------------------------------------------
  let ships = $state<PledgeShip[]>([]);
  let manufacturers = $state<Rsi.PledgeManufacturer[]>([]);
  let shipsTotal = $state(0);
  let shipsLoading = $state(false);
  let shipsError = $state<string | null>(null);
  let shipsFromCache = $state(false);
  // Defaults to true (matches today's behaviour) — RSI rotates ships in
  // and out of "on sale" status throughout the year, so the active set
  // is typically a small subset (e.g. 30) of the full catalogue. The
  // user can flip this off to browse the full catalogue including
  // currently-locked ships. Persisted so the choice sticks across
  // popup opens.
  const shipsOnSaleOnlyP = persistedState<boolean>(
    'pledge:shipsOnSaleOnly',
    true,
    (v): v is boolean => typeof v === 'boolean',
  );

  // ---- Generic browse (all other categories) -------------------------------
  // Keyed by categoryId — we keep the last result for each so switching
  // between categories doesn't flash a spinner if we've seen them before.
  const browseCache = $state<Record<string, StoreItem[]>>({});
  let browseTotals = $state<Record<string, number>>({});
  let browseFilterGroups = $state<Record<string, Rsi.StoreFilterGroup[]>>({});
  let browseLoading = $state(false);
  let browseError = $state<string | null>(null);
  let browseFromCache = $state(false);

  // Active sub-filter tag per category (chip selection). Persisted so
  // "show me armor in Gear" survives popup reopens. Empty string = no
  // sub-filter.
  const subTagP = persistedState<Record<string, string>>(
    'pledge:subTag',
    {},
    (v): v is Record<string, string> =>
      !!v && typeof v === 'object' && !Array.isArray(v),
  );
  const activeSubTag = $derived(subTagP.value[category] ?? '');

  // ---- Cart state ----------------------------------------------------------
  let cart = $state<PledgeCart | null>(null);
  let cartLoading = $state(false);
  let cartError = $state<string | null>(null);
  let cartFromCache = $state(false);

  async function loadCart(force = false) {
    cartLoading = true;
    cartError = null;
    try {
      const res = await sendRsiMessage({ type: 'pledge.cart', force });
      cart = res.cart;
      cartFromCache = res.fromCache;
    } catch (e) {
      cartError = errorMessage(e);
    } finally {
      cartLoading = false;
    }
  }

  function formatNativeCurrency(amount: number, c: PledgeCart | null): string {
    // RSI sends prices as minor-currency units (e.g. cents) with an
    // `exponent` for the decimal shift. Use Intl.NumberFormat so
    // symbol placement and grouping match the user's locale — 5,16 €
    // for fr-FR, $5.16 for en-US, ¥516 for ja-JP.
    if (!c) return '—';
    const value = amount / Math.pow(10, c.exponent);
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: c.currencyCode,
      }).format(value);
    } catch {
      return `${value.toFixed(c.exponent)} ${c.currencySymbol}`;
    }
  }

  // ---- CCU state -----------------------------------------------------------
  let ccu = $state<CcuCatalogue | null>(null);
  let ccuLoading = $state(false);
  let ccuError = $state<string | null>(null);
  let targetsLoading = $state(false);
  let targetsError = $state<string | null>(null);
  let targets = $state<Rsi.CcuTargetsResult | null>(null);
  let targetsForFromId = $state<number | null>(null);

  // ---- Filters (persisted) -------------------------------------------------
  let query = $state('');
  const makeP = persistedState<string>('pledge:browse:manufacturer', '');
  const typeP = persistedState<string>('pledge:browse:type', '');

  // Sort options mirror what RSI exposes on each section — per-category
  // default since "weight" (server-side curator ranking) is what the
  // Ships page shows by default but our Ships fetcher sends `name:asc`.
  type SortId = 'name' | 'name-desc' | 'price-asc' | 'price-desc';
  const sortP = persistedState<SortId>(
    'pledge:browse:sort',
    'name',
    (v): v is SortId =>
      v === 'name' || v === 'name-desc' || v === 'price-asc' || v === 'price-desc',
  );

  // Multi-select filter groups, per category. The structure is uniform so
  // a single helper can check any filter set — the UI only renders the
  // groups that make sense for the active category (Ships gets all five;
  // other categories get just Availability + Price Range).
  //
  // Each array holds the SELECTED option identifiers. Empty array = no
  // filter in that dimension.
  interface CategoryFilters {
    availability: string[]; // 'available' | 'unavailable'
    priceRange: string[];   // 'lt75' | '75-150' | '150-300' | '300-500' | 'gt500'
    status: string[];       // 'flight-ready' | 'in-concept' (ships only)
    crew: string[];         // '1' | '1-3' | '4-8' | 'gt8' (ships only)
    size: string[];         // 'small' | 'medium' | 'large' | 'capital' (ships only)
  }
  const EMPTY_FILTERS: CategoryFilters = {
    availability: [],
    priceRange: [],
    status: [],
    crew: [],
    size: [],
  };
  const filtersP = persistedState<Record<string, CategoryFilters>>(
    'pledge:filters',
    {},
    (v): v is Record<string, CategoryFilters> =>
      !!v && typeof v === 'object' && !Array.isArray(v),
  );
  const activeFilters = $derived(filtersP.value[category] ?? EMPTY_FILTERS);

  function toggleFilter(group: keyof CategoryFilters, id: string): void {
    const cur = filtersP.value[category] ?? EMPTY_FILTERS;
    const list = cur[group];
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    filtersP.value = {
      ...filtersP.value,
      [category]: { ...cur, [group]: next },
    };
  }
  function isFilterActive(group: keyof CategoryFilters, id: string): boolean {
    return (filtersP.value[category]?.[group] ?? []).includes(id);
  }
  function clearCategoryFilters(): void {
    filtersP.value = { ...filtersP.value, [category]: { ...EMPTY_FILTERS } };
  }

  // Server-driven filter ranges (same as RSI's own panel). These map to
  // the `msrp` cents ranges returned by shipFiltersOptions in the Ships
  // query, but since the scale is universal we reuse the same buckets
  // for generic browse categories too.
  const PRICE_RANGES = [
    { id: 'lt75', label: 'Less than $75', min: 0, max: 7500 },
    { id: '75-150', label: '$75 to $150', min: 7500, max: 15000 },
    { id: '150-300', label: '$150 to $300', min: 15000, max: 30000 },
    { id: '300-500', label: '$300 to $500', min: 30000, max: 50000 },
    { id: 'gt500', label: 'Over $500', min: 50000, max: Infinity },
  ] as const;
  const CREW_RANGES = [
    { id: '1', label: '1', min: 0, max: 1 },
    { id: '1-3', label: '1 to 3', min: 1, max: 3 },
    { id: '4-8', label: '4 to 8', min: 4, max: 8 },
    { id: 'gt8', label: 'Over 8', min: 8, max: Infinity },
  ] as const;
  const SHIP_SIZES = ['small', 'medium', 'large', 'capital'] as const;

  function priceMatches(cents: number): boolean {
    if (activeFilters.priceRange.length === 0) return true;
    return activeFilters.priceRange.some((id) => {
      const r = PRICE_RANGES.find((x) => x.id === id);
      if (!r) return false;
      return cents >= r.min && cents < r.max;
    });
  }
  function crewMatches(ship: PledgeShip): boolean {
    if (activeFilters.crew.length === 0) return true;
    // Match against maxCrew — that's what RSI's panel uses.
    const c = ship.maxCrew ?? ship.minCrew ?? 0;
    return activeFilters.crew.some((id) => {
      const r = CREW_RANGES.find((x) => x.id === id);
      if (!r) return false;
      // 8+ bucket is inclusive upper
      if (r.max === Infinity) return c >= r.min;
      return c >= r.min && c <= r.max;
    });
  }

  // Collapse the filter panel by default; user toggles it with a button.
  let filtersOpen = $state(false);
  const hasAnyFilter = $derived.by<boolean>(() => {
    const f = activeFilters;
    return (
      f.availability.length > 0 ||
      f.priceRange.length > 0 ||
      f.status.length > 0 ||
      f.crew.length > 0 ||
      f.size.length > 0
    );
  });

  const fromIdP = persistedState<number | null>(
    'pledge:ccu:fromId',
    null,
    (v): v is number | null => v === null || typeof v === 'number',
  );
  const ccuFiltersP = persistedState<{ onlyOwned: boolean; maxPrice: number }>(
    'pledge:ccu:filters',
    { onlyOwned: true, maxPrice: 0 },
    (v): v is { onlyOwned: boolean; maxPrice: number } =>
      !!v &&
      typeof v === 'object' &&
      typeof (v as { onlyOwned?: unknown }).onlyOwned === 'boolean' &&
      typeof (v as { maxPrice?: unknown }).maxPrice === 'number',
  );

  // ---- Loaders ------------------------------------------------------------
  async function loadShips(force = false) {
    shipsLoading = true;
    shipsError = null;
    try {
      const res = await sendRsiMessage({
        type: 'pledge.shipList',
        onlyOnSale: shipsOnSaleOnlyP.value,
        force,
      });
      ships = res.ships;
      manufacturers = res.manufacturers;
      shipsTotal = res.totalCount;
      shipsFromCache = res.fromCache;
    } catch (e) {
      shipsError = errorMessage(e);
    } finally {
      shipsLoading = false;
    }
  }
  function toggleShipsOnSale() {
    shipsOnSaleOnlyP.value = !shipsOnSaleOnlyP.value;
    // Cache key on the BG includes onlyOnSale so the two views are
    // memoized independently — flipping the toggle hits cache on
    // either side after the first round trip.
    void loadShips(false);
  }

  async function loadBrowse(
    cat: StoreCategoryId,
    opts: { tagIdentifiers?: string[]; force?: boolean } = {},
  ) {
    browseLoading = true;
    browseError = null;
    try {
      const res = await sendRsiMessage({
        type: 'pledge.browse',
        categoryId: cat,
        tagIdentifiers: opts.tagIdentifiers,
        force: opts.force,
      });
      browseCache[cat] = res.result.items;
      browseTotals = { ...browseTotals, [cat]: res.result.totalCount };
      browseFilterGroups = {
        ...browseFilterGroups,
        [cat]: res.result.filterGroups,
      };
      browseFromCache = res.fromCache;
    } catch (e) {
      browseError = errorMessage(e);
    } finally {
      browseLoading = false;
    }
  }

  async function loadCategory(cat: StoreCategoryId, force = false) {
    if (cat === 'ships') await loadShips(force);
    else {
      const tag = subTagP.value[cat] ?? '';
      await loadBrowse(cat, {
        tagIdentifiers: tag ? [tag] : undefined,
        force,
      });
    }
  }

  async function loadCcu(force = false) {
    ccuLoading = true;
    ccuError = null;
    try {
      const res = await sendRsiMessage({ type: 'pledge.ccuInit', force });
      ccu = res.catalogue;
    } catch (e) {
      ccuError = errorMessage(e);
    } finally {
      ccuLoading = false;
    }
  }

  // Monotonic request counter — when the user changes the source ship
  // rapidly, drop responses that are no longer for the latest selection.
  // Without this the CCU target list would flicker between stale and
  // current prices depending on network timing.
  let targetsRequestSeq = 0;
  async function loadTargets(fromId: number | null, force = false) {
    const requestId = ++targetsRequestSeq;
    targetsLoading = true;
    targetsError = null;
    try {
      const res = await sendRsiMessage({ type: 'pledge.ccuTargets', fromId, force });
      if (requestId !== targetsRequestSeq) return;
      targets = res.result;
      targetsForFromId = fromId;
    } catch (e) {
      if (requestId !== targetsRequestSeq) return;
      targetsError = errorMessage(e);
    } finally {
      if (requestId === targetsRequestSeq) targetsLoading = false;
    }
  }

  function refreshCurrentTab() {
    if (tab === 'store') void loadCategory(category, true);
    else if (tab === 'upgrade') {
      void loadCcu(true);
      if (fromIdP.value !== null) void loadTargets(fromIdP.value, true);
    } else if (tab === 'cart') {
      void loadCart(true);
    }
  }

  // --- Add-to-cart state ---------------------------------------------------
  // The Upgrade tab surfaces an "Add to Cart" button per target ship, mirroring
  // the real pledge-store UI. Clicking it runs the two-step addToCart +
  // cart/token dance in the background; we track the in-flight target sku
  // to disable double-clicks and surface a short success/error flash per row.
  //
  // Keyed by the target SKU id (unique per CCU route — one sku per target in
  // this catalogue). The flash auto-clears after 4s so the banner doesn't
  // linger if the user moves on.
  let addingToCartSkuId = $state<number | null>(null);
  let cartFlash = $state<{ skuId: number; type: 'success' | 'error'; text: string } | null>(null);
  let cartFlashTimer: ReturnType<typeof setTimeout> | null = null;

  function setCartFlash(skuId: number, type: 'success' | 'error', text: string): void {
    cartFlash = { skuId, type, text };
    if (cartFlashTimer) clearTimeout(cartFlashTimer);
    cartFlashTimer = setTimeout(() => {
      if (cartFlash?.skuId === skuId) cartFlash = null;
    }, 4000);
  }

  // Cancel any pending cart-flash auto-dismiss when the module unmounts.
  // Otherwise the 4s timer fires after the component is gone and writes
  // to detached reactive state.
  $effect(() => () => {
    if (cartFlashTimer) clearTimeout(cartFlashTimer);
  });

  // Generic add-to-cart for non-CCU items. Kept separate from the CCU
  // flow because: (a) the sku-id shape differs (string here, number in
  // CCU), (b) the UI surfaces are different (browse grid cards + ShipReader
  // SKU rows vs a single Upgrades list), and (c) conflating them would
  // require a union type that reads worse than two focused blocks.
  let addingStoreSkuId = $state<string | null>(null);
  let storeCartFlash = $state<{ skuId: string; type: 'success' | 'error'; text: string } | null>(null);
  let storeCartFlashTimer: ReturnType<typeof setTimeout> | null = null;

  function setStoreCartFlash(skuId: string, type: 'success' | 'error', text: string): void {
    storeCartFlash = { skuId, type, text };
    if (storeCartFlashTimer) clearTimeout(storeCartFlashTimer);
    storeCartFlashTimer = setTimeout(() => {
      if (storeCartFlash?.skuId === skuId) storeCartFlash = null;
    }, 4000);
  }

  $effect(() => () => {
    if (storeCartFlashTimer) clearTimeout(storeCartFlashTimer);
  });

  // Remove / clear cart. Separate in-flight state so the row spinners
  // don't conflict with the add-to-cart ones.
  let removingLineItemId = $state<string | null>(null);
  let clearingCart = $state(false);

  async function removeLineItem(lineItemId: string, skuId: string, identifier: string): Promise<void> {
    if (removingLineItemId !== null) return;
    removingLineItemId = lineItemId;
    try {
      await sendRsiMessage({ type: 'pledge.removeFromCart', skuId, identifier });
      await loadCart(true);
    } catch (e) {
      cartError = errorMessage(e);
    } finally {
      removingLineItemId = null;
    }
  }

  async function clearCartAll(): Promise<void> {
    if (clearingCart) return;
    // Destructive action — confirm before firing. `window.confirm` is fine
    // in popup context; it's modal and doesn't block the background.
    if (!window.confirm('Remove ALL items from your RSI cart? This cannot be undone.')) return;
    clearingCart = true;
    try {
      await sendRsiMessage({ type: 'pledge.clearCart' });
      await loadCart(true);
    } catch (e) {
      cartError = errorMessage(e);
    } finally {
      clearingCart = false;
    }
  }

  async function addStoreItemToCart(skuId: string, itemName: string, qty = 1): Promise<void> {
    if (addingStoreSkuId !== null) return;
    addingStoreSkuId = skuId;
    try {
      await sendRsiMessage({ type: 'pledge.addToCart', skuId, qty });
      setStoreCartFlash(skuId, 'success', `${itemName} added to cart`);
      // Same pattern as CCU: re-fetch cart so the Cart tab badge + contents
      // update without a manual refresh. Background already invalidated
      // the cache.
      void loadCart(true);
    } catch (e) {
      setStoreCartFlash(skuId, 'error', errorMessage(e));
    } finally {
      addingStoreSkuId = null;
    }
  }

  async function addTargetToCart(fromShipId: number, toSkuId: number, toShipName: string): Promise<void> {
    if (addingToCartSkuId !== null) return;
    addingToCartSkuId = toSkuId;
    try {
      await sendRsiMessage({ type: 'pledge.ccuAddToCart', fromShipId, toSkuId });
      setCartFlash(toSkuId, 'success', `${toShipName} added to cart`);
      // Re-fetch the cart — the background dropped its cache entry when
      // the add-to-cart handler finished, so this call hits fresh. Keeps
      // the Cart tab's badge + contents in sync without the user having
      // to click Refresh.
      void loadCart(true);
    } catch (e) {
      setCartFlash(toSkuId, 'error', errorMessage(e));
    } finally {
      addingToCartSkuId = null;
    }
  }

  const CART_URL = `${RSI_BASE_URL}/pledge/cart`;

  // Inline ship reader — shared with Ships module via the ShipReader
  // component. Two entry points in this module: the Store/Ships grid
  // (where we already have the DatoCMS slug via PledgeShip.slug) and the
  // CCU Upgrade target list (which only has a name — the background
  // handler does the slug lookup against the cached pledge ship list).
  // The reader takes over the whole module content area until onBack
  // clears the state.
  type ReaderTarget =
    | { kind: 'pledge'; ship: PledgeShip }
    | { kind: 'ccu'; ship: CcuShip }
    | { kind: 'item'; item: StoreItem; categoryLabel: string; categoryId: StoreCategoryId };
  let shipReader = $state<ReaderTarget | null>(null);
  // When true the ShipReader auto-scrolls to the Editions section on
  // first detail-load. Set by card-level "Add to cart" shortcuts on
  // ship grids so the user lands directly on the SKU picker.
  let shipReaderFocusEditions = $state(false);
  function openPledgeShipReader(ship: PledgeShip, opts: { focusEditions?: boolean } = {}): void {
    shipReader = { kind: 'pledge', ship };
    shipReaderFocusEditions = opts.focusEditions ?? false;
  }
  function openCcuShipReader(ship: CcuShip): void {
    shipReader = { kind: 'ccu', ship };
    shipReaderFocusEditions = false;
  }
  function openStoreItemReader(item: StoreItem): void {
    const cat = CATEGORIES.find((c) => c.id === category);
    shipReader = {
      kind: 'item',
      item,
      categoryLabel: cat?.label ?? 'Item',
      categoryId: category,
    };
    shipReaderFocusEditions = false;
  }
  function closeShipReader(): void {
    shipReader = null;
    shipReaderFocusEditions = false;
  }

  // Header indicators
  const currentLoading = $derived.by(() => {
    if (tab === 'store') return category === 'ships' ? shipsLoading : browseLoading;
    if (tab === 'upgrade') return ccuLoading || targetsLoading;
    if (tab === 'cart') return cartLoading;
    return false;
  });
  const currentFromCache = $derived.by(() => {
    if (tab === 'store' && category === 'ships') return shipsFromCache;
    if (tab === 'store') return browseFromCache;
    if (tab === 'cart') return cartFromCache;
    return false;
  });

  // Category-switch effect: fire the load for the active category when
  // the user clicks a pill OR changes the sub-tag filter. The background
  // caches by (category, tag) so re-selecting a previously-loaded chip
  // is instant.
  //
  // We key the last-loaded state by `category:tag` so a second click on
  // the same category (without a tag change) doesn't re-fire the fetch.
  let lastLoadedKey = $state<string>('');
  $effect(() => {
    if (tab !== 'store') return;
    if (category === 'ships') {
      if (ships.length === 0 && !shipsLoading && shipsError === null) void loadShips();
      return;
    }
    const key = `${category}:${activeSubTag}`;
    if (key === lastLoadedKey) return;
    if (browseLoading) return;
    lastLoadedKey = key;
    void loadBrowse(category, {
      tagIdentifiers: activeSubTag ? [activeSubTag] : undefined,
    });
  });

  function setSubTag(tagId: string): void {
    subTagP.value = { ...subTagP.value, [category]: tagId };
  }

  // ---- Browse derivations (Ships) ------------------------------------------
  const typeOptionsShips = $derived.by<string[]>(() => {
    const set = new Set<string>();
    for (const s of ships) if (s.type) set.add(s.type);
    return [...set].sort();
  });
  const ccuOwnedIds = $derived(
    new Set((ccu?.ships ?? []).filter((s) => s.owned).map((s) => s.id)),
  );

  const filteredShips = $derived.by<PledgeShip[]>(() => {
    const q = query.trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    const f = activeFilters;
    const rows = ships.filter((s) => {
      if (makeP.value && s.manufacturerName !== makeP.value) return false;
      if (typeP.value && s.type !== typeP.value) return false;
      // Availability maps to `purchasable`.
      if (f.availability.length > 0) {
        const allowAvail = f.availability.includes('available');
        const allowUnavail = f.availability.includes('unavailable');
        if (s.purchasable && !allowAvail) return false;
        if (!s.purchasable && !allowUnavail) return false;
      }
      if (!priceMatches(s.msrp)) return false;
      if (f.status.length > 0 && !f.status.includes(s.productionStatus)) return false;
      if (!crewMatches(s)) return false;
      if (f.size.length > 0 && !f.size.includes(s.size)) return false;
      if (terms.length === 0) return true;
      const hay = `${s.manufacturerName} ${s.name} ${s.focus} ${s.type}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    const sorted = rows.slice();
    if (sortP.value === 'price-asc') sorted.sort((a, b) => a.msrp - b.msrp);
    else if (sortP.value === 'price-desc') sorted.sort((a, b) => b.msrp - a.msrp);
    else if (sortP.value === 'name-desc') sorted.sort((a, b) => b.name.localeCompare(a.name));
    else sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  });

  // ---- Browse derivations (generic) ----------------------------------------
  const browseItems = $derived(browseCache[category] ?? []);
  const filteredBrowse = $derived.by<StoreItem[]>(() => {
    const q = query.trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    const f = activeFilters;
    const rows = browseItems.filter((i) => {
      // Availability maps to stock.available.
      if (f.availability.length > 0) {
        const allowAvail = f.availability.includes('available');
        const allowUnavail = f.availability.includes('unavailable');
        if (i.available && !allowAvail) return false;
        if (!i.available && !allowUnavail) return false;
      }
      // Price filter uses discounted price when present, else MSRP.
      const effectivePrice = i.discounted ?? i.msrp;
      if (!priceMatches(effectivePrice)) return false;
      if (terms.length === 0) return true;
      const hay = `${i.name} ${i.subtitle} ${i.tags.join(' ')}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    const sorted = rows.slice();
    if (sortP.value === 'price-asc') {
      sorted.sort((a, b) => (a.discounted ?? a.msrp) - (b.discounted ?? b.msrp));
    } else if (sortP.value === 'price-desc') {
      sorted.sort((a, b) => (b.discounted ?? b.msrp) - (a.discounted ?? a.msrp));
    } else if (sortP.value === 'name-desc') {
      sorted.sort((a, b) => b.name.localeCompare(a.name));
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  });

  const hasActiveBrowseFilter = $derived(
    hasAnyFilter ||
      (category === 'ships' && (makeP.value !== '' || typeP.value !== '')) ||
      query !== '' ||
      activeSubTag !== '' ||
      sortP.value !== 'name',
  );
  function clearBrowseFilters() {
    makeP.value = '';
    typeP.value = '';
    query = '';
    sortP.value = 'name';
    clearCategoryFilters();
    if (activeSubTag) setSubTag('');
  }

  function formatPrice(cents: number): string {
    if (cents <= 0) return '—';
    const dollars = cents / 100;
    return `$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function pledgeUrl(path: string): string {
    if (!path) return `${RSI_BASE_URL}/pledge`;
    return path.startsWith('http') ? path : `${RSI_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  // ---- CCU derivations -----------------------------------------------------
  const ccuShipsById = $derived(new Map((ccu?.ships ?? []).map((s) => [s.id, s])));
  const hasSku = (s: CcuShip): boolean => s.skus.length > 0;
  const ownedCcuShips = $derived(
    (ccu?.ships ?? []).filter((s) => s.owned && hasSku(s)),
  );
  const ccuFromGroups = $derived.by<{ name: string; ships: CcuShip[] }[]>(() => {
    const map = new Map<string, CcuShip[]>();
    const list = (ccu?.ships ?? []).filter(hasSku);
    for (const s of list) {
      const m = s.manufacturerName || 'Unknown';
      if (!map.has(m)) map.set(m, []);
      map.get(m)!.push(s);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return [...map.entries()].map(([name, ships]) => ({ name, ships })).sort((a, b) => a.name.localeCompare(b.name));
  });
  const fromShip = $derived(fromIdP.value !== null ? ccuShipsById.get(fromIdP.value) ?? null : null);

  $effect(() => {
    const id = fromIdP.value;
    if (id === null) { targets = null; targetsForFromId = null; return; }
    if (id === targetsForFromId && targets !== null) return;
    void loadTargets(id);
  });

  interface TargetRow {
    ship: CcuShip;
    minUpgradePrice: number | null;
    available: boolean;
    lowestSkuId: number | null;
  }
  const targetRows = $derived.by<TargetRow[]>(() => {
    if (!targets || !fromShip) return [];
    const out: TargetRow[] = [];
    for (const t of targets.targets) {
      const ship = ccuShipsById.get(t.shipId);
      if (!ship) continue;
      const priced = t.skus
        .filter((s): s is Rsi.CcuTargetSku & { upgradePrice: number } =>
          typeof s.upgradePrice === 'number',
        )
        .sort((a, b) => a.upgradePrice - b.upgradePrice);
      const cheapest = priced[0] ?? null;
      out.push({
        ship,
        minUpgradePrice: cheapest?.upgradePrice ?? null,
        available: t.skus.some((s) => s.available),
        lowestSkuId: cheapest?.id ?? null,
      });
    }
    return out;
  });

  let targetQuery = $state('');
  let targetType = $state('');
  const ccuTypeOptions = $derived.by<string[]>(() => {
    const set = new Set<string>();
    for (const t of targetRows) if (t.ship.type) set.add(t.ship.type);
    return [...set].sort();
  });
  const filteredTargets = $derived.by<TargetRow[]>(() => {
    const q = targetQuery.trim().toLowerCase();
    const max = ccuFiltersP.value.maxPrice;
    let rows = targetRows.filter((t) => {
      if (targetType && t.ship.type !== targetType) return false;
      if (max > 0 && t.minUpgradePrice !== null && t.minUpgradePrice > max * 100) return false;
      if (q) {
        const hay = `${t.ship.manufacturerName} ${t.ship.name} ${t.ship.focus}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    rows.sort((a, b) => {
      if (a.minUpgradePrice === null && b.minUpgradePrice === null) return 0;
      if (a.minUpgradePrice === null) return 1;
      if (b.minUpgradePrice === null) return -1;
      return a.minUpgradePrice - b.minUpgradePrice;
    });
    return rows;
  });

  const HANGAR_URL = `${RSI_BASE_URL}/account/pledges`;
  function ccuShipDetailUrl(s: CcuShip): string {
    if (!s.link) return HANGAR_URL;
    return `${RSI_BASE_URL}${s.link.startsWith('/') ? s.link : '/' + s.link}`;
  }

  // Shortcuts
  interface Shortcut { label: string; path: string; icon: typeof Rocket; requiresAuth: boolean; }
  const SHORTCUTS: ReadonlyArray<Shortcut> = [
    { label: 'Cart', path: '/pledge/cart', icon: ShoppingCart, requiresAuth: true },
    { label: 'My hangar', path: '/account/pledges', icon: Warehouse, requiresAuth: true },
    { label: 'Buy-back pledges', path: '/account/buy-back-pledges', icon: HandCoins, requiresAuth: true },
    { label: 'Subscription', path: '/account/subscription', icon: Star, requiresAuth: true },
    { label: 'Referral program', path: '/referral-program', icon: Star, requiresAuth: true },
  ];

  function switchTab(next: Tab) {
    tabP.value = next;
    if (next === 'upgrade' && ccu === null && !ccuLoading) void loadCcu();
    if (next === 'cart' && cart === null && !cartLoading) void loadCart();
  }
  function switchCategory(next: StoreCategoryId) {
    categoryP.value = next;
  }

  let kicked = false;
  $effect(() => {
    if (authState.signedIn !== null && !kicked) {
      kicked = true;
      if (tabP.value === 'upgrade') void loadCcu();
      else if (tabP.value === 'cart') void loadCart();
      else void loadCategory(categoryP.value);
    }
  });
</script>

<section class="flex h-full flex-col overflow-hidden">
  {#if shipReader}
    <!-- Ship reader overlay. Reuses the same component as the Ships module.
         Pledge branch passes slug directly (no lookup); CCU branch passes
         name (handler resolves the slug from the cached pledge list). -->
    {#if shipReader.kind === 'pledge'}
      {@const s = shipReader.ship}
      <ShipReader
        slug={s.slug}
        initialSnippet={{
          name: s.name,
          manufacturerName: s.manufacturerName,
          thumbnailUrl: s.thumbnailUrl,
          msrp: s.msrp,
          type: s.type,
          focus: s.focus,
          productionStatus: s.productionStatus,
        }}
        onBack={closeShipReader}
        onAddToCart={(skuId, title) => void addStoreItemToCart(skuId, title)}
        addingSkuId={addingStoreSkuId}
        addFlash={storeCartFlash}
        focusEditions={shipReaderFocusEditions}
      />
    {:else if shipReader.kind === 'ccu'}
      {@const c = shipReader.ship}
      <ShipReader
        name={c.name}
        url={c.link || undefined}
        initialSnippet={{
          name: c.name,
          manufacturerName: c.manufacturerName,
          thumbnailUrl: c.thumbnailUrl,
          msrp: c.msrp,
          type: c.type,
          focus: c.focus,
          productionStatus: c.flyableStatus,
        }}
        onBack={closeShipReader}
        onAddToCart={(skuId, title) => void addStoreItemToCart(skuId, title)}
        addingSkuId={addingStoreSkuId}
        addFlash={storeCartFlash}
      />
    {:else}
      <StoreItemReader
        item={shipReader.item}
        categoryLabel={shipReader.categoryLabel}
        categoryId={shipReader.categoryId}
        onBack={closeShipReader}
        onAddToCart={(skuId, title) => void addStoreItemToCart(skuId, title)}
        addingSkuId={addingStoreSkuId}
        addFlash={storeCartFlash && shipReader.kind === 'item' && storeCartFlash.skuId === shipReader.item.id
          ? { type: storeCartFlash.type, text: storeCartFlash.text }
          : null}
      />
    {/if}
  {:else}
  <ModuleHeader
    title="Pledge Store"
    loading={currentLoading}
    fromCache={currentFromCache}
    onRefresh={refreshCurrentTab}
    refreshLabel="Refresh"
  >
    {#snippet meta()}
      {#if tab === 'store' && category === 'ships' && ships.length > 0}
        <span class="flex items-center gap-1.5 text-[10px] text-slate-500">
          {filteredShips.length}/{ships.length} ·
          <button
            type="button"
            onclick={toggleShipsOnSale}
            class="rounded px-1 py-0.5 text-[10px] uppercase tracking-wider transition {shipsOnSaleOnlyP.value
              ? 'bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/30 hover:bg-amber-500/20'
              : 'bg-slate-800 text-slate-300 ring-1 ring-inset ring-slate-700 hover:bg-slate-700'}"
            title={shipsOnSaleOnlyP.value
              ? 'Showing only ships currently on sale. Click to include the full catalogue.'
              : 'Showing the full catalogue. Click to filter to on-sale only.'}
          >
            {shipsOnSaleOnlyP.value ? `${shipsTotal} on sale` : `${shipsTotal} all`}
          </button>
        </span>
      {:else if tab === 'store' && browseItems.length > 0}
        <span class="text-[10px] text-slate-500">{filteredBrowse.length}/{browseItems.length}</span>
      {:else if tab === 'upgrade' && ccu}
        <span class="text-[10px] text-slate-500">
          {ownedCcuShips.length} owned{ccu.buybackCredit > 0 ? ` · ${formatPrice(ccu.buybackCredit)} buy-back` : ''}
        </span>
      {/if}
    {/snippet}
  </ModuleHeader>

  <div class="flex border-b border-slate-800 bg-slate-950/20 px-3 text-xs">
    <button type="button" onclick={() => switchTab('store')}
      class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'store' ? 'text-sky-300' : 'text-slate-400 hover:text-slate-200'}">
      <StoreIcon class="size-3" /> Store
      {#if tab === 'store'}<span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>{/if}
    </button>
    <button type="button" onclick={() => switchTab('upgrade')}
      class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'upgrade' ? 'text-sky-300' : 'text-slate-400 hover:text-slate-200'}">
      <ArrowRight class="size-3" /> Upgrades
      {#if tab === 'upgrade'}<span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>{/if}
    </button>
    <button type="button" onclick={() => switchTab('cart')}
      class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'cart' ? 'text-sky-300' : 'text-slate-400 hover:text-slate-200'}">
      <ShoppingCart class="size-3" /> Cart
      {#if cart && cart.itemsQty > 0}
        <!-- Item-count badge. Always visible while there's at least one
             line item, regardless of which tab is active. -->
        <span class="rounded-full bg-sky-500/20 px-1.5 py-0 text-[9px] font-semibold text-sky-300 ring-1 ring-sky-500/40">
          {cart.itemsQty}
        </span>
      {/if}
      {#if tab === 'cart'}<span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>{/if}
    </button>
    <button type="button" onclick={() => switchTab('shortcuts')}
      class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'shortcuts' ? 'text-sky-300' : 'text-slate-400 hover:text-slate-200'}">
      <ExternalLink class="size-3" /> Shortcuts
      {#if tab === 'shortcuts'}<span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>{/if}
    </button>
  </div>

  {#if tab === 'store'}
    <!-- Category pills. Wrap onto multiple rows in popup mode (760px
         is too narrow to fit 10 pills horizontally without an ugly
         scrollbar); stays on a single line in tab mode where the main
         column is wide enough. -->
    <div class="border-b border-slate-800 bg-slate-950/10 px-3 py-1.5">
      <ul class="flex flex-wrap gap-1 text-[11px]">
        {#each CATEGORIES as cat (cat.id)}
          {@const Icon = CATEGORY_ICONS[cat.id]}
          {@const active = category === cat.id}
          <li>
            <button type="button" onclick={() => switchCategory(cat.id)}
              class="flex items-center gap-1 rounded-full border px-2.5 py-1 transition
                {active
                  ? 'border-sky-500 bg-sky-950/50 text-sky-200'
                  : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'}">
              <Icon class="size-3" />
              {cat.label}
            </button>
          </li>
        {/each}
      </ul>
    </div>

    <!-- Sub-filter chips — server-driven. For Gear these are Armor /
         Clothing / Equipment; for Paints: Standard / Premium /
         Limited-time; for Merchandise: Accessories / Apparel /
         Collectibles / Home & Office. Categories without heap tags
         (Game Packages, Add-Ons, Tickets, Gift Cards, UEC) render
         nothing — the row collapses. -->
    {#if category !== 'ships'}
      {@const groups = browseFilterGroups[category] ?? []}
      {@const allTags = groups.flatMap((g) => g.facets.flatMap((f) => f.tags))}
      {#if allTags.length > 0}
        <div class="flex flex-wrap items-center gap-1.5 border-b border-slate-800 bg-slate-950/10 px-3 py-2 text-[11px]">
          <span class="text-slate-500">Filter:</span>
          <button type="button" onclick={() => setSubTag('')}
            class="rounded-full border px-2 py-0.5 transition
              {activeSubTag === ''
                ? 'border-sky-500 bg-sky-950/40 text-sky-200'
                : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'}">
            All
          </button>
          {#each allTags as tag (tag.identifier)}
            {@const active = activeSubTag === tag.identifier}
            <button type="button" onclick={() => setSubTag(tag.identifier)}
              class="rounded-full border px-2 py-0.5 capitalize transition
                {active
                  ? 'border-sky-500 bg-sky-950/40 text-sky-200'
                  : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'}">
              {tag.name.replace(/_/g, ' ').replace(/-/g, ' ')}
            </button>
          {/each}
        </div>
      {/if}
    {/if}

    <!-- Filter bar — always-visible controls: search, make/role for Ships,
         sort, Filters toggle, Clear, Open on RSI. The multi-select filter
         groups (Availability, Price, Status, Crew, Size) live in the
         collapsible panel below so the top bar stays scannable. -->
    <div class="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950/20 px-3 py-2 text-xs">
      <input type="search" placeholder="Filter..." bind:value={query}
        class="w-36 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none" />
      {#if category === 'ships'}
        <select bind:value={makeP.value} class="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-300">
          <option value="">All manufacturers</option>
          {#each manufacturers as m (m.id)}<option value={m.name}>{m.name}</option>{/each}
        </select>
        <select bind:value={typeP.value} class="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-300">
          <option value="">All roles</option>
          {#each typeOptionsShips as t (t)}<option value={t}>{t}</option>{/each}
        </select>
      {/if}
      <select bind:value={sortP.value} class="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-300">
        <option value="name">Name A-Z</option>
        <option value="name-desc">Name Z-A</option>
        <option value="price-asc">Price ↑</option>
        <option value="price-desc">Price ↓</option>
      </select>
      <button type="button" onclick={() => (filtersOpen = !filtersOpen)}
        class="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition
          {filtersOpen || hasAnyFilter
            ? 'border-sky-500 bg-sky-950/40 text-sky-200'
            : 'border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700 hover:text-slate-200'}"
        title="Show advanced filters"
        aria-expanded={filtersOpen}
      >
        <Filter class="size-3" />
        Filters
        {#if hasAnyFilter}
          {@const n = activeFilters.availability.length + activeFilters.priceRange.length + activeFilters.status.length + activeFilters.crew.length + activeFilters.size.length}
          <span class="rounded-full bg-sky-500/30 px-1 text-[9px] font-semibold">{n}</span>
        {/if}
      </button>
      {#if hasActiveBrowseFilter}
        <button type="button" onclick={clearBrowseFilters}
          class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-800 hover:text-slate-100">
          <X class="size-3" /> Clear
        </button>
      {/if}
      <a href={pledgeUrl(CATEGORIES.find(c => c.id === category)?.path ?? '/pledge')}
        target="_blank" rel="noopener noreferrer"
        class="ml-auto flex items-center gap-1 rounded-md border border-slate-800 px-2 py-1 text-[11px] text-slate-400 transition hover:border-sky-600 hover:text-sky-300"
        title="Open this section on RSI">
        Open on RSI
        <ExternalLink class="size-3" />
      </a>
    </div>

    <!-- Collapsible filter groups panel. Ships gets 5 groups, other
         categories get Availability + Price Range only — the rest are
         ship-specific and would show no matches in a generic list. -->
    {#if filtersOpen}
      <div class="grid gap-3 border-b border-slate-800 bg-slate-950/30 px-3 py-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <!-- Availability -->
        <fieldset class="rounded border border-slate-800/60 bg-slate-900/40 p-2">
          <legend class="px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Availability</legend>
          <label class="mt-1 flex items-center gap-1.5 text-slate-300">
            <input type="checkbox" class="accent-sky-500"
              checked={isFilterActive('availability', 'available')}
              onchange={() => toggleFilter('availability', 'available')} />
            Available for purchase
          </label>
          <label class="mt-1 flex items-center gap-1.5 text-slate-300">
            <input type="checkbox" class="accent-sky-500"
              checked={isFilterActive('availability', 'unavailable')}
              onchange={() => toggleFilter('availability', 'unavailable')} />
            Unavailable for purchase
          </label>
        </fieldset>

        <!-- Price Range -->
        <fieldset class="rounded border border-slate-800/60 bg-slate-900/40 p-2">
          <legend class="px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Price Range</legend>
          {#each PRICE_RANGES as r (r.id)}
            <label class="mt-1 flex items-center gap-1.5 text-slate-300">
              <input type="checkbox" class="accent-sky-500"
                checked={isFilterActive('priceRange', r.id)}
                onchange={() => toggleFilter('priceRange', r.id)} />
              {r.label}
            </label>
          {/each}
        </fieldset>

        {#if category === 'ships'}
          <!-- In-Game Status -->
          <fieldset class="rounded border border-slate-800/60 bg-slate-900/40 p-2">
            <legend class="px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">In-Game Status</legend>
            <label class="mt-1 flex items-center gap-1.5 text-slate-300">
              <input type="checkbox" class="accent-sky-500"
                checked={isFilterActive('status', 'flight-ready')}
                onchange={() => toggleFilter('status', 'flight-ready')} />
              Flight Ready
            </label>
            <label class="mt-1 flex items-center gap-1.5 text-slate-300">
              <input type="checkbox" class="accent-sky-500"
                checked={isFilterActive('status', 'in-concept')}
                onchange={() => toggleFilter('status', 'in-concept')} />
              In Concept
            </label>
          </fieldset>

          <!-- Crew -->
          <fieldset class="rounded border border-slate-800/60 bg-slate-900/40 p-2">
            <legend class="px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Crew</legend>
            {#each CREW_RANGES as r (r.id)}
              <label class="mt-1 flex items-center gap-1.5 text-slate-300">
                <input type="checkbox" class="accent-sky-500"
                  checked={isFilterActive('crew', r.id)}
                  onchange={() => toggleFilter('crew', r.id)} />
                {r.label}
              </label>
            {/each}
          </fieldset>

          <!-- Size -->
          <fieldset class="rounded border border-slate-800/60 bg-slate-900/40 p-2">
            <legend class="px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Size</legend>
            {#each SHIP_SIZES as s (s)}
              <label class="mt-1 flex items-center gap-1.5 text-slate-300 capitalize">
                <input type="checkbox" class="accent-sky-500"
                  checked={isFilterActive('size', s)}
                  onchange={() => toggleFilter('size', s)} />
                {s}
              </label>
            {/each}
          </fieldset>
        {/if}
      </div>
    {/if}
  {/if}

  <div class="flex-1 overflow-y-auto p-3">
    {#if tab === 'store'}
      {#if category === 'ships'}
        {#if shipsError}
          <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
            <AlertTriangle class="mt-0.5 size-4 shrink-0" />
            <div><p class="font-semibold">Couldn't load ships</p><p class="mt-1 break-all text-rose-300/80">{shipsError}</p></div>
          </div>
        {:else if shipsLoading && ships.length === 0}
          <div class="flex h-full items-center justify-center text-slate-500"><Loader2 class="size-5 animate-spin" /></div>
        {:else}
          <ul class="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 3xl:grid-cols-6 4xl:grid-cols-7">
            {#each filteredShips as s (s.id)}
              {@const owned = ccuOwnedIds.has(Number(s.id))}
              <li class="virt-item-lg relative">
                <!-- Card-level Add shortcut. Ships have multiple SKU
                     variants (Standalone / Warbond / LTI / Package) so the
                     grid can't commit to one — it opens the reader with
                     auto-scroll to the Editions section where the user
                     picks which SKU to add. Pinned below the price
                     badge at top-right to avoid overlap. -->
                <button
                  type="button"
                  class="absolute right-1 top-8 z-10 rounded-full bg-amber-500/90 p-1 text-amber-950 transition hover:bg-amber-400"
                  onclick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openPledgeShipReader(s, { focusEditions: true });
                  }}
                  title="Pick an edition to add to cart"
                  aria-label="Pick an edition to add to cart"
                >
                  <ShoppingCart class="size-3.5" />
                </button>
                <button type="button" onclick={() => openPledgeShipReader(s)}
                  class="group relative block w-full overflow-hidden rounded-md bg-slate-900/70 text-left ring-1 ring-slate-800 transition hover:ring-sky-600
                    {owned ? 'ring-emerald-700/60' : ''}
                    {!s.purchasable ? 'opacity-75' : ''}">
                  <div class="aspect-[16/9] overflow-hidden bg-slate-950">
                    {#if s.thumbnailUrl}
                      <img src={s.thumbnailUrl} alt="" loading="lazy" class="size-full object-cover transition group-hover:scale-105" />
                    {:else}
                      <div class="flex size-full items-center justify-center text-slate-700"><ShipIcon class="size-8" /></div>
                    {/if}
                    <span class="absolute right-1 top-1 rounded bg-slate-950/80 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-sky-300 ring-1 ring-slate-700/70">
                      {formatPrice(s.msrp)}
                    </span>
                    {#if !s.purchasable}
                      <span class="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-slate-950/80 px-1 py-0.5 text-[9px] uppercase tracking-wider text-amber-300 ring-1 ring-amber-700/40">
                        <TriangleAlert class="size-2.5" /> Not on sale
                      </span>
                    {/if}
                  </div>
                  <div class="p-2">
                    <div class="mb-1 flex flex-wrap items-center gap-1">
                      {#if owned}<span class="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-300">Owned</span>{/if}
                      {#if s.productionStatus}<span class="text-[9px] uppercase tracking-wider text-slate-500">{s.productionStatus === 'flight-ready' ? 'Flight-ready' : s.productionStatus}</span>{/if}
                    </div>
                    <p class="line-clamp-1 text-[10px] text-slate-500">{s.manufacturerName}</p>
                    <p class="line-clamp-1 text-xs font-medium text-slate-200">{s.name}</p>
                    <p class="mt-0.5 line-clamp-1 text-[10px] text-slate-400">{s.focus || s.type}</p>
                  </div>
                </button>
              </li>
            {/each}
          </ul>
          {#if filteredShips.length === 0 && ships.length > 0}
            <p class="mt-6 text-center text-xs italic text-slate-500">No ships match your filter.</p>
          {/if}
        {/if}
      {:else}
        <!-- Generic browse card grid (Ship Packs / Game Packages / Paints /
             Gear / Merch / Add-Ons / Tickets / Gift / UEC). -->
        {#if browseError}
          <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
            <AlertTriangle class="mt-0.5 size-4 shrink-0" />
            <div><p class="font-semibold">Couldn't load {CATEGORIES.find(c => c.id === category)?.label}</p><p class="mt-1 break-all text-rose-300/80">{browseError}</p></div>
          </div>
        {:else if browseLoading && browseItems.length === 0}
          <div class="flex h-full items-center justify-center text-slate-500"><Loader2 class="size-5 animate-spin" /></div>
        {:else if browseItems.length === 0}
          <p class="mt-6 text-center text-xs italic text-slate-500">
            No items in this category right now.
          </p>
        {:else}
          <ul class="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 3xl:grid-cols-6 4xl:grid-cols-7">
            {#each filteredBrowse as i (i.id)}
              {@const hasDiscount = i.discounted !== null && i.discounted < i.msrp}
              {@const busy = addingStoreSkuId === i.id}
              {@const flash = storeCartFlash && storeCartFlash.skuId === i.id ? storeCartFlash : null}
              <li class="virt-item-lg relative">
                <button type="button" onclick={() => openStoreItemReader(i)}
                  class="group relative block w-full overflow-hidden rounded-md bg-slate-900/70 text-left ring-1 ring-slate-800 transition hover:ring-sky-600
                    {flash?.type === 'success' ? 'ring-emerald-600' : ''}
                    {flash?.type === 'error' ? 'ring-rose-600' : ''}
                    {!i.available ? 'opacity-60' : ''}">
                  <div class="aspect-[16/9] overflow-hidden bg-slate-950">
                    {#if i.thumbnailUrl}
                      <img src={i.thumbnailUrl} alt="" loading="lazy" class="size-full object-cover transition group-hover:scale-105" />
                    {:else}
                      <div class="flex size-full items-center justify-center text-slate-700"><Package class="size-8" /></div>
                    {/if}
                    <!-- Price badge (with strike-through on discount) -->
                    <div class="absolute right-1 top-1 flex flex-col items-end gap-0.5">
                      {#if hasDiscount}
                        <span class="rounded bg-rose-500/80 px-1 py-0 font-mono text-[9px] font-bold text-rose-50">-{i.discountLabel || '%'}</span>
                        <span class="rounded bg-slate-950/80 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-300 ring-1 ring-amber-700/40">
                          {formatPrice(i.discounted ?? 0)}
                        </span>
                        <span class="rounded bg-slate-950/50 px-1 py-0 font-mono text-[9px] text-slate-500 line-through">
                          {formatPrice(i.msrp)}
                        </span>
                      {:else}
                        <span class="rounded bg-slate-950/80 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-sky-300 ring-1 ring-slate-700/70">
                          {formatPrice(i.msrp)}
                        </span>
                      {/if}
                    </div>
                    <!-- Top-left tag flags -->
                    <div class="absolute left-1 top-1 flex flex-col gap-0.5">
                      {#if i.isWarbond}
                        <span class="rounded bg-amber-600/90 px-1 py-0 text-[9px] font-bold uppercase tracking-wider text-amber-50">Warbond</span>
                      {/if}
                      {#if i.isVip}
                        <span class="rounded bg-violet-600/90 px-1 py-0 text-[9px] font-bold uppercase tracking-wider text-violet-50">VIP</span>
                      {/if}
                      {#if !i.available}
                        <span class="rounded bg-slate-700/90 px-1 py-0 text-[9px] uppercase tracking-wider text-slate-300">Unavailable</span>
                      {/if}
                    </div>
                  </div>
                  <div class="p-2 pb-8">
                    {#if i.subtitle}
                      <p class="line-clamp-1 text-[10px] uppercase tracking-wider text-slate-500">{i.subtitle}</p>
                    {/if}
                    <p class="line-clamp-2 text-xs font-medium text-slate-200">{i.name}</p>
                    {#if i.excerpt}
                      <p class="mt-1 line-clamp-2 text-[10px] text-slate-400">{i.excerpt}</p>
                    {/if}
                    {#if i.tags.length > 0}
                      <div class="mt-1 flex flex-wrap gap-0.5">
                        {#each i.tags.slice(0, 2) as t (t)}
                          <span class="rounded bg-slate-800/60 px-1 py-0 text-[9px] text-slate-400">{t}</span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </button>
                <!-- Add-to-cart button — pinned to the bottom-right of the
                     card tile, outside the enclosing card <button> (nested
                     buttons would be invalid HTML). stopPropagation keeps
                     the click from also opening the reader. -->
                <button
                  type="button"
                  onclick={(e) => { e.stopPropagation(); void addStoreItemToCart(i.id, i.name); }}
                  disabled={!i.available || busy || addingStoreSkuId !== null}
                  title={i.available ? 'Add to cart' : 'Not available'}
                  aria-label={i.available ? 'Add to cart' : 'Not available'}
                  class="absolute bottom-1 right-1 inline-flex items-center gap-1 rounded-md bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                >
                  {#if busy}
                    <Loader2 class="size-3 animate-spin" />
                  {:else}
                    <ShoppingCart class="size-2.5" />
                    Add
                  {/if}
                </button>
                {#if flash}
                  <p
                    class="absolute bottom-1 left-1 right-10 truncate rounded px-1 py-0.5 text-[9px]
                      {flash.type === 'success'
                        ? 'bg-emerald-950/90 text-emerald-300'
                        : 'bg-rose-950/90 text-rose-300'}"
                  >
                    {flash.text}
                  </p>
                {/if}
              </li>
            {/each}
          </ul>
          {#if filteredBrowse.length === 0 && browseItems.length > 0}
            <p class="mt-6 text-center text-xs italic text-slate-500">No items match your filter.</p>
          {/if}
        {/if}
      {/if}
    {:else if tab === 'upgrade'}
      {#if ccuError}
        <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div><p class="font-semibold">Couldn't load CCU catalogue</p><p class="mt-1 break-all text-rose-300/80">{ccuError}</p></div>
        </div>
      {:else if ccuLoading && !ccu}
        <div class="flex h-full items-center justify-center text-slate-500"><Loader2 class="size-5 animate-spin" /></div>
      {:else if ccu && ccu.isAnonymous}
        <div class="mx-auto flex max-w-md flex-col items-center gap-2 text-center">
          <ArrowRight class="size-10 text-slate-700" />
          <p class="text-sm font-semibold text-slate-200">Sign in to plan CCU upgrades</p>
          <p class="text-[11px] text-slate-500">
            CIG's upgrade tool needs to know which ships you already own. Sign in on RSI and reopen the extension.
          </p>
          <a href={`${RSI_BASE_URL}/pledge`} target="_blank" rel="noopener noreferrer"
            class="mt-2 flex items-center gap-1 rounded-md bg-sky-600 px-3 py-1.5 text-[11px] font-semibold text-sky-50 hover:bg-sky-500">
            Open RSI <ExternalLink class="size-3" />
          </a>
        </div>
      {:else if ccu}
        <div class="mx-auto flex max-w-3xl flex-col gap-3">
          {#if ownedCcuShips.length > 0}
            <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-2">
              <p class="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
                <Warehouse class="size-3 text-emerald-400" />
                Upgrade from your hangar ({ownedCcuShips.length})
              </p>
              <ul class="flex flex-wrap gap-1.5">
                {#each ownedCcuShips as s (s.id)}
                  {@const isActive = fromIdP.value === s.id}
                  <li>
                    <button type="button"
                      onclick={() => { fromIdP.value = s.id; }}
                      class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition
                        {isActive ? 'bg-sky-600 text-sky-50 ring-1 ring-sky-400' : 'bg-slate-900/80 text-slate-200 ring-1 ring-slate-800 hover:ring-sky-600'}">
                      <span class="font-mono text-[10px] opacity-70">{s.manufacturerName.slice(0, 3).toUpperCase()}</span>
                      <span>{s.name}</span>
                      <span class="font-mono text-[10px] opacity-60">{formatPrice(s.msrp)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          <div class="rounded-lg border border-slate-800 bg-slate-900/40 p-2">
            <label class="flex items-center gap-2 text-[11px] text-slate-400">
              <span class="w-12 shrink-0">From</span>
              <select bind:value={fromIdP.value} class="min-w-0 flex-1 rounded border border-slate-800 bg-slate-900 px-2 py-1.5 text-xs text-slate-200">
                <option value={null}>— Select source ship —</option>
                {#if ownedCcuShips.length > 0}
                  <optgroup label="My hangar">
                    {#each ownedCcuShips as s (s.id)}
                      <option value={s.id}>{s.manufacturerName} — {s.name}</option>
                    {/each}
                  </optgroup>
                {/if}
                {#each ccuFromGroups as group (group.name)}
                  <optgroup label={group.name}>
                    {#each group.ships as s (s.id)}
                      <option value={s.id}>{s.name}{s.owned ? ' (owned)' : ''}</option>
                    {/each}
                  </optgroup>
                {/each}
              </select>
            </label>
          </div>

          {#if fromShip}
            <div class="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-xs">
              <span class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500">
                <Filter class="size-3" /> Targets
              </span>
              <input type="search" placeholder="Filter..." bind:value={targetQuery}
                class="w-32 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none" />
              <select bind:value={targetType} class="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-300">
                <option value="">All roles</option>
                {#each ccuTypeOptions as t (t)}<option value={t}>{t}</option>{/each}
              </select>
              <label class="flex items-center gap-1 text-[11px] text-slate-400">
                Max $
                <input type="number" min="0" step="10" bind:value={ccuFiltersP.value.maxPrice}
                  class="w-16 rounded border border-slate-800 bg-slate-900 px-1 py-0.5 text-right text-xs text-slate-200" />
              </label>
              <span class="ml-auto font-mono text-[10px] text-slate-500">{filteredTargets.length} routes</span>
            </div>

            {#if targetsError}
              <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
                <AlertTriangle class="mt-0.5 size-4 shrink-0" />
                <div>{targetsError}</div>
              </div>
            {:else if targetsLoading && !targets}
              <div class="flex h-40 items-center justify-center text-slate-500"><Loader2 class="size-5 animate-spin" /></div>
            {:else if filteredTargets.length === 0}
              <p class="mt-2 rounded border border-slate-800 bg-slate-900/40 p-3 text-center text-[11px] italic text-slate-500">
                No eligible CCU routes from <span class="font-semibold text-slate-300">{fromShip.name}</span>
                {targetQuery || targetType || ccuFiltersP.value.maxPrice > 0 ? ' match the current filters.' : '.'}
              </p>
            {:else}
              <div class="sticky top-0 z-10 flex items-center gap-2 rounded-md border border-slate-800 bg-slate-950/90 p-2 backdrop-blur">
                {#if fromShip.thumbnailUrl}
                  <img src={fromShip.thumbnailUrl} alt="" class="size-10 shrink-0 rounded object-cover" />
                {:else}
                  <div class="flex size-10 shrink-0 items-center justify-center rounded bg-slate-950 text-slate-700"><ShipIcon class="size-4" /></div>
                {/if}
                <div class="min-w-0 flex-1">
                  <p class="text-[10px] uppercase tracking-wider text-slate-500">From{fromShip.owned ? ' · owned' : ''}</p>
                  <p class="truncate text-xs font-semibold text-slate-100">{fromShip.name}</p>
                  <p class="truncate text-[10px] text-slate-500">{fromShip.manufacturerName} · {formatPrice(fromShip.msrp)}</p>
                </div>
                <button type="button" onclick={() => (fromIdP.value = null)}
                  class="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-rose-300" title="Clear source">
                  <X class="size-3.5" />
                </button>
              </div>

              <ul class="flex flex-col gap-1.5">
                {#each filteredTargets as row (row.ship.id)}
                  {@const skuId = row.lowestSkuId}
                  {@const canAdd = row.available && skuId !== null && fromShip !== null}
                  {@const busy = skuId !== null && addingToCartSkuId === skuId}
                  {@const flash = cartFlash && skuId !== null && cartFlash.skuId === skuId ? cartFlash : null}
                  <li class="flex flex-col gap-1 rounded-md border border-slate-800 bg-slate-900/60 p-2 transition hover:border-amber-600
                      {!row.available ? 'opacity-60' : ''}">
                    <div class="flex items-center gap-3">
                      <button type="button" onclick={() => openCcuShipReader(row.ship)}
                        class="flex min-w-0 flex-1 items-center gap-3 text-left">
                        {#if row.ship.thumbnailUrl}
                          <img src={row.ship.thumbnailUrl} alt="" class="size-10 shrink-0 rounded object-cover" />
                        {:else}
                          <div class="flex size-10 shrink-0 items-center justify-center rounded bg-slate-950 text-slate-700"><ShipIcon class="size-4" /></div>
                        {/if}
                        <div class="min-w-0 flex-1">
                          <div class="flex flex-wrap items-center gap-1">
                            <p class="truncate text-xs font-semibold text-slate-100">{row.ship.name}</p>
                            {#if row.ship.owned}<span class="rounded bg-emerald-500/20 px-1 py-0 text-[9px] font-semibold uppercase tracking-wider text-emerald-300">Owned</span>{/if}
                            {#if !row.available}<span class="rounded bg-slate-700/50 px-1 py-0 text-[9px] uppercase tracking-wider text-slate-400">Unavailable</span>{/if}
                          </div>
                          <p class="truncate text-[10px] text-slate-500">
                            {row.ship.manufacturerName} · {row.ship.focus || row.ship.type}
                            {#if row.ship.flyableStatus && row.ship.flyableStatus !== 'Flyable'}
                              · {row.ship.flyableStatus}
                            {/if}
                          </p>
                        </div>
                      </button>
                      <div class="shrink-0 text-right">
                        {#if row.minUpgradePrice !== null}
                          <p class="font-mono text-sm font-semibold text-amber-300">{formatPrice(row.minUpgradePrice)}</p>
                          <p class="text-[9px] uppercase tracking-wider text-slate-500">upgrade</p>
                        {:else}
                          <p class="text-[10px] italic text-slate-500">No CCU</p>
                        {/if}
                      </div>
                      <button type="button"
                        onclick={() => { if (canAdd && skuId !== null && fromShip) void addTargetToCart(fromShip.id, skuId, row.ship.name); }}
                        disabled={!canAdd || busy || addingToCartSkuId !== null}
                        title={canAdd ? `Add CCU to ${row.ship.name} to your cart` : 'No CCU available for this route'}
                        class="flex shrink-0 items-center gap-1 rounded-md bg-amber-500/90 px-2.5 py-1.5 text-[11px] font-semibold text-amber-950 transition
                          hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400">
                        {#if busy}
                          <Loader2 class="size-3.5 animate-spin" /> Adding…
                        {:else}
                          <ShoppingCart class="size-3.5" /> Add
                        {/if}
                      </button>
                    </div>
                    {#if flash}
                      <p class="text-[10px] {flash.type === 'success' ? 'text-emerald-300' : 'text-rose-300'}">
                        {flash.text}
                      </p>
                    {/if}
                  </li>
                {/each}
              </ul>

              <div class="mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-700/40 bg-amber-950/20 p-2.5 text-[11px] text-amber-200">
                <div class="min-w-0 flex-1">
                  <p class="font-semibold text-amber-100">Items added land in your RSI cart</p>
                  <p class="mt-0.5 text-amber-300/80">
                    Use "Add" above to queue an upgrade, then review and pay on RSI.
                  </p>
                </div>
                <a href={CART_URL} target="_blank" rel="noopener noreferrer"
                  class="flex shrink-0 items-center gap-1 rounded-md bg-amber-500/90 px-3 py-1.5 font-semibold text-amber-950 transition hover:bg-amber-400">
                  Open Cart <ExternalLink class="size-3" />
                </a>
              </div>
            {/if}
          {:else}
            <p class="mt-2 text-center text-[11px] italic text-slate-500">
              Pick a source ship above to see eligible upgrade routes with live prices.
            </p>
          {/if}
        </div>
      {/if}
    {:else if tab === 'cart'}
      <!-- Pledge-store cart: read-only mirror of the user's server-side
           cart. Adds happen via the CCU "Add" button or externally on
           RSI; we surface the current state + totals here and deep-link
           to /pledge/cart for checkout. The cart cache is invalidated
           after local add-to-cart, so this view is always fresh post-
           add. The "Refresh" button in the module header forces a new
           fetch if the user added something from another tab. -->
      {#if cartError}
        <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Couldn't load cart</p>
            <p class="mt-1 break-all text-rose-300/80">{cartError}</p>
          </div>
        </div>
      {:else if cartLoading && !cart}
        <div class="flex h-full items-center justify-center text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if cart && cart.lineItems.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-slate-500">
          <ShoppingCart class="size-10" />
          <p class="text-sm italic">Your cart is empty.</p>
          <p class="text-[11px]">
            Add a CCU from the Upgrades tab, or browse the Store.
          </p>
        </div>
      {:else if cart}
        <div class="mx-auto flex max-w-4xl flex-col gap-3">
          <ul class="flex flex-col gap-2">
            {#each cart.lineItems as li (li.id)}
              {@const effectivePrice = li.discountedUnitPrice ?? li.unitPrice}
              {@const hasDiscount = li.discountedUnitPrice !== null && li.discountedUnitPrice !== li.unitPrice}
              {@const removing = removingLineItemId === li.id}
              <li class="flex items-start gap-3 rounded-md border border-slate-800 bg-slate-900/60 p-2
                  {removing ? 'opacity-60' : ''}">
                {#if li.thumbnailUrl}
                  <img src={li.thumbnailUrl} alt="" class="size-14 shrink-0 rounded object-cover" />
                {:else}
                  <div class="flex size-14 shrink-0 items-center justify-center rounded bg-slate-950 text-slate-700">
                    {#if li.isUpgrade}
                      <ArrowRight class="size-5" />
                    {:else}
                      <Package class="size-5" />
                    {/if}
                  </div>
                {/if}
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-1">
                    {#if li.isUpgrade}
                      <span class="rounded bg-amber-500/20 px-1 py-0 text-[9px] font-semibold uppercase tracking-wider text-amber-300">
                        Upgrade
                      </span>
                    {/if}
                    {#if li.isWarbond}
                      <span class="rounded bg-fuchsia-500/20 px-1 py-0 text-[9px] font-semibold uppercase tracking-wider text-fuchsia-300">
                        Warbond
                      </span>
                    {/if}
                    {#if li.qty > 1}
                      <span class="rounded bg-slate-800/60 px-1 py-0 text-[9px] font-semibold uppercase tracking-wider text-slate-400">
                        ×{li.qty}
                      </span>
                    {/if}
                  </div>
                  <p class="text-xs font-semibold text-slate-100">{li.title}</p>
                  {#if li.subtitle}
                    <p class="text-[10px] uppercase tracking-wider text-slate-500">{li.subtitle}</p>
                  {/if}
                </div>
                <div class="shrink-0 text-right">
                  {#if hasDiscount}
                    <p class="font-mono text-[10px] text-slate-500 line-through">
                      {formatNativeCurrency(li.unitPrice, cart)}
                    </p>
                    <p class="font-mono text-sm font-semibold text-emerald-300">
                      {formatNativeCurrency(effectivePrice, cart)}
                    </p>
                    {#if li.discountLabel}
                      <span class="inline-block rounded bg-emerald-500/15 px-1 py-0 text-[9px] font-semibold uppercase tracking-wider text-emerald-300">
                        {li.discountLabel}
                      </span>
                    {/if}
                  {:else}
                    <p class="font-mono text-sm font-semibold text-amber-300">
                      {formatNativeCurrency(effectivePrice, cart)}
                    </p>
                  {/if}
                </div>
                <button
                  type="button"
                  onclick={() => void removeLineItem(li.id, li.skuId, li.identifier)}
                  disabled={removingLineItemId !== null || clearingCart}
                  title="Remove from cart"
                  aria-label="Remove from cart"
                  class="shrink-0 rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {#if removing}
                    <Loader2 class="size-3.5 animate-spin" />
                  {:else}
                    <X class="size-3.5" />
                  {/if}
                </button>
              </li>
            {/each}
          </ul>

          <!-- Totals + checkout. subTotal is before tax, total includes
               it (when taxInclusive is true). Labels adapt accordingly. -->
          <section class="flex flex-col gap-1 rounded-md border border-slate-700 bg-slate-900/80 p-3 text-xs">
            <div class="flex items-baseline justify-between text-slate-400">
              <span>Subtotal</span>
              <span class="font-mono">{formatNativeCurrency(cart.subTotal, cart)}</span>
            </div>
            {#if cart.total !== cart.subTotal}
              <div class="flex items-baseline justify-between text-[11px] text-slate-500">
                <span>Tax</span>
                <span class="font-mono">
                  {formatNativeCurrency(cart.total - cart.subTotal, cart)}
                </span>
              </div>
            {/if}
            <div class="mt-1 flex items-baseline justify-between border-t border-slate-800 pt-1.5 text-sm font-semibold text-slate-100">
              <span>Total{cart.taxInclusive ? ' (incl. tax)' : ''}</span>
              <span class="font-mono text-amber-300">{formatNativeCurrency(cart.total, cart)}</span>
            </div>
          </section>

          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onclick={clearCartAll}
              disabled={clearingCart || removingLineItemId !== null}
              class="inline-flex items-center gap-1 rounded-md bg-rose-500/15 px-2 py-1 text-[11px] font-semibold text-rose-300 ring-1 ring-rose-500/40 transition hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              title="Remove all items from your cart"
            >
              {#if clearingCart}
                <Loader2 class="size-3 animate-spin" />
              {:else}
                <Trash2 class="size-3" />
              {/if}
              Clear cart
            </button>
            <div class="flex-1"></div>
            <button
              type="button"
              onclick={() => void loadCart(true)}
              disabled={cartLoading}
              class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw class="size-3 {cartLoading ? 'animate-spin' : ''}" /> Refresh
            </button>
            <a
              href={CART_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 rounded-md bg-amber-500/90 px-3 py-1.5 text-xs font-semibold text-amber-950 transition hover:bg-amber-400"
            >
              Checkout on RSI <ExternalLink class="size-3" />
            </a>
          </div>

          <p class="mt-1 text-center text-[10px] italic text-slate-600">
            Payment happens on RSI — the extension only surfaces the cart.
          </p>
        </div>
      {/if}

    {:else if tab === 'shortcuts'}
      <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {#each SHORTCUTS as item (item.path)}
          {@const Icon = item.icon}
          {@const gated = item.requiresAuth && authState.signedIn === false}
          <li>
            <a href={`${RSI_BASE_URL}${item.path}`} target="_blank" rel="noopener noreferrer"
              class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 p-2 text-xs text-slate-200 transition hover:border-sky-600 hover:text-sky-300 {gated ? 'opacity-60' : ''}"
              title={gated ? 'Sign in to RSI to access' : undefined}>
              <Icon class="size-4 text-slate-500" />
              <span class="flex-1 truncate">{item.label}</span>
              <ExternalLink class="size-3 text-slate-500" />
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  {/if}
</section>
