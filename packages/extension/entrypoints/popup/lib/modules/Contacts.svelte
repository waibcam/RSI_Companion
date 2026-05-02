<script lang="ts">
  import {
    sendRsiMessage,
    RSI_BASE_URL,
    CONTACTS_SYNC_TO_PTU_PORT,
    type ContactsSyncToPtuEntry,
    type ContactsSyncToPtuResponsePayload,
    type ContactsSyncToPtuStreamCommand,
    type ContactsSyncToPtuStreamEvent,
    type Rsi,
  } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    Check,
    Clock,
    HelpCircle,
    Loader2,
    RefreshCw,
    Search,
    TriangleAlert,
    UserMinus,
    UserPlus,
    UserRound,
    Users,
    X,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import SignInPrompt from '../components/SignInPrompt.svelte';
  import { notifyState } from '../notify.svelte';
  import { authState } from '../state.svelte';
  import { extractSignedIn, errorMessage } from '../error';

  type Contact = Rsi.Contact;
  type ContactRequest = Rsi.ContactRequest;
  type MemberHit = Rsi.MemberHit;
  type Tab = 'all' | 'pending' | 'find' | 'sync';
  type SyncResponse = ContactsSyncToPtuResponsePayload;
  type SyncEntry = ContactsSyncToPtuEntry;

  let contacts = $state<Contact[]>([]);
  let incoming = $state<ContactRequest[]>([]);
  let outgoing = $state<ContactRequest[]>([]);
  let signedIn = $state<boolean | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let fromCache = $state(false);
  let query = $state('');
  let tab = $state<Tab>('all');

  // Find-tab state
  let findQuery = $state('');
  let findHits = $state<MemberHit[]>([]);
  let findLoading = $state(false);
  let findError = $state<string | null>(null);
  let findDebounce: ReturnType<typeof setTimeout> | null = null;

  // Per-row action state: keyed by request id or member id depending on context
  let busyId = $state<number | null>(null);
  let actionError = $state<string | null>(null);

  // "Sync LIVE → PTU" workflow. Streamed via a long-lived port so the
  // popup can render progress live instead of sitting on a 30-second
  // spinner. The port handler in the BG calls runContactsSyncToPtu()
  // with a streaming emitter; each event lands here and updates the
  // local state. See packages/shared/src/contacts-sync-stream.ts for
  // the protocol.
  let syncing = $state(false);
  let syncError = $state<string | null>(null);
  let syncResult = $state<SyncResponse | null>(null);
  let syncLogOpen = $state(true);
  /** Phase + counters streamed from the BG. Drives the progress bar,
   *  the X / Y label, and the "currently trying" hint. */
  let syncProgress = $state<{
    phase: 'reading' | 'classifying' | 'adding' | 'cancelling';
    current: number;
    total: number;
    nowTrying: string | null;
    alreadyFriendCount: number;
    alreadyPendingCount: number;
  } | null>(null);
  /** Live entry log — newest first so the user sees the latest result
   *  at the top without having to scroll down a long list mid-sync. */
  let syncLog = $state<SyncEntry[]>([]);
  /** Held during an active sync so cancel() can postMessage. Reset to
   *  null after the port disconnects (success / error / cancel). */
  let syncPort = $state<chrome.runtime.Port | null>(null);

  function resetSyncState() {
    syncResult = null;
    syncError = null;
    syncProgress = null;
    syncLog = [];
  }

  async function runSync() {
    if (syncing) return;
    resetSyncState();
    syncing = true;
    syncProgress = {
      phase: 'reading',
      current: 0,
      total: 0,
      nowTrying: null,
      alreadyFriendCount: 0,
      alreadyPendingCount: 0,
    };
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: CONTACTS_SYNC_TO_PTU_PORT });
    } catch (e) {
      syncError = errorMessage(e);
      syncing = false;
      syncProgress = null;
      return;
    }
    syncPort = port;

    port.onMessage.addListener((raw: unknown) => {
      const event = raw as ContactsSyncToPtuStreamEvent;
      switch (event.type) {
        case 'started': {
          syncProgress = {
            phase: event.total > 0 ? 'adding' : 'classifying',
            current: 0,
            total: event.total,
            nowTrying: null,
            alreadyFriendCount: event.alreadyFriendCount,
            alreadyPendingCount: event.alreadyPendingCount,
          };
          break;
        }
        case 'progress': {
          syncProgress = {
            ...(syncProgress ?? {
              phase: 'adding',
              current: 0,
              total: event.total,
              nowTrying: null,
              alreadyFriendCount: 0,
              alreadyPendingCount: 0,
            }),
            phase: 'adding',
            current: event.current,
            total: event.total,
            nowTrying: event.nickname,
          };
          break;
        }
        case 'entry': {
          // Newest at the top so the live log reads as a feed.
          syncLog = [event.entry, ...syncLog];
          break;
        }
        case 'complete': {
          syncResult = event.result;
          syncing = false;
          syncProgress = null;
          syncPort = null;
          break;
        }
        case 'cancelled': {
          // Synthesize a partial result from the entries we collected
          // so the totals card still renders something sensible.
          const entries = event.partialEntries;
          const counts = {
            added: entries.filter((e) => e.status === 'added').length,
            alreadyFriend: entries.filter((e) => e.status === 'alreadyFriend').length,
            alreadyPending: entries.filter((e) => e.status === 'alreadyPending').length,
            notFound: entries.filter((e) => e.status === 'notFound').length,
            error: entries.filter((e) => e.status === 'error').length,
          };
          syncResult = {
            signedIn: { live: true, ptu: true },
            entries,
            counts,
          };
          syncing = false;
          syncProgress = null;
          syncPort = null;
          break;
        }
        case 'error': {
          syncError = event.message;
          syncing = false;
          syncProgress = null;
          syncPort = null;
          break;
        }
      }
    });

    port.onDisconnect.addListener(() => {
      // BG-side disconnect — covers complete/cancel/error paths via
      // the messages above too, but also catches the rare case where
      // the BG SW restarted mid-sync. Clear the spinner regardless.
      syncing = false;
      syncProgress = null;
      syncPort = null;
    });
  }

  function cancelSync() {
    if (!syncPort || !syncing) return;
    if (syncProgress) {
      syncProgress = { ...syncProgress, phase: 'cancelling' };
    }
    const cmd: ContactsSyncToPtuStreamCommand = { type: 'cancel' };
    try {
      syncPort.postMessage(cmd);
    } catch {
      // Port already disconnected — onDisconnect will clean up state.
    }
  }

  // Pre-built Tailwind class strings per status — Tailwind's JIT scanner
  // can only extract statically-written classes, so dynamic templates
  // like `text-${color}-400` silently generate no CSS. Keeping the full
  // strings here is ugly but guaranteed to produce every class.
  const SYNC_STATUS_META: Record<
    SyncEntry['status'],
    {
      label: string;
      icon: typeof Check;
      /** Used on the totals-card status label. */
      textClass: string;
      /** Used on the log-row status chip. */
      chipClass: string;
    }
  > = {
    added: {
      label: 'Added',
      icon: Check,
      textClass: 'text-emerald-400',
      chipClass:
        'bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/30',
    },
    alreadyPending: {
      label: 'Pending',
      icon: Clock,
      textClass: 'text-amber-400',
      chipClass:
        'bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/30',
    },
    alreadyFriend: {
      label: 'Already friend',
      icon: Users,
      textClass: 'text-sky-400',
      chipClass: 'bg-sky-500/10 text-sky-300 ring-1 ring-inset ring-sky-500/30',
    },
    notFound: {
      label: 'No PTU account',
      icon: HelpCircle,
      textClass: 'text-slate-400',
      chipClass:
        'bg-slate-500/10 text-slate-300 ring-1 ring-inset ring-slate-500/30',
    },
    error: {
      label: 'Error',
      icon: TriangleAlert,
      textClass: 'text-rose-400',
      chipClass: 'bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-500/30',
    },
  };

  async function load(force = false) {
    loading = true;
    error = null;
    try {
      const res = await sendRsiMessage({ type: 'contacts.list', force });
      contacts = res.contacts;
      incoming = res.incoming;
      outgoing = res.outgoing;
      signedIn = res.signedIn;
      fromCache = res.fromCache;
    } catch (e) {
      error = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      loading = false;
    }
  }

  async function runAction(
    action: 'accept' | 'decline' | 'cancel' | 'send' | 'remove',
    id: number,
  ) {
    busyId = id;
    actionError = null;

    // Optimistic: snapshot the relevant lists so we can roll back on failure.
    // The happy path reloads from the server anyway (authoritative), so the
    // snapshot is only used for the error branch.
    const snapshot = { incoming, outgoing, contacts, findHits };

    // Remove the acted-on row immediately so the UI doesn't sit with a stale
    // button while the round-trip completes.
    if (action === 'accept' || action === 'decline') {
      incoming = incoming.filter((r) => r.id !== id);
    } else if (action === 'cancel') {
      outgoing = outgoing.filter((r) => r.id !== id);
    } else if (action === 'send') {
      findHits = findHits.filter((h) => h.id !== id);
    }

    try {
      await sendRsiMessage({ type: 'contacts.action', action, id });
      // Authoritative refresh — on success we replace the optimistic state
      // with whatever the server reports (the `accept` case promotes a row
      // from `incoming` into `contacts`, which only the server can do).
      await load(true);
    } catch (e) {
      // Roll back: restore the lists exactly as they were before the action.
      incoming = snapshot.incoming;
      outgoing = snapshot.outgoing;
      contacts = snapshot.contacts;
      findHits = snapshot.findHits;
      actionError = errorMessage(e);
    } finally {
      busyId = null;
    }
  }

  function scheduleSearch() {
    if (findDebounce) clearTimeout(findDebounce);
    findError = null;
    const q = findQuery.trim();
    if (q.length < 2) {
      findHits = [];
      findLoading = false;
      return;
    }
    findLoading = true;
    findDebounce = setTimeout(async () => {
      try {
        const res = await sendRsiMessage({ type: 'contacts.search', query: q });
        findHits = res.hits;
      } catch (e) {
        findError = errorMessage(e);
        findHits = [];
      } finally {
        findLoading = false;
      }
    }, 250);
  }

  // Cancel any pending debounced find-by-handle when the module unmounts —
  // otherwise the setTimeout fires after teardown and the fetch writes to
  // dangling state.
  $effect(() => () => {
    if (findDebounce) clearTimeout(findDebounce);
  });

  const filteredContacts = $derived.by<Contact[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const hay = `${c.displayname ?? ''} ${c.nickname}`.toLowerCase();
      return hay.includes(q);
    });
  });

  const pendingCount = $derived(incoming.length + outgoing.length);

  const existingNicks = $derived(new Set(contacts.map((c) => c.nickname.toLowerCase())));
  const pendingNicks = $derived(
    new Set([
      ...incoming.map((r) => r.nickname.toLowerCase()),
      ...outgoing.map((r) => r.nickname.toLowerCase()),
    ]),
  );

  function avatarUrl(path: string | null | undefined): string | null {
    if (!path) return null;
    return path.startsWith('http') ? path : `${RSI_BASE_URL}${path}`;
  }

  $effect(() => {
    if (tab === 'pending') void notifyState.markSeen('contacts');
  });

  // Gate the fetch on the global auth state.
  let kicked = false;
  $effect(() => {
    if (authState.signedIn === true && !kicked) {
      kicked = true;
      void load();
    } else if (authState.signedIn === false) {
      signedIn = false;
      loading = false;
    }
  });
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader title="Contacts" {loading} {fromCache} onRefresh={() => load(true)}>
    {#snippet meta()}
      {#if signedIn}
        <span class="text-[10px] text-slate-500">{contacts.length} total</span>
      {/if}
    {/snippet}
    {#snippet controls()}
      {#if tab === 'all'}
        <input
          type="search"
          placeholder="Filter..."
          bind:value={query}
          class="min-w-0 flex-1 max-w-48 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
        />
      {:else}
        <div class="flex-1"></div>
      {/if}
    {/snippet}
  </ModuleHeader>

  {#if signedIn}
    <div class="flex border-b border-slate-800 bg-slate-950/20 px-3 text-xs">
      {#each [['all', `All (${contacts.length})`], ['pending', `Pending${pendingCount ? ` (${pendingCount})` : ''}`], ['find', 'Find'], ['sync', 'Sync to PTU']] as const as [id, label] (id)}
        <button
          type="button"
          onclick={() => (tab = id)}
          class="relative px-3 py-1.5 transition {tab === id
            ? 'text-sky-300'
            : 'text-slate-400 hover:text-slate-200'}"
        >
          {label}
          {#if tab === id}
            <span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto p-3">
    {#if authState.signedIn === false || signedIn === false}
      <SignInPrompt label="Contacts" />
    {:else if authState.signedIn === null}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if error}
      <div
        class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Failed to load contacts</p>
          <p class="mt-1 break-all text-rose-300/80">{error}</p>
        </div>
      </div>
    {:else if loading && contacts.length === 0}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else}
      {#if actionError}
        <div class="mb-2 rounded-md border border-rose-900/60 bg-rose-950/40 px-2 py-1 text-[11px] text-rose-200">
          {actionError}
        </div>
      {/if}

      {#if tab === 'all'}
        {#if contacts.length === 0}
          <p class="mt-6 text-center text-xs italic text-slate-500">You have no contacts yet.</p>
        {:else}
          <ul class="grid grid-cols-2 gap-1.5 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 3xl:grid-cols-8 4xl:grid-cols-10">
            {#each filteredContacts as c (c.nickname)}
              <li class="group relative">
                <a
                  href={`${RSI_BASE_URL}/citizens/${c.nickname}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex items-center gap-2 rounded-md bg-slate-900/70 p-1.5 ring-1 ring-slate-800 transition hover:ring-sky-600"
                >
                  <div class="size-9 shrink-0 overflow-hidden rounded bg-slate-950 ring-1 ring-slate-800">
                    {#if avatarUrl(c.avatar)}
                      <img src={avatarUrl(c.avatar)} alt="" loading="lazy" class="size-full object-cover" />
                    {:else}
                      <div class="flex size-full items-center justify-center text-slate-700">
                        <UserRound class="size-5" />
                      </div>
                    {/if}
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-xs font-medium text-slate-200">
                      {c.displayname || c.nickname}
                    </p>
                    <p class="truncate text-[10px] text-slate-500">@{c.nickname}</p>
                  </div>
                </a>
                <button
                  type="button"
                  onclick={() => {
                    // We track by numeric id; for remove we don't have member id on Contact.
                    // Identify member id via outgoing (if we just sent) is not relevant here.
                    // Legacy endpoint accepts member id only — without it we can't remove.
                    // Fallback: tell the user to do it from the RSI site.
                    window.open(`${RSI_BASE_URL}/citizens/${c.nickname}`, '_blank', 'noopener');
                  }}
                  class="absolute right-1 top-1 rounded p-0.5 text-slate-600 opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
                  title="Open profile to manage"
                >
                  <UserMinus class="size-3" />
                </button>
              </li>
            {/each}
          </ul>

          {#if filteredContacts.length === 0}
            <p class="mt-6 text-center text-xs italic text-slate-500">No contacts match your filter.</p>
          {/if}
        {/if}
      {:else if tab === 'pending'}
        {#if pendingCount === 0}
          <p class="mt-6 text-center text-xs italic text-slate-500">No pending friend requests.</p>
        {:else}
          {#if incoming.length > 0}
            <h3 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Incoming ({incoming.length})
            </h3>
            <ul class="mb-4 space-y-1.5">
              {#each incoming as r (r.id)}
                <li
                  class="flex items-center gap-2 rounded-md bg-slate-900/70 p-1.5 ring-1 ring-slate-800"
                >
                  <div class="size-9 shrink-0 overflow-hidden rounded bg-slate-950 ring-1 ring-slate-800">
                    {#if avatarUrl(r.avatar)}
                      <img src={avatarUrl(r.avatar)} alt="" loading="lazy" class="size-full object-cover" />
                    {:else}
                      <div class="flex size-full items-center justify-center text-slate-700">
                        <UserRound class="size-5" />
                      </div>
                    {/if}
                  </div>
                  <div class="min-w-0 flex-1">
                    <a
                      href={`${RSI_BASE_URL}/citizens/${r.nickname}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="block truncate text-xs font-medium text-slate-200 hover:text-sky-300"
                    >
                      {r.displayname || r.nickname}
                    </a>
                    <p class="truncate text-[10px] text-slate-500">@{r.nickname}</p>
                  </div>
                  <button
                    type="button"
                    disabled={busyId === r.id}
                    onclick={() => runAction('accept', r.id)}
                    class="rounded bg-emerald-500/20 p-1 text-emerald-300 transition hover:bg-emerald-500/30 disabled:opacity-50"
                    title="Accept"
                  >
                    {#if busyId === r.id}
                      <Loader2 class="size-3.5 animate-spin" />
                    {:else}
                      <Check class="size-3.5" />
                    {/if}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === r.id}
                    onclick={() => runAction('decline', r.id)}
                    class="rounded bg-rose-500/10 p-1 text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-50"
                    title="Decline"
                  >
                    <X class="size-3.5" />
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if outgoing.length > 0}
            <h3 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Outgoing ({outgoing.length})
            </h3>
            <ul class="space-y-1.5">
              {#each outgoing as r (r.id)}
                <li
                  class="flex items-center gap-2 rounded-md bg-slate-900/70 p-1.5 ring-1 ring-slate-800"
                >
                  <div class="size-9 shrink-0 overflow-hidden rounded bg-slate-950 ring-1 ring-slate-800">
                    {#if avatarUrl(r.avatar)}
                      <img src={avatarUrl(r.avatar)} alt="" loading="lazy" class="size-full object-cover" />
                    {:else}
                      <div class="flex size-full items-center justify-center text-slate-700">
                        <UserRound class="size-5" />
                      </div>
                    {/if}
                  </div>
                  <div class="min-w-0 flex-1">
                    <a
                      href={`${RSI_BASE_URL}/citizens/${r.nickname}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="block truncate text-xs font-medium text-slate-200 hover:text-sky-300"
                    >
                      {r.displayname || r.nickname}
                    </a>
                    <p class="truncate text-[10px] text-slate-500">@{r.nickname}</p>
                  </div>
                  <button
                    type="button"
                    disabled={busyId === r.id}
                    onclick={() => runAction('cancel', r.id)}
                    class="rounded bg-slate-800 px-2 py-1 text-[10px] uppercase tracking-wider text-slate-300 transition hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-50"
                    title="Cancel request"
                  >
                    {#if busyId === r.id}
                      <Loader2 class="size-3 animate-spin" />
                    {:else}
                      Cancel
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      {:else if tab === 'find'}
        <div class="relative mb-3">
          <Search class="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            placeholder="Search citizen handle or name…"
            bind:value={findQuery}
            oninput={scheduleSearch}
            class="w-full rounded-md border border-slate-800 bg-slate-900 py-1.5 pl-7 pr-7 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
          />
          {#if findLoading}
            <Loader2
              class="absolute right-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-slate-500"
              aria-hidden="true"
            />
          {/if}
        </div>

        {#if findError}
          <p class="text-center text-xs text-rose-300/80">{findError}</p>
        {:else if findQuery.trim().length < 2}
          <p class="mt-6 text-center text-xs italic text-slate-500">
            Type at least 2 characters to search Star Citizens.
          </p>
        {:else if findHits.length === 0 && !findLoading}
          <p class="mt-6 text-center text-xs italic text-slate-500">No citizens found.</p>
        {:else}
          <ul class="space-y-1.5">
            {#each findHits as h (h.id)}
              {@const already = existingNicks.has(h.nickname.toLowerCase())}
              {@const pending = pendingNicks.has(h.nickname.toLowerCase())}
              <li
                class="flex items-center gap-2 rounded-md bg-slate-900/70 p-1.5 ring-1 ring-slate-800"
              >
                <div class="size-9 shrink-0 overflow-hidden rounded bg-slate-950 ring-1 ring-slate-800">
                  {#if avatarUrl(h.avatar)}
                    <img src={avatarUrl(h.avatar)} alt="" loading="lazy" class="size-full object-cover" />
                  {:else}
                    <div class="flex size-full items-center justify-center text-slate-700">
                      <UserRound class="size-5" />
                    </div>
                  {/if}
                </div>
                <div class="min-w-0 flex-1">
                  <a
                    href={`${RSI_BASE_URL}/citizens/${h.nickname}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="block truncate text-xs font-medium text-slate-200 hover:text-sky-300"
                  >
                    {h.displayname || h.nickname}
                  </a>
                  <p class="truncate text-[10px] text-slate-500">@{h.nickname}</p>
                </div>
                {#if already}
                  <span class="text-[10px] uppercase tracking-wider text-emerald-400/70">Friend</span>
                {:else if pending}
                  <span class="text-[10px] uppercase tracking-wider text-amber-400/70">Pending</span>
                {:else}
                  <button
                    type="button"
                    disabled={busyId === h.id}
                    onclick={() => runAction('send', h.id)}
                    class="flex items-center gap-1 rounded bg-sky-500/20 px-2 py-1 text-[10px] uppercase tracking-wider text-sky-300 transition hover:bg-sky-500/30 disabled:opacity-50"
                  >
                    {#if busyId === h.id}
                      <Loader2 class="size-3 animate-spin" />
                    {:else}
                      <UserPlus class="size-3" />
                      Add
                    {/if}
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {:else if tab === 'sync'}
        <!-- Sync LIVE → PTU. The PTU social graph is a separate database
             from LIVE — CIG resets it on each test wave and never
             mirrors back from LIVE. This workflow copies every LIVE
             friend that the user doesn't already have on PTU (or have
             pending) by firing a PTU friend-request per candidate. -->
        <div class="mx-auto flex max-w-3xl flex-col gap-3">
          <div class="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-300">
            <p class="flex items-center gap-1 font-semibold text-slate-200">
              <RefreshCw class="size-3.5 text-sky-400" /> Sync your LIVE contacts to PTU
            </p>
            <p class="mt-1.5 leading-relaxed text-slate-400">
              PTU has its own Spectrum database separate from LIVE, so
              your friend list there doesn't carry over automatically.
              Running this action sends a contact request from your PTU
              account to every LIVE friend who isn't already on it.
            </p>
            <p class="mt-1.5 leading-relaxed text-slate-500">
              You need to be signed in on both
              <a
                href="https://robertsspaceindustries.com"
                target="_blank"
                rel="noopener noreferrer"
                class="text-sky-400 underline decoration-sky-700 underline-offset-2 hover:decoration-sky-400"
                >robertsspaceindustries.com</a
              >
              and
              <a
                href="https://ptu.cloudimperiumgames.com"
                target="_blank"
                rel="noopener noreferrer"
                class="text-sky-400 underline decoration-sky-700 underline-offset-2 hover:decoration-sky-400"
                >ptu.cloudimperiumgames.com</a
              >
              — the extension reads each site's session cookie independently.
            </p>
          </div>

          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick={runSync}
                disabled={syncing}
                class="inline-flex items-center gap-1.5 rounded-md bg-sky-500/20 px-3 py-1.5 text-xs font-semibold text-sky-300 ring-1 ring-sky-500/40 transition hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {#if syncing}
                  <Loader2 class="size-3.5 animate-spin" />
                  Syncing…
                {:else}
                  <RefreshCw class="size-3.5" />
                  {syncResult ? 'Run again' : 'Sync now'}
                {/if}
              </button>
              {#if syncing}
                <button
                  type="button"
                  onclick={cancelSync}
                  disabled={syncProgress?.phase === 'cancelling'}
                  class="inline-flex items-center gap-1.5 rounded-md bg-slate-800/60 px-3 py-1.5 text-xs font-semibold text-slate-300 ring-1 ring-slate-700 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Stop the sync after the current request completes"
                >
                  <X class="size-3.5" />
                  {syncProgress?.phase === 'cancelling' ? 'Cancelling…' : 'Cancel'}
                </button>
              {/if}
            </div>
            {#if syncResult?.counts}
              {@const c = syncResult.counts}
              <p class="text-[11px] text-slate-500">
                {c.added + c.alreadyFriend + c.alreadyPending + c.notFound + c.error} contacts processed
              </p>
            {/if}
          </div>

          <!-- Live progress card. Shown only while a sync is in flight.
               Surfaces phase + a current/total counter + the handle
               currently being attempted, plus a thin progress bar.
               The pre-classified counts (alreadyFriend / alreadyPending
               from the initial bundle reads) appear as sub-counters so
               the user can see those are already accounted for and
               doesn't expect them to appear in the live log. -->
          {#if syncing && syncProgress}
            {@const phaseLabel =
              syncProgress.phase === 'reading'
                ? 'Reading LIVE + PTU friend lists…'
                : syncProgress.phase === 'classifying'
                  ? 'Classifying contacts…'
                  : syncProgress.phase === 'cancelling'
                    ? 'Cancelling…'
                    : `Adding to PTU (${syncProgress.current} / ${syncProgress.total})`}
            {@const pct =
              syncProgress.total > 0
                ? Math.round((syncProgress.current / syncProgress.total) * 100)
                : 0}
            <div class="rounded-md border border-sky-900/60 bg-sky-950/30 p-3 text-xs">
              <div class="mb-2 flex items-baseline justify-between gap-2">
                <p class="font-semibold text-sky-200">{phaseLabel}</p>
                {#if syncProgress.nowTrying}
                  <p class="truncate text-[11px] text-slate-400">
                    <span class="text-slate-500">trying </span>
                    <span class="font-mono text-slate-200">{syncProgress.nowTrying}</span>
                  </p>
                {/if}
              </div>
              {#if syncProgress.total > 0}
                <div class="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    class="h-full bg-sky-500 transition-all"
                    style:width="{pct}%"
                  ></div>
                </div>
              {:else if syncProgress.phase === 'reading' || syncProgress.phase === 'classifying'}
                <!-- Indeterminate — total isn't known until the started
                     event fires. Animated stripes communicate "working". -->
                <div class="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div class="h-full w-1/3 animate-pulse bg-sky-500/50"></div>
                </div>
              {/if}
              <div class="flex flex-wrap gap-2 text-[10px] text-slate-500">
                <span>{syncProgress.alreadyFriendCount} already friend</span>
                <span>•</span>
                <span>{syncProgress.alreadyPendingCount} already pending</span>
                {#if syncProgress.total > 0}
                  <span>•</span>
                  <span>{syncProgress.total - syncProgress.current} remaining</span>
                {/if}
              </div>
            </div>
          {/if}

          <!-- Live log — populated incrementally as each `entry` event
               lands, newest at the top. Visible as soon as the sync
               starts producing entries (classification + per-add). -->
          {#if syncing && syncLog.length > 0}
            <details class="rounded-md border border-slate-800 bg-slate-900/40 text-xs" open>
              <summary class="cursor-pointer px-3 py-1.5 text-slate-300 hover:text-slate-100">
                Live log ({syncLog.length})
              </summary>
              <ul class="max-h-48 divide-y divide-slate-800 overflow-y-auto border-t border-slate-800">
                {#each syncLog.slice(0, 50) as e (e.nickname)}
                  {@const meta = SYNC_STATUS_META[e.status]}
                  {@const SvelteIcon = meta.icon}
                  <li class="flex items-center gap-2 px-3 py-1">
                    <SvelteIcon class="size-3 shrink-0 {meta.textClass}" />
                    <span class="flex-1 truncate text-slate-300">{e.displayName}</span>
                    <span class="text-[10px] uppercase tracking-wider {meta.textClass}">
                      {meta.label}
                    </span>
                  </li>
                {/each}
                {#if syncLog.length > 50}
                  <li class="px-3 py-1 text-center text-[10px] italic text-slate-500">
                    + {syncLog.length - 50} more above
                  </li>
                {/if}
              </ul>
            </details>
          {/if}

          {#if syncError}
            <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-2.5 text-xs text-rose-200">
              <AlertTriangle class="mt-0.5 size-4 shrink-0" />
              <div class="min-w-0 flex-1 break-all">
                <p class="font-semibold">Sync failed</p>
                <p class="mt-0.5 text-rose-300/80">{syncError}</p>
              </div>
            </div>
          {/if}

          {#if syncResult && !syncResult.signedIn.live}
            <div class="flex items-start gap-2 rounded-md border border-amber-900/60 bg-amber-950/40 p-2.5 text-xs text-amber-200">
              <AlertTriangle class="mt-0.5 size-4 shrink-0" />
              <div class="min-w-0 flex-1">
                <p class="font-semibold">Not signed in on LIVE</p>
                <p class="mt-0.5 text-amber-300/80">
                  Sign in at
                  <a
                    href="https://robertsspaceindustries.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline decoration-amber-600 hover:decoration-amber-400"
                    >robertsspaceindustries.com</a
                  >
                  first, then come back and run the sync.
                </p>
              </div>
            </div>
          {/if}

          {#if syncResult && !syncResult.signedIn.ptu}
            <div class="flex items-start gap-2 rounded-md border border-amber-900/60 bg-amber-950/40 p-2.5 text-xs text-amber-200">
              <AlertTriangle class="mt-0.5 size-4 shrink-0" />
              <div class="min-w-0 flex-1">
                <p class="font-semibold">Not signed in on PTU</p>
                <p class="mt-0.5 text-amber-300/80">
                  Sign in at
                  <a
                    href="https://ptu.cloudimperiumgames.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline decoration-amber-600 hover:decoration-amber-400"
                    >ptu.cloudimperiumgames.com</a
                  >
                  first, then come back and run the sync.
                </p>
              </div>
            </div>
          {/if}

          {#if syncResult?.counts && syncResult.entries}
            {@const c = syncResult.counts}
            <!-- Totals card — each status gets its own mini-card so the
                 user can see at a glance what happened without opening
                 the full log. -->
            <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
              {#each [['added', c.added], ['alreadyPending', c.alreadyPending], ['alreadyFriend', c.alreadyFriend], ['notFound', c.notFound], ['error', c.error]] as const as [status, n] (status)}
                {@const meta = SYNC_STATUS_META[status]}
                {@const SvelteIcon = meta.icon}
                <div
                  class="rounded-md bg-slate-900/60 p-2 ring-1 ring-slate-800 text-center"
                >
                  <div
                    class="flex items-center justify-center gap-1 text-[10px] uppercase tracking-wider {meta.textClass}"
                  >
                    <SvelteIcon class="size-3" />
                    {meta.label}
                  </div>
                  <div class="mt-0.5 font-mono text-lg font-semibold text-slate-100">
                    {n}
                  </div>
                </div>
              {/each}
            </div>

            {#if syncResult.entries.length > 0}
              <details
                class="rounded-md border border-slate-800 bg-slate-900/40"
                bind:open={syncLogOpen}
              >
                <summary
                  class="cursor-pointer list-none px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200"
                >
                  {syncLogOpen ? '▼' : '▶'} Detailed log ({syncResult.entries.length})
                </summary>
                <ul class="divide-y divide-slate-800 border-t border-slate-800">
                  {#each syncResult.entries as e (e.nickname)}
                    {@const meta = SYNC_STATUS_META[e.status]}
                    {@const SvelteIcon = meta.icon}
                    <li class="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                      {#if e.avatar}
                        <img
                          src={avatarUrl(e.avatar) ?? ''}
                          alt=""
                          loading="lazy"
                          class="size-5 shrink-0 rounded-full bg-slate-950 object-cover ring-1 ring-slate-800"
                        />
                      {:else}
                        <div
                          class="flex size-5 shrink-0 items-center justify-center rounded-full bg-slate-950 ring-1 ring-slate-800 text-slate-700"
                        >
                          <UserRound class="size-3" />
                        </div>
                      {/if}
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-slate-100">{e.displayName}</p>
                        <p class="truncate text-[10px] text-slate-500">@{e.nickname}</p>
                      </div>
                      <span
                        class="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider {meta.chipClass}"
                        title={e.error}
                      >
                        <SvelteIcon class="size-2.5" />
                        {meta.label}
                      </span>
                    </li>
                  {/each}
                </ul>
              </details>
            {:else if !syncing}
              <p class="text-center text-[11px] italic text-slate-500">
                No LIVE contacts to process — your friend list is empty.
              </p>
            {/if}
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</section>
