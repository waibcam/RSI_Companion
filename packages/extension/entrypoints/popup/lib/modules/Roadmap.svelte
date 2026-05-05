<script lang="ts">
  import {
    Rsi,
    Schemas,
    RSI_BASE_URL,
    sendRsiMessage,
    type RoadmapSnapshotEntry,
  } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    CalendarClock,
    ChevronRight,
    Database,
    Loader2,
    RefreshCw,
    Sparkles,
    Trash2,
    X,
  } from 'lucide-svelte';
  import { notifyState } from '../notify.svelte';
  import { errorMessage } from '../error';
  import { persistedState } from '../persist.svelte';
  import { focusTrap } from '../focus-trap';
  import { log } from '@rsi-companion/shared';

  type Payload = Schemas.Backend.RoadmapPayload;
  type Release = Schemas.Backend.RoadmapRelease;
  type Card = Schemas.Backend.RoadmapCard;
  type DiffStatus = 'new' | 'moved' | 'unchanged';

  interface RemovedCard {
    id: string;
    name: string;
    categoryId: number;
  }

  let payload = $state<Payload | null>(null);
  let snapshotTs = $state<number | null>(null);
  let cached = $state(false);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let expanded = $state<Set<number>>(new Set());
  let previousSnapshot = $state<Record<string, RoadmapSnapshotEntry> | null>(null);
  let removedCards = $state<RemovedCard[]>([]);

  // Lightbox for card thumbnails — the 2-col grid keeps previews small, so
  // clicking opens the full image in an overlay.
  let zoomedCard = $state<Card | null>(null);

  const categoriesById = $derived<Map<number, string>>(
    new Map((payload?.categories ?? []).map((c) => [c.id, c.name])),
  );

  // Visible releases: start by dropping any release with zero cards —
  // RSI's payload occasionally carries "zombie" entries (e.g. a
  // duplicate 3.8 at id=26 with `released: 0, status: "", cards: []`,
  // paired with the real 3.8 at id=28 with all 22 cards). These
  // zombies have no content to display and only muddy the Upcoming
  // list. Trust `isReleasedRelease` (status-string based) over the
  // numeric `r.released` field for the Upcoming/Released split — RSI
  // lies on the numeric one for some patches (see the shared helper
  // for the full story).
  const visibleReleases = $derived<Release[]>(
    (payload?.releases ?? []).filter((r) => (r.cards?.length ?? 0) > 0),
  );
  const upcoming = $derived<Release[]>(
    visibleReleases.filter((r) => !Rsi.isReleasedRelease(r)),
  );
  const released = $derived<Release[]>(
    visibleReleases
      .filter((r) => Rsi.isReleasedRelease(r))
      .slice()
      .reverse(),
  );

  // Per-card status lookup built from the last-seen snapshot. "new" = id not in
  // snapshot at all; "moved" = id existed but release or category changed.
  const cardStatus = $derived.by<Map<number, DiffStatus>>(() => {
    const map = new Map<number, DiffStatus>();
    if (!payload || !previousSnapshot) return map;
    for (const release of payload.releases) {
      for (const card of release.cards) {
        const prev = previousSnapshot[String(card.id)];
        if (!prev) {
          map.set(card.id, 'new');
        } else if (prev.releaseId !== release.id || prev.categoryId !== card.category_id) {
          map.set(card.id, 'moved');
        } else {
          map.set(card.id, 'unchanged');
        }
      }
    }
    return map;
  });

  const newCount = $derived(
    [...cardStatus.values()].filter((s) => s === 'new').length,
  );
  const movedCount = $derived(
    [...cardStatus.values()].filter((s) => s === 'moved').length,
  );

  async function load(force = false) {
    loading = true;
    error = null;
    try {
      // Route through the background's shared `roadmap.data` cache so
      // Progress Tracker and Roadmap collapse into one HTTP call at boot
      // (both consume the same raw payload). `force=true` when the user
      // clicks the Refresh button — then the background re-hits the
      // backend instead of serving cache.
      const [roadmap, snap] = await Promise.all([
        sendRsiMessage({ type: 'roadmap.data', force }),
        sendRsiMessage({ type: 'roadmap.snapshot' }),
      ]);
      payload = roadmap.data;
      snapshotTs = roadmap.meta.snapshot_ts;
      cached = roadmap.fromCache || roadmap.meta.cached;
      previousSnapshot = snap.snapshot;

      // Removed = in previous snapshot but not in the current roadmap.
      if (snap.snapshot) {
        const currentIds = new Set<string>();
        for (const r of roadmap.data.releases) {
          for (const c of r.cards) currentIds.add(String(c.id));
        }
        const removed: RemovedCard[] = [];
        for (const [id, entry] of Object.entries(snap.snapshot)) {
          if (!currentIds.has(id)) {
            removed.push({ id, name: entry.name, categoryId: entry.categoryId });
          }
        }
        removedCards = removed;
      } else {
        removedCards = [];
      }

      await promoteSnapshot(roadmap.data);
    } catch (e) {
      error = errorMessage(e);
      payload = null;
    } finally {
      loading = false;
    }
  }

  async function promoteSnapshot(data: Payload): Promise<void> {
    const snap: Record<string, RoadmapSnapshotEntry> = {};
    for (const release of data.releases) {
      for (const card of release.cards) {
        snap[String(card.id)] = {
          releaseId: release.id,
          categoryId: card.category_id,
          name: card.name,
        };
      }
    }
    try {
      await sendRsiMessage({ type: 'roadmap.snapshot.commit', snapshot: snap });
    } catch (e) {
      // Non-fatal: worst case the user sees a slightly stale diff next visit.
      log.warn('roadmap', 'snapshot commit failed', e);
    }
  }

  function toggle(id: number) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function cardsByCategory(release: Release): Array<{ name: string; cards: Card[] }> {
    const groups = new Map<number, Card[]>();
    for (const card of release.cards) {
      const arr = groups.get(card.category_id) ?? [];
      arr.push(card);
      groups.set(card.category_id, arr);
    }
    return [...groups.entries()]
      .map(([id, cards]) => ({
        name: categoriesById.get(id) ?? `Category #${id}`,
        cards,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function thumbnailUrl(card: Card): string | null {
    const path = card.thumbnail?.urls?.square ?? card.thumbnail?.urls?.rect ?? null;
    if (!path) return null;
    if (/^https?:/i.test(path)) return path;
    return `${RSI_BASE_URL}${path}`;
  }

  // Larger variant used inside the lightbox for readability. RSI exposes
  // progressively bigger variants (`source` > `large` > `rect` > `square`);
  // pick the richest one the payload includes.
  function largeThumbnailUrl(card: Card): string | null {
    const urls = card.thumbnail?.urls ?? {};
    const path = urls.source ?? urls.large ?? urls.rect ?? urls.square ?? null;
    if (!path) return null;
    if (/^https?:/i.test(path)) return path;
    return `${RSI_BASE_URL}${path}`;
  }

  // Keyboard dismiss for the image lightbox.
  $effect(() => {
    if (zoomedCard === null) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') zoomedCard = null;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function formatSnapshot(ts: number): string {
    return new Date(ts * 1000).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  function dismissRemoved(): void {
    removedCards = [];
  }

  load();
  notifyState.markSeen('roadmap');
</script>

<section class="flex h-full flex-col overflow-hidden">
  <div
    class="flex items-center justify-between border-b border-slate-800 bg-slate-950/40 px-4 py-2"
  >
    <div class="flex items-baseline gap-2">
      <h2 class="text-sm font-semibold text-slate-200">Roadmap</h2>
      {#if snapshotTs !== null}
        <span class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500">
          {#if cached}<Database class="size-3" />{/if}
          {formatSnapshot(snapshotTs)}
        </span>
      {/if}
    </div>
    <button
      type="button"
      class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
      disabled={loading}
      onclick={() => load(true)}
      title="Refresh"
    >
      <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
      <span>Refresh</span>
    </button>
  </div>

  {#if newCount > 0 || movedCount > 0 || removedCards.length > 0}
    <div class="flex items-center gap-2 border-b border-slate-800 bg-slate-950/20 px-4 py-1.5 text-[10px] uppercase tracking-wider">
      <CalendarClock class="size-3 text-slate-400" />
      {#if newCount > 0}
        <span class="rounded bg-emerald-900/60 px-1.5 py-0.5 text-emerald-300">{newCount} new</span>
      {/if}
      {#if movedCount > 0}
        <span class="rounded bg-amber-900/60 px-1.5 py-0.5 text-amber-300">{movedCount} moved</span>
      {/if}
      {#if removedCards.length > 0}
        <span class="rounded bg-rose-900/60 px-1.5 py-0.5 text-rose-300">{removedCards.length} removed</span>
      {/if}
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto">
    {#if loading && payload === null}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if error}
      <div
        class="m-4 flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Failed to load roadmap</p>
          <p class="mt-1 break-all text-rose-300/80">{error}</p>
        </div>
      </div>
    {:else if payload}
      {#if removedCards.length > 0}
        <div class="m-3 rounded-md border border-rose-900/50 bg-rose-950/30 p-3">
          <div class="mb-2 flex items-center justify-between">
            <p class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-rose-300">
              <Trash2 class="size-3" />
              Removed since last visit ({removedCards.length})
            </p>
            <button
              type="button"
              class="rounded px-1.5 py-0.5 text-[10px] text-rose-400 hover:bg-rose-900/40"
              onclick={dismissRemoved}
            >
              Dismiss
            </button>
          </div>
          <ul class="flex flex-wrap gap-1.5">
            {#each removedCards as rc (rc.id)}
              <li
                class="rounded bg-rose-950/50 px-2 py-0.5 text-[11px] text-rose-200 line-through ring-1 ring-inset ring-rose-900/60"
                title={categoriesById.get(rc.categoryId) ?? ''}
              >
                {rc.name}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if upcoming.length > 0}
        <div class="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sky-400">
          Upcoming
        </div>
        <ul class="divide-y divide-slate-800/60 border-b border-slate-800/60">
          {#each upcoming as rel (rel.id)}
            {@render releaseRow(rel)}
          {/each}
        </ul>
      {/if}

      <div class="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        Released
      </div>
      <ul class="divide-y divide-slate-800/60">
        {#each released as rel (rel.id)}
          {@render releaseRow(rel)}
        {/each}
      </ul>
    {/if}
  </div>
</section>

{#if zoomedCard}
  {@const bigThumb = largeThumbnailUrl(zoomedCard)}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-6"
    onclick={() => (zoomedCard = null)}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    use:focusTrap
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="relative flex max-h-full max-w-full flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 shadow-2xl"
      onclick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        class="absolute right-2 top-2 rounded-md bg-slate-900/80 p-1 text-slate-300 ring-1 ring-inset ring-slate-700 transition hover:bg-slate-800 hover:text-slate-100"
        onclick={() => (zoomedCard = null)}
        aria-label="Close"
      >
        <X class="size-4" />
      </button>
      {#if bigThumb}
        <img
          src={bigThumb}
          alt={zoomedCard.name}
          class="max-h-[60vh] max-w-[80vw] object-contain"
        />
      {/if}
      <div class="max-w-[80vw] border-t border-slate-800 px-4 py-3">
        <p class="text-sm font-semibold text-slate-200">{zoomedCard.name}</p>
        {#if zoomedCard.status}
          <span
            class="mt-1 inline-block rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-400"
          >
            {zoomedCard.status}
          </span>
        {/if}
        {#if zoomedCard.description}
          <p class="mt-2 max-w-prose text-xs text-slate-300">{zoomedCard.description}</p>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#snippet releaseRow(rel: Release)}
  {@const isOpen = expanded.has(rel.id)}
  {@const relStatuses = rel.cards.map((c) => cardStatus.get(c.id) ?? 'unchanged')}
  {@const relNew = relStatuses.filter((s) => s === 'new').length}
  {@const relMoved = relStatuses.filter((s) => s === 'moved').length}
  <li>
    <button
      type="button"
      class="flex w-full items-center gap-2 px-4 py-2 text-left text-xs transition hover:bg-slate-800/40"
      onclick={() => toggle(rel.id)}
    >
      <ChevronRight class="size-3.5 shrink-0 text-slate-500 transition {isOpen ? 'rotate-90' : ''}" />
      <span class="font-semibold text-slate-200">{rel.name}</span>
      {#if rel.description}
        <span class="truncate text-slate-500">— {rel.description}</span>
      {/if}
      <span class="ml-auto flex shrink-0 items-center gap-1">
        {#if relNew > 0}
          <span class="rounded bg-emerald-900/60 px-1 py-0.5 text-[9px] uppercase tracking-wider text-emerald-300">
            +{relNew}
          </span>
        {/if}
        {#if relMoved > 0}
          <span class="rounded bg-amber-900/60 px-1 py-0.5 text-[9px] uppercase tracking-wider text-amber-300">
            ~{relMoved}
          </span>
        {/if}
        <span class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
          {rel.cards.length} card{rel.cards.length === 1 ? '' : 's'}
        </span>
      </span>
    </button>

    {#if isOpen}
      {#if rel.cards.length === 0}
        <p class="px-8 pb-3 text-xs italic text-slate-500">No cards in this release.</p>
      {:else}
        <div class="bg-slate-950/40 px-4 pb-3">
          {#each cardsByCategory(rel) as group (group.name)}
            <div class="mt-2">
              <div class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                {group.name}
              </div>
              <ul class="grid grid-cols-2 gap-2">
                {#each group.cards as card (card.id)}
                  {@const thumb = thumbnailUrl(card)}
                  {@const status = cardStatus.get(card.id) ?? 'unchanged'}
                  {@const ringClass =
                    status === 'new'
                      ? 'ring-emerald-700/70'
                      : status === 'moved'
                        ? 'ring-amber-700/70'
                        : 'ring-slate-800'}
                  <li>
                    <button
                      type="button"
                      class="flex w-full gap-2 rounded-md bg-slate-900/60 p-2 text-left ring-1 ring-inset {ringClass} transition hover:ring-sky-500/60 focus:outline-none focus:ring-sky-400"
                      onclick={() => (zoomedCard = card)}
                      title="Click to expand"
                    >
                      {#if thumb}
                        <div class="shrink-0 overflow-hidden rounded ring-1 ring-inset ring-slate-700/60">
                          <img
                            src={thumb}
                            alt=""
                            loading="lazy"
                            class="size-16 object-cover"
                          />
                        </div>
                      {/if}
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1">
                        <span class="truncate text-xs font-medium text-slate-200">{card.name}</span>
                        {#if status === 'new'}
                          <span
                            class="ml-auto flex shrink-0 items-center gap-0.5 rounded bg-emerald-900/70 px-1 py-0.5 text-[9px] uppercase tracking-wider text-emerald-300"
                            title="Added since last visit"
                          >
                            <Sparkles class="size-2.5" />
                            new
                          </span>
                        {:else if status === 'moved'}
                          <span
                            class="ml-auto shrink-0 rounded bg-amber-900/70 px-1 py-0.5 text-[9px] uppercase tracking-wider text-amber-300"
                            title="Moved to a different release or category"
                          >
                            moved
                          </span>
                        {/if}
                      </div>
                      {#if card.status}
                        <span
                          class="mt-0.5 inline-block rounded bg-slate-800 px-1 py-0.5 text-[9px] uppercase tracking-wider text-slate-400"
                          >{card.status}</span
                        >
                      {/if}
                      {#if card.description}
                        <p class="mt-1 line-clamp-2 text-[11px] text-slate-400">{card.description}</p>
                      {/if}
                    </div>
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </li>
{/snippet}
