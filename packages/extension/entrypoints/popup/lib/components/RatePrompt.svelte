<script lang="ts">
  import {
    ArrowUp,
    Heart,
    Star,
    ThumbsDown,
    ThumbsUp,
    X,
  } from 'lucide-svelte';
  import {
    COMMUNITY_HUB_POST_URL,
    storeName,
    storeReviewUrl,
  } from '../links';
  import { appState, ratePromptState } from '../state.svelte';

  // "Do you like the extension?" prompt.
  //
  // Surfaces a small banner under StatusBanner once the user has had
  // time to actually try the extension (≥ 7 days from first install
  // AND ≥ 5 popup opens — gates enforced by `ratePromptState.shouldShow`).
  //
  // Three views:
  //   ask              — initial prompt with thumbs up / down / "Ask me later".
  //   thanks-positive  — after thumbs up. Two CTAs: upvote on Community Hub,
  //                      rate on the relevant browser store.
  //   (thumbs down)    — no separate view: we record the response and
  //                      jump the user to the Support module so they can
  //                      file a bug or hit Discord. Banner closes itself.
  //
  // Design constraints:
  //   - NEVER auto-vote / auto-comment on the user's behalf. Both CH
  //     upvote and store rating open in a new tab — the user clicks
  //     naturally on the destination. Avoids any whiff of engagement-
  //     gaming and stays inside what AMO / Chrome Web Store expect of
  //     a well-behaved extension.
  //   - Persistent dismissal: once the user picks 'liked' / 'disliked'
  //     / 'never', the banner is gone forever. 'snoozed' re-arms after
  //     7 days. State lives in localStorage via ratePromptState.

  // ---- View state ---------------------------------------------------------

  type View = 'ask' | 'thanks-positive';
  let view = $state<View>('ask');

  function clickedThumbsUp(): void {
    // Don't record 'liked' yet — that comes after the user actually
    // takes one of the two action buttons (or dismisses the panel).
    // Switching the view is the only effect for now.
    view = 'thanks-positive';
  }

  function clickedThumbsDown(): void {
    // Record immediately so the prompt doesn't reappear, then ship
    // the user over to Support where they can file an issue. We
    // don't open a confirmation step — the negative response is the
    // signal, and the Support module is where useful follow-up
    // happens.
    ratePromptState.setResponse('disliked');
    appState.setActiveModule('support');
  }

  function clickedLater(): void {
    ratePromptState.setResponse('snoozed');
  }

  function clickedNever(): void {
    ratePromptState.setResponse('never');
  }

  function openCommunityHub(): void {
    // Open in a new tab. The user's explicit click on the page is
    // the upvote signal — we never POST to RSI's API on their behalf.
    window.open(COMMUNITY_HUB_POST_URL, '_blank', 'noopener');
    ratePromptState.setResponse('liked');
  }

  function openStoreReview(): void {
    window.open(storeReviewUrl(), '_blank', 'noopener');
    ratePromptState.setResponse('liked');
  }

  function dismissPositive(): void {
    // User got the panel but didn't take action. Still treat as
    // 'liked' so we don't pester them again.
    ratePromptState.setResponse('liked');
  }
</script>

{#if ratePromptState.shouldShow}
  {#if view === 'ask'}
    <!-- Initial banner. Compact, single row, dismissable.
         Sits between StatusBanner and the main content area in
         App.svelte so it shares the top-of-popup attention budget
         without stealing it from urgent status info. -->
    <div
      class="flex items-center gap-2 border-b border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-[11px] text-sky-100"
      role="status"
    >
      <Heart class="size-3.5 shrink-0 text-pink-300" />
      <span class="flex-1 leading-tight">
        Enjoying RSI Companion? Your feedback helps a lot.
      </span>
      <button
        type="button"
        onclick={clickedThumbsUp}
        class="flex shrink-0 items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-emerald-200 ring-1 ring-emerald-500/40 transition hover:bg-emerald-500/30"
        title="Yes, I like it"
      >
        <ThumbsUp class="size-3" />
        Yes
      </button>
      <button
        type="button"
        onclick={clickedThumbsDown}
        class="flex shrink-0 items-center gap-1 rounded bg-rose-500/20 px-2 py-0.5 text-rose-200 ring-1 ring-rose-500/40 transition hover:bg-rose-500/30"
        title="No — open Support to send feedback"
      >
        <ThumbsDown class="size-3" />
        Not really
      </button>
      <button
        type="button"
        onclick={clickedLater}
        class="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-sky-200/80 transition hover:bg-sky-500/20 hover:text-sky-100"
        title="Ask me again in a week"
      >
        Later
      </button>
      <button
        type="button"
        onclick={clickedNever}
        class="shrink-0 rounded p-0.5 text-sky-200/60 transition hover:bg-sky-500/20 hover:text-sky-100"
        title="Don't ask again"
        aria-label="Don't ask again"
      >
        <X class="size-3" />
      </button>
    </div>
  {:else if view === 'thanks-positive'}
    <!-- "Thanks for the love" panel. Two equal-weight actions plus
         a quiet dismiss. The CH upvote is presented first because
         that's the primary maintainer benefit — store ratings are
         secondary (the listing already has solid reviews; what's
         missing on the CH side is upvote volume). -->
    <div
      class="flex flex-col gap-2 border-b border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-100 sm:flex-row sm:items-center"
      role="status"
    >
      <Heart class="size-3.5 shrink-0 text-pink-300 sm:self-center" />
      <span class="flex-1 leading-tight">
        Thanks! If you have 30 seconds, the best way to help is one of:
      </span>
      <div class="flex shrink-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          onclick={openCommunityHub}
          class="flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-amber-200 ring-1 ring-amber-500/40 transition hover:bg-amber-500/30"
          title="Opens the RSI Community Hub post — click Upvote there"
        >
          <ArrowUp class="size-3" />
          Upvote on RSI
        </button>
        <button
          type="button"
          onclick={openStoreReview}
          class="flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-emerald-200 ring-1 ring-emerald-500/40 transition hover:bg-emerald-500/30"
          title="Opens the {storeName()} listing — leave a quick rating or review"
        >
          <Star class="size-3" />
          Rate on {storeName()}
        </button>
        <button
          type="button"
          onclick={dismissPositive}
          class="shrink-0 rounded p-0.5 text-sky-200/60 transition hover:bg-sky-500/20 hover:text-sky-100"
          title="Close"
          aria-label="Close"
        >
          <X class="size-3" />
        </button>
      </div>
    </div>
  {/if}
{/if}

