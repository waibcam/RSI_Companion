<script lang="ts">
  import { sendRsiMessage, RSI_BASE_URL, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    Building2,
    ChevronRight,
    Database,
    ExternalLink,
    Inbox,
    Loader2,
    Mail,
    RefreshCw,
    Send,
    User,
    Users,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import SignInPrompt from '../components/SignInPrompt.svelte';
  import { authState } from '../state.svelte';
  import { persistedState } from '../persist.svelte';
  import { extractSignedIn, errorMessage } from '../error';

  type Org = Rsi.MyOrg;
  type Member = Rsi.OrgMember;
  type Tab = 'membership' | 'invitations' | 'applications';

  interface MemberState {
    loading: boolean;
    error: string | null;
    members: Member[];
    totalRows: number;
    fetched: boolean;
    fromCache: boolean;
  }

  const TABS: readonly Tab[] = ['membership', 'invitations', 'applications'];
  const isTab = (v: unknown): v is Tab =>
    typeof v === 'string' && (TABS as readonly string[]).includes(v);
  const tabP = persistedState<Tab>('orgs:tab', 'membership', isTab);
  const tab = $derived(tabP.value);

  let signedIn = $state<boolean | null>(null);

  // Membership (existing flow — expandable roster)
  let membership = $state<Org[]>([]);
  let membershipLoading = $state(true);
  let membershipError = $state<string | null>(null);
  let membershipFromCache = $state(false);
  let expanded = $state<Set<string>>(new Set());
  let memberStates = $state<Record<string, MemberState>>({});

  // Invitations + Applications (same shape — flat list of org cards)
  let invitations = $state<Org[]>([]);
  let invitationsLoading = $state(false);
  let invitationsError = $state<string | null>(null);
  let invitationsFetched = $state(false);
  let invitationsFromCache = $state(false);

  let applications = $state<Org[]>([]);
  let applicationsLoading = $state(false);
  let applicationsError = $state<string | null>(null);
  let applicationsFetched = $state(false);
  let applicationsFromCache = $state(false);

  async function loadMembership(force = false) {
    membershipLoading = true;
    membershipError = null;
    try {
      const res = await sendRsiMessage({ type: 'orgs.myList', force });
      membership = res.orgs;
      signedIn = res.signedIn;
      membershipFromCache = res.fromCache;
    } catch (e) {
      membershipError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      membershipLoading = false;
    }
  }

  async function loadInvitations(force = false) {
    invitationsLoading = true;
    invitationsError = null;
    try {
      const res = await sendRsiMessage({ type: 'orgs.invitations', force });
      invitations = res.orgs;
      invitationsFromCache = res.fromCache;
      invitationsFetched = true;
      if (res.signedIn === false) signedIn = false;
    } catch (e) {
      invitationsError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      invitationsLoading = false;
    }
  }

  async function loadApplications(force = false) {
    applicationsLoading = true;
    applicationsError = null;
    try {
      const res = await sendRsiMessage({ type: 'orgs.applications', force });
      applications = res.orgs;
      applicationsFromCache = res.fromCache;
      applicationsFetched = true;
      if (res.signedIn === false) signedIn = false;
    } catch (e) {
      applicationsError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      applicationsLoading = false;
    }
  }

  function ensureState(sid: string): MemberState {
    let s = memberStates[sid];
    if (!s) {
      s = {
        loading: false,
        error: null,
        members: [],
        totalRows: 0,
        fetched: false,
        fromCache: false,
      };
      memberStates = { ...memberStates, [sid]: s };
    }
    return s;
  }

  async function loadMembers(sid: string, force = false) {
    const s = ensureState(sid);
    memberStates = { ...memberStates, [sid]: { ...s, loading: true, error: null } };
    try {
      const res = await sendRsiMessage({ type: 'orgs.members', sid, force });
      memberStates = {
        ...memberStates,
        [sid]: {
          loading: false,
          error: null,
          members: res.members,
          totalRows: res.totalRows,
          fetched: true,
          fromCache: res.fromCache,
        },
      };
    } catch (e) {
      memberStates = {
        ...memberStates,
        [sid]: { ...ensureState(sid), loading: false, error: errorMessage(e) },
      };
    }
  }

  function toggle(sid: string) {
    const next = new Set(expanded);
    if (next.has(sid)) {
      next.delete(sid);
    } else {
      next.add(sid);
      const s = memberStates[sid];
      if (!s?.fetched && !s?.loading) void loadMembers(sid);
    }
    expanded = next;
  }

  function refreshMembers(sid: string) {
    void loadMembers(sid, true);
  }

  function switchTab(next: Tab) {
    tabP.value = next;
    // Lazy-load invitations/applications on first tab visit — saves the
    // extra HTTP round trips for users who never leave Membership.
    if (next === 'invitations' && !invitationsFetched && !invitationsLoading) {
      void loadInvitations();
    } else if (next === 'applications' && !applicationsFetched && !applicationsLoading) {
      void loadApplications();
    }
  }

  function refreshCurrent() {
    if (tab === 'membership') void loadMembership(true);
    else if (tab === 'invitations') void loadInvitations(true);
    else if (tab === 'applications') void loadApplications(true);
  }

  // Tab-scoped derived values for the header meta + fromCache indicator.
  const currentLoading = $derived(
    tab === 'membership'
      ? membershipLoading
      : tab === 'invitations'
        ? invitationsLoading
        : applicationsLoading,
  );
  const currentFromCache = $derived(
    tab === 'membership'
      ? membershipFromCache
      : tab === 'invitations'
        ? invitationsFromCache
        : applicationsFromCache,
  );
  const currentCount = $derived(
    tab === 'membership'
      ? membership.length
      : tab === 'invitations'
        ? invitations.length
        : applications.length,
  );

  // Gate the initial fetch on the global auth state. Membership loads
  // immediately when signed in; invitations/applications wait for their
  // first tab click (switchTab).
  let kicked = false;
  $effect(() => {
    if (authState.signedIn === true && !kicked) {
      kicked = true;
      void loadMembership();
      // Also kick the active tab's loader if it's not membership (covers
      // users who left the popup on Invitations/Applications last session).
      if (tabP.value === 'invitations') void loadInvitations();
      else if (tabP.value === 'applications') void loadApplications();
    } else if (authState.signedIn === false) {
      signedIn = false;
      membershipLoading = false;
    }
  });
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader
    title="Organizations"
    loading={currentLoading}
    fromCache={currentFromCache}
    onRefresh={refreshCurrent}
    refreshLabel="Refresh"
  >
    {#snippet meta()}
      {#if signedIn}
        <span class="text-[10px] text-slate-500">{currentCount} total</span>
      {/if}
    {/snippet}
  </ModuleHeader>

  {#if authState.signedIn === true && signedIn !== false}
    <div class="flex border-b border-slate-800 bg-slate-950/20 px-3 text-xs">
      <button
        type="button"
        onclick={() => switchTab('membership')}
        class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'membership'
          ? 'text-sky-300'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        <Building2 class="size-3" />
        Membership
        {#if tab === 'membership'}
          <span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>
        {/if}
      </button>
      <button
        type="button"
        onclick={() => switchTab('invitations')}
        class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'invitations'
          ? 'text-sky-300'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        <Mail class="size-3" />
        Invitations
        {#if invitationsFetched && invitations.length > 0}
          <span class="ml-0.5 rounded bg-sky-500/30 px-1 text-[9px] font-semibold text-sky-200"
            >{invitations.length}</span
          >
        {/if}
        {#if tab === 'invitations'}
          <span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>
        {/if}
      </button>
      <button
        type="button"
        onclick={() => switchTab('applications')}
        class="relative flex items-center gap-1 px-3 py-1.5 transition {tab === 'applications'
          ? 'text-sky-300'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        <Send class="size-3" />
        Applications
        {#if applicationsFetched && applications.length > 0}
          <span class="ml-0.5 rounded bg-sky-500/30 px-1 text-[9px] font-semibold text-sky-200"
            >{applications.length}</span
          >
        {/if}
        {#if tab === 'applications'}
          <span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>
        {/if}
      </button>
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto p-3">
    {#if authState.signedIn === false || signedIn === false}
      <SignInPrompt label="Organizations" />
    {:else if authState.signedIn === null}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if tab === 'membership'}
      {#if membershipError}
        <div
          class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
        >
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Failed to load organizations</p>
            <p class="mt-1 break-all text-rose-300/80">{membershipError}</p>
          </div>
        </div>
      {:else if membershipLoading && membership.length === 0}
        <div class="flex h-full items-center justify-center text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if membership.length === 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">
          You're not a member of any organization.
        </p>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each membership as o (o.sid)}
            {@const isOpen = expanded.has(o.sid)}
            {@const state = memberStates[o.sid]}
            <li class="overflow-hidden rounded-md bg-slate-900/70 ring-1 ring-slate-800">
              <div class="flex items-center gap-3 p-2">
                <button
                  type="button"
                  onclick={() => toggle(o.sid)}
                  class="flex min-w-0 flex-1 items-center gap-3 text-left transition hover:opacity-90"
                  title={isOpen ? 'Hide members' : 'Show members'}
                >
                  <ChevronRight
                    class="size-4 shrink-0 text-slate-500 transition {isOpen ? 'rotate-90' : ''}"
                  />
                  <div
                    class="size-12 shrink-0 overflow-hidden rounded bg-slate-950 ring-1 ring-slate-800"
                  >
                    {#if o.logo}
                      <img src={o.logo} alt="" loading="lazy" class="size-full object-cover" />
                    {:else}
                      <div class="flex size-full items-center justify-center text-slate-700">
                        <Building2 class="size-6" />
                      </div>
                    {/if}
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium text-slate-100">{o.name}</p>
                    <p class="truncate text-[11px] text-slate-500">
                      <span class="font-mono text-slate-400">{o.sid}</span>
                      {#if o.rank}
                        · {o.rank}
                      {/if}
                    </p>
                    <div class="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
                      {#if o.levelNumber > 0}
                        <span class="flex gap-0.5">
                          {#each [1, 2, 3, 4, 5] as n (n)}
                            <span
                              class="size-1.5 rounded-full {n <= o.levelNumber
                                ? 'bg-sky-500'
                                : 'bg-slate-700'}"
                            ></span>
                          {/each}
                        </span>
                      {/if}
                      <span class="flex items-center gap-1">
                        <Users class="size-3" />
                        {o.memberCount}
                      </span>
                    </div>
                  </div>
                </button>
                <a
                  href={`${RSI_BASE_URL}/orgs/${o.sid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="shrink-0 rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-sky-300"
                  title="Open on RSI"
                >
                  <ExternalLink class="size-3.5" />
                </a>
              </div>

              {#if isOpen}
                <div class="border-t border-slate-800 bg-slate-950/40 p-2">
                  {#if state?.loading && !state?.fetched}
                    <div class="flex h-20 items-center justify-center text-slate-500">
                      <Loader2 class="size-4 animate-spin" />
                    </div>
                  {:else if state?.error}
                    <div
                      class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-2 text-[11px] text-rose-200"
                    >
                      <AlertTriangle class="mt-0.5 size-3.5 shrink-0" />
                      <div class="min-w-0 flex-1 break-all">{state.error}</div>
                      <button
                        type="button"
                        class="shrink-0 rounded px-2 py-0.5 text-[10px] text-rose-300 hover:bg-rose-900/40"
                        onclick={() => refreshMembers(o.sid)}>Retry</button
                      >
                    </div>
                  {:else if state?.fetched}
                    <div class="mb-1.5 flex items-center justify-between px-1">
                      <p class="text-[10px] uppercase tracking-wider text-slate-500">
                        {state.members.length} visible
                        {#if state.totalRows > state.members.length}
                          <span
                            class="text-slate-600"
                            title="Members who have set their org visibility to Redacted are not listed publicly. Only members they explicitly show are reachable from the public roster."
                          >
                            / {state.totalRows} total ({state.totalRows - state.members.length} redacted)
                          </span>
                        {/if}
                        {#if state.fromCache}
                          <span class="ml-1 inline-flex items-center gap-0.5 text-slate-600">
                            <Database class="size-2.5" /> cached
                          </span>
                        {/if}
                      </p>
                      <button
                        type="button"
                        class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
                        disabled={state.loading}
                        onclick={() => refreshMembers(o.sid)}
                        title="Refresh members"
                      >
                        <RefreshCw class="size-2.5 {state.loading ? 'animate-spin' : ''}" />
                      </button>
                    </div>
                    {#if state.members.length === 0}
                      <p class="p-3 text-center text-[11px] italic text-slate-500">
                        No visible members.
                      </p>
                    {:else}
                      <ul class="grid grid-cols-1 gap-1 md:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4 4xl:grid-cols-5">
                        {#each state.members as m (m.nickname)}
                          <li>
                            <a
                              href={m.profileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              class="flex items-center gap-2 rounded bg-slate-900/60 p-1.5 ring-1 ring-inset ring-slate-800 transition hover:ring-sky-600"
                            >
                              <div
                                class="size-8 shrink-0 overflow-hidden rounded-full bg-slate-950 ring-1 ring-slate-800"
                              >
                                {#if m.avatar}
                                  <img
                                    src={m.avatar}
                                    alt=""
                                    loading="lazy"
                                    class="size-full object-cover"
                                  />
                                {:else}
                                  <div
                                    class="flex size-full items-center justify-center text-slate-700"
                                  >
                                    <User class="size-4" />
                                  </div>
                                {/if}
                              </div>
                              <div class="min-w-0 flex-1">
                                <p class="truncate text-[11px] font-medium text-slate-100">
                                  {m.displayName}
                                </p>
                                <p class="flex items-center gap-1 truncate text-[10px] text-slate-500">
                                  <span class="truncate font-mono">{m.nickname}</span>
                                  {#if m.levelNumber > 0}
                                    <span class="flex shrink-0 gap-0.5">
                                      {#each [1, 2, 3, 4, 5] as n (n)}
                                        <span
                                          class="size-1 rounded-full {n <= m.levelNumber
                                            ? 'bg-sky-500'
                                            : 'bg-slate-700'}"
                                        ></span>
                                      {/each}
                                    </span>
                                  {/if}
                                </p>
                                {#if m.rank}
                                  <p class="truncate text-[9px] uppercase tracking-wider text-slate-600">
                                    {m.rank}
                                  </p>
                                {/if}
                              </div>
                            </a>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:else if tab === 'invitations'}
      {#if invitationsError}
        <div
          class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
        >
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Failed to load invitations</p>
            <p class="mt-1 break-all text-rose-300/80">{invitationsError}</p>
          </div>
        </div>
      {:else if invitationsLoading && invitations.length === 0}
        <div class="flex h-full items-center justify-center text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if invitations.length === 0}
        <div class="mt-6 flex flex-col items-center gap-2 text-center">
          <Inbox class="size-8 text-slate-700" />
          <p class="text-xs italic text-slate-500">No pending invitations.</p>
          <a
            href={`${RSI_BASE_URL}/community/orgs`}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
          >
            Browse the Organizations hub
            <ExternalLink class="size-3" />
          </a>
        </div>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each invitations as o (o.sid)}
            <li class="flex items-center gap-3 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800">
              <div class="size-12 shrink-0 overflow-hidden rounded bg-slate-950 ring-1 ring-slate-800">
                {#if o.logo}
                  <img src={o.logo} alt="" loading="lazy" class="size-full object-cover" />
                {:else}
                  <div class="flex size-full items-center justify-center text-slate-700">
                    <Building2 class="size-6" />
                  </div>
                {/if}
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-slate-100">{o.name}</p>
                <p class="truncate text-[11px] text-slate-500">
                  <span class="font-mono text-slate-400">{o.sid}</span>
                  {#if o.memberCount > 0}
                    · <Users class="inline size-2.5" /> {o.memberCount}
                  {/if}
                </p>
              </div>
              <!-- Accept / Decline are management actions — we deep-link to
                   the RSI page where the user can complete the action. -->
              <a
                href={`${RSI_BASE_URL}/account/organization/invitations`}
                target="_blank"
                rel="noopener noreferrer"
                class="shrink-0 rounded border border-sky-700/50 bg-sky-950/30 px-2 py-1 text-[10px] font-semibold text-sky-200 transition hover:bg-sky-900/40"
                title="Accept or decline on RSI"
              >
                Review
                <ExternalLink class="inline size-2.5" />
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if tab === 'applications'}
      {#if applicationsError}
        <div
          class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
        >
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Failed to load applications</p>
            <p class="mt-1 break-all text-rose-300/80">{applicationsError}</p>
          </div>
        </div>
      {:else if applicationsLoading && applications.length === 0}
        <div class="flex h-full items-center justify-center text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if applications.length === 0}
        <div class="mt-6 flex flex-col items-center gap-2 text-center">
          <Send class="size-8 text-slate-700" />
          <p class="text-xs italic text-slate-500">You have no active applications.</p>
          <a
            href={`${RSI_BASE_URL}/community/orgs`}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
          >
            Find an organization to join
            <ExternalLink class="size-3" />
          </a>
        </div>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each applications as o (o.sid)}
            <li class="flex items-center gap-3 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800">
              <div class="size-12 shrink-0 overflow-hidden rounded bg-slate-950 ring-1 ring-slate-800">
                {#if o.logo}
                  <img src={o.logo} alt="" loading="lazy" class="size-full object-cover" />
                {:else}
                  <div class="flex size-full items-center justify-center text-slate-700">
                    <Building2 class="size-6" />
                  </div>
                {/if}
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-slate-100">{o.name}</p>
                <p class="truncate text-[11px] text-slate-500">
                  <span class="font-mono text-slate-400">{o.sid}</span>
                  {#if o.memberCount > 0}
                    · <Users class="inline size-2.5" /> {o.memberCount}
                  {/if}
                </p>
              </div>
              <a
                href={`${RSI_BASE_URL}/orgs/${o.sid}`}
                target="_blank"
                rel="noopener noreferrer"
                class="shrink-0 rounded border border-amber-700/50 bg-amber-950/30 px-2 py-1 text-[10px] font-semibold text-amber-200 transition hover:bg-amber-900/40"
                title="Open org page on RSI"
              >
                Pending
                <ExternalLink class="inline size-2.5" />
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</section>
