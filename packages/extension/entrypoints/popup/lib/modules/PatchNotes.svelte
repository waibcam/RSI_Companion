<script lang="ts">
  import { sendRsiMessage, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    Loader2,
    MessageSquare,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import { notifyState } from '../notify.svelte';
  import { persistedState } from '../persist.svelte';
  import { errorMessage } from '../error';

  type PatchNote = Rsi.PatchNote;
  type Channel = 'ALL' | PatchNote['channel'];

  const CHANNELS: readonly Channel[] = ['ALL', 'LIVE', 'PTU', 'EPTU', 'TECH-PREVIEW', 'UNKNOWN'];
  const isChannel = (v: unknown): v is Channel =>
    typeof v === 'string' && (CHANNELS as readonly string[]).includes(v);

  let notes = $state<PatchNote[]>([]);
  let nextPage = $state(1);
  let hasMore = $state(true);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let fromCache = $state(false);
  let query = $state('');
  const channelP = persistedState<Channel>('patchnotes:channel', 'ALL', isChannel);
  let sentinel = $state<HTMLElement | null>(null);

  async function loadPage(page: number, force = false) {
    if (loading) return;
    loading = true;
    error = null;
    try {
      const res = await sendRsiMessage({ type: 'patchnotes.list', page, force });
      if (page === 1) {
        notes = res.notes;
      } else {
        // Dedupe by href — the RSI listing sometimes overlaps between pages,
        // and duplicate keys in a keyed {#each} break Svelte's rendering.
        const seen = new Set(notes.map((n) => n.href));
        const fresh = res.notes.filter((n) => !seen.has(n.href));
        notes = [...notes, ...fresh];
      }
      fromCache = res.fromCache;
      nextPage = page + 1;
      if (res.notes.length === 0) hasMore = false;
    } catch (e) {
      error = errorMessage(e);
    } finally {
      loading = false;
    }
  }

  function refresh() {
    nextPage = 1;
    notes = [];
    hasMore = true;
    loadPage(1, true);
  }

  // The observer re-attaches whenever the channel filter changes so that if the
  // sentinel is still visible after filtering (e.g. PTU has 0 matches on the
  // loaded pages), it can trigger another fetch rather than silently sitting
  // still on the last-reported intersection state.
  $effect(() => {
    if (!sentinel) return;
    // Read the channel filter so Svelte re-runs the effect (rebuild observer)
    // on tab switch. The assignment is the simplest way to create a tracked read.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _filter = channelP.value;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (loading || !hasMore || query.trim()) return;
        loadPage(nextPage);
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  });

  const filtered = $derived.by<PatchNote[]>(() => {
    const q = query.trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    return notes.filter((n) => {
      if (channelP.value !== 'ALL' && n.channel !== channelP.value) return false;
      if (terms.length > 0) {
        const hay = `${n.title} ${n.version ?? ''} ${n.channel}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) return false;
      }
      return true;
    });
  });

  const CHANNEL_COLORS: Record<PatchNote['channel'], string> = {
    LIVE: 'bg-emerald-500/20 text-emerald-300',
    PTU: 'bg-amber-500/20 text-amber-300',
    EPTU: 'bg-violet-500/20 text-violet-300',
    'TECH-PREVIEW': 'bg-rose-500/20 text-rose-300',
    UNKNOWN: 'bg-slate-700/40 text-slate-400',
  };

  // Raw hex values for the left-accent border. Tailwind `border-emerald-500`
  // etc. works too, but keeping this keyed by channel in one place makes
  // tuning the palette a single-file change.
  const CHANNEL_ACCENTS: Record<PatchNote['channel'], string> = {
    LIVE: '#10b981',
    PTU: '#f59e0b',
    EPTU: '#8b5cf6',
    'TECH-PREVIEW': '#f43f5e',
    UNKNOWN: '#475569',
  };

  // Snapshot unread count before markSeen clears it so we can tag the top N
  // rows with a NEW chip this session (list is newest-first).
  const unreadAtOpen = notifyState.state.counts['patch-notes'];

  loadPage(1);
  notifyState.markSeen('patch-notes');
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader title="Patch Notes" {loading} {fromCache} onRefresh={refresh}>
    {#snippet meta()}
      <span class="text-[10px] text-slate-500">{filtered.length}/{notes.length}</span>
    {/snippet}
    {#snippet controls()}
      <div class="flex items-center gap-1 text-[10px]">
        {#each ['ALL', 'LIVE', 'PTU', 'EPTU', 'TECH-PREVIEW'] as const as ch (ch)}
          <button
            type="button"
            onclick={() => (channelP.value = ch)}
            class="rounded px-1.5 py-0.5 uppercase tracking-wider transition {channelP.value === ch
              ? 'bg-sky-500/20 text-sky-300 ring-1 ring-inset ring-sky-500/40'
              : 'text-slate-500 hover:text-slate-200'}"
          >
            {ch}
          </button>
        {/each}
      </div>

      <input
        type="search"
        placeholder="Filter..."
        bind:value={query}
        class="min-w-0 flex-1 max-w-40 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
      />
    {/snippet}
  </ModuleHeader>

  <div class="flex-1 overflow-y-auto p-3">
    {#if error}
      <div
        class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Failed to load patch notes</p>
          <p class="mt-1 break-all text-rose-300/80">{error}</p>
        </div>
      </div>
    {:else if loading && notes.length === 0}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else}
      <!-- 2-col by default in popup + tab modes. Patch note cards are
           wide enough to read in ~360px of space, so splitting into two
           columns is the better information density. Drops back to a
           single column on very narrow viewports. -->
      <ul class="grid grid-cols-1 gap-1 sm:grid-cols-2 3xl:grid-cols-3 4xl:grid-cols-4">
        {#each filtered as n, i (n.href)}
          {@const isNew = !query.trim() && channelP.value === 'ALL' && i < unreadAtOpen}
          <li class="virt-item">
            <a
              href={n.url}
              target="_blank"
              rel="noopener noreferrer"
              class="group flex items-stretch gap-2.5 overflow-hidden rounded-md bg-slate-900/70 pr-2 ring-1 ring-slate-800 transition hover:bg-slate-900 hover:ring-sky-600
                {isNew ? 'ring-sky-500/60' : ''}"
              style:border-left="3px solid {CHANNEL_ACCENTS[n.channel]}"
            >
              {#if n.image}
                <div class="aspect-[16/10] w-24 shrink-0 overflow-hidden bg-slate-950 sm:w-28">
                  <img
                    src={n.image}
                    alt=""
                    loading="lazy"
                    class="size-full object-cover transition group-hover:scale-[1.04]"
                  />
                </div>
              {:else}
                <div class="w-2 shrink-0"></div>
              {/if}
              <div class="min-w-0 flex-1 py-1.5">
                <div class="mb-0.5 flex items-center gap-1.5">
                  {#if isNew}
                    <span class="rounded bg-sky-500/25 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-200">new</span>
                  {/if}
                  <span
                    class="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider {CHANNEL_COLORS[
                      n.channel
                    ]}"
                  >
                    {n.channel === 'UNKNOWN' ? '?' : n.channel}
                  </span>
                  {#if n.version}
                    <span class="font-mono text-[11px] font-semibold text-slate-200">v{n.version}</span>
                  {/if}
                  <span class="text-[10px] text-slate-500">· {n.timeAgo}</span>
                  {#if n.comments > 0}
                    <span class="ml-auto flex items-center gap-1 text-[10px] text-slate-500">
                      <MessageSquare class="size-3" />
                      {n.comments}
                    </span>
                  {/if}
                </div>
                <p class="line-clamp-1 text-xs font-semibold text-slate-100 group-hover:text-sky-200">
                  {n.title}
                </p>
                {#if n.excerpt}
                  <p class="mt-0.5 line-clamp-2 text-[10px] leading-snug text-slate-400">
                    {n.excerpt}
                  </p>
                {/if}
              </div>
            </a>
          </li>
        {/each}
      </ul>

      {#if filtered.length === 0 && notes.length > 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">
          {#if channelP.value !== 'ALL' && !query.trim()}
            No {channelP.value} patches in the latest {notes.length} entries.
          {:else}
            No patches match.
          {/if}
        </p>
      {/if}

      {#if notes.length > 0 && !query.trim()}
        <div
          bind:this={sentinel}
          class="mt-4 flex h-10 items-center justify-center text-xs text-slate-500"
        >
          {#if loading}
            <Loader2 class="size-4 animate-spin" />
          {:else if !hasMore}
            <span class="italic">No more patch notes.</span>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</section>
