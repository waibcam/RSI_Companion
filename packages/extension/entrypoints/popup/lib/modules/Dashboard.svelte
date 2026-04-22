<script lang="ts">
  import {
    sendRsiMessage,
    RSI_BASE_URL,
    type Rsi,
    type StatsSummaryResponse,
  } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    Award,
    Coins,
    ExternalLink,
    Loader2,
    Trophy,
    UserRound,
    Users,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import SignInPrompt from '../components/SignInPrompt.svelte';
  import { authState } from '../state.svelte';
  import { extractSignedIn, errorMessage } from '../error';

  type Summary = Rsi.DashboardSummary;

  let summary = $state<Summary | null>(null);
  let signedIn = $state<boolean | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let fromCache = $state(false);
  // Referral data lives under the `stats.summary` handler — fetched on the
  // side so the Dashboard module surfaces it without a second round trip.
  // The background caches both handlers independently so doing this in
  // parallel costs one cache-hit on warm opens.
  let stats = $state<StatsSummaryResponse | null>(null);

  async function load(force = false) {
    loading = true;
    error = null;
    try {
      const [dashRes, statsRes] = await Promise.all([
        sendRsiMessage({ type: 'dashboard.summary', force }),
        sendRsiMessage({ type: 'stats.summary', force }).catch(() => null),
      ]);
      summary = dashRes.summary;
      signedIn = dashRes.signedIn;
      fromCache = dashRes.fromCache;
      stats = statsRes;
    } catch (e) {
      error = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      loading = false;
    }
  }

  function formatCredit(c: Rsi.DashboardCredit): string {
    if (c.currency === 'USD') {
      const dollars = c.value / 100;
      return `${c.symbol}${dollars.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }
    return `${c.symbol}${c.value.toLocaleString()}`;
  }

  const QUICK_LINKS: ReadonlyArray<{ label: string; path: string }> = [
    { label: 'Hangar', path: '/account/pledges' },
    { label: 'Buy-back pledges', path: '/account/buy-back-pledges' },
    { label: 'Referral program', path: '/referral-program' },
    { label: 'Share referral code', path: '/en/referral' },
    { label: 'Subscription', path: '/account/subscription' },
    { label: 'My organizations', path: '/account/organization' },
  ];

  // Wait for the global auth resolution before firing the fetch — prevents
  // flashing "No dashboard data." while the auth state is still unknown.
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
  <ModuleHeader title="Dashboard" {loading} {fromCache} onRefresh={() => load(true)} />

  <div class="flex-1 overflow-y-auto p-3">
    {#if authState.signedIn === false || signedIn === false}
      <SignInPrompt label="Dashboard" />
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
          <p class="font-semibold">Failed to load dashboard</p>
          <p class="mt-1 break-all text-rose-300/80">{error}</p>
        </div>
      </div>
    {:else if loading && !summary}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if summary}
      <div class="mx-auto flex max-w-3xl flex-col gap-2">
        <div
          class="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-2.5"
        >
          <div
            class="size-12 shrink-0 overflow-hidden rounded-full bg-slate-950 ring-1 ring-slate-800"
          >
            {#if summary.avatarUrl}
              <img src={summary.avatarUrl} alt="" class="size-full object-cover" />
            {:else}
              <div class="flex size-full items-center justify-center text-slate-700">
                <UserRound class="size-6" />
              </div>
            {/if}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <p class="truncate text-sm font-semibold text-slate-100">{summary.displayName}</p>
              <p class="truncate font-mono text-[11px] text-slate-500">@{summary.handle}</p>
            </div>
            <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0 text-[10px] text-slate-500">
              {#if summary.enlistedSince}
                <span>Enlisted {summary.enlistedSince.split(' ')[0]}</span>
              {/if}
              {#if summary.country}
                <span>· {summary.country}</span>
              {/if}
              {#if summary.subscriber}
                <span class="flex items-center gap-0.5 text-sky-300">
                  <Award class="size-3" />
                  {summary.subscriber.type}
                </span>
              {/if}
              <a
                href={`${RSI_BASE_URL}/citizens/${summary.handle}`}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-0.5 text-sky-400 hover:text-sky-300"
              >
                profile
                <ExternalLink class="size-2.5" />
              </a>
            </div>
          </div>
        </div>

        {#if summary.credits.length > 0 || summary.concierge.currentLevel || summary.concierge.nextLevel}
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {#if summary.credits.length > 0}
              <div class="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                <div class="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500">
                  <Coins class="size-3" />
                  Credits
                </div>
                <ul class="grid grid-cols-3 gap-1">
                  {#each summary.credits as c (c.variant)}
                    <li class="rounded border border-slate-800 bg-slate-950/40 px-1 py-1 text-center">
                      <p class="text-[9px] uppercase tracking-wider text-slate-500">{c.label}</p>
                      <p class="mt-0.5 font-mono text-[11px] font-semibold text-slate-100">
                        {formatCredit(c)}
                      </p>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}

            {#if summary.concierge.currentLevel || summary.concierge.nextLevel}
              <div class="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                <div class="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500">
                  <Trophy class="size-3" />
                  Concierge
                </div>
                <div class="flex items-center justify-between gap-2 text-[11px]">
                  <div class="min-w-0">
                    <p class="truncate font-semibold text-amber-300">{summary.concierge.currentLevel || '—'}</p>
                    {#if summary.concierge.nextLevel}
                      <p class="truncate text-[10px] text-slate-500">Next: {summary.concierge.nextLevel}</p>
                    {/if}
                  </div>
                  {#if summary.concierge.nextLevel}
                    <span class="font-mono text-[11px] text-slate-400">
                      {summary.concierge.nextLevelPercentage}%
                    </span>
                  {/if}
                </div>
                {#if summary.concierge.nextLevel}
                  <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-800">
                    <div
                      class="h-full bg-amber-400/80 transition-all"
                      style={`width: ${summary.concierge.nextLevelPercentage}%`}
                    ></div>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        <!--
          Referral card is intentionally link-only right now: the
          /referral-program page became a client-rendered SPA, so scraping
          recruits/prospects/progress stopped working. Showing the entry
          point keeps it discoverable until we switch to the GraphQL query
          that the new page uses (TODO in shared/src/rsi/stats.ts).
        -->
        {#if stats?.signedIn}
          {@const ref = stats.referral}
          <a
            href={`${RSI_BASE_URL}/referral-program`}
            target="_blank"
            rel="noopener noreferrer"
            class="block rounded-lg border border-slate-800 bg-slate-900/60 p-2 transition hover:border-sky-600"
          >
            <div class="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-slate-500">
              <span class="flex items-center gap-1">
                <Users class="size-3 text-violet-400" />
                Referral program
              </span>
              <span class="flex items-center gap-1 text-slate-400">
                Open on RSI
                <ExternalLink class="size-2.5" />
              </span>
            </div>
            {#if ref && (ref.recruits > 0 || ref.prospects > 0 || ref.progressTarget > 0)}
              <div class="flex items-center justify-between gap-3 text-[11px]">
                <div class="flex gap-3">
                  <div>
                    <p class="text-[9px] uppercase tracking-wider text-slate-500">Recruits</p>
                    <p class="font-mono text-sm font-semibold text-violet-200">{ref.recruits}</p>
                  </div>
                  {#if ref.prospects > 0}
                    <div>
                      <p class="text-[9px] uppercase tracking-wider text-slate-500">Prospects</p>
                      <p class="font-mono text-sm font-semibold text-slate-300">{ref.prospects}</p>
                    </div>
                  {/if}
                </div>
                {#if ref.progressTarget > 0}
                  <div class="min-w-0 flex-1">
                    <div class="mb-1 flex items-center justify-between text-[10px] text-slate-500">
                      <span class="font-mono text-slate-300">{ref.progressCurrent}/{ref.progressTarget}{ref.nextRank ? ' · ' + ref.nextRank : ''}</span>
                    </div>
                    <div class="h-1 overflow-hidden rounded-full bg-slate-800">
                      <div
                        class="h-full bg-violet-400/80 transition-all"
                        style={`width: ${Math.min(100, (ref.progressCurrent / ref.progressTarget) * 100)}%`}
                      ></div>
                    </div>
                  </div>
                {/if}
              </div>
            {:else}
              <p class="text-[10px] text-slate-500">
                Invite friends, earn rewards. Live stats aren't pulled yet — click to open your dashboard on RSI.
              </p>
            {/if}
          </a>
        {/if}

        {#if summary.badges.length > 0}
          <div class="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
            <p class="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Badges</p>
            <ul class="flex flex-wrap gap-1">
              {#each summary.badges as b (b.title + (b.href ?? ''))}
                <li>
                  <a
                    href={b.href ?? '#'}
                    target={b.href ? '_blank' : '_self'}
                    rel="noopener noreferrer"
                    class="flex items-center gap-1.5 rounded border border-slate-800 bg-slate-950/40 px-1.5 py-0.5 text-[10px] text-slate-300 transition hover:border-sky-600 hover:text-sky-300"
                    class:pointer-events-none={!b.href}
                    title={b.title}
                  >
                    {#if b.image}
                      <img src={b.image} alt="" class="size-4 rounded-sm object-contain" />
                    {/if}
                    <span class="truncate">{b.title}</span>
                  </a>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        <ul class="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {#each QUICK_LINKS as link (link.path + link.label)}
            <li>
              <a
                href={`${RSI_BASE_URL}${link.path}`}
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-center justify-between gap-1 rounded border border-slate-800 bg-slate-900/60 px-2 py-1.5 text-[11px] text-slate-200 transition hover:border-sky-600 hover:text-sky-300"
              >
                <span class="truncate">{link.label}</span>
                <ExternalLink class="size-3 shrink-0 text-slate-500" />
              </a>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <p class="mt-6 text-center text-xs italic text-slate-500">No dashboard data.</p>
    {/if}
  </div>
</section>
