// Focus trap action for modal dialogs and drawers.
//
// Used by:
//   - App.svelte           — Release Notes drawer
//   - Roadmap.svelte       — card-detail dialog
//   - Ships.svelte         — ship-detail dialog
//   - Spectrum.svelte      — emoji picker / thread dialog
//
// Without this, hitting Tab inside an open dialog would let focus
// escape to the underlying page (sidebar, header buttons), which:
//   1. lets keyboard-only users land on controls hidden behind the
//      backdrop they can't see (a11y bug),
//   2. lets screen-readers announce content from the suppressed
//      surface (semantic noise).
//
// Usage in a Svelte 5 component:
//
//     <div use:focusTrap role="dialog" aria-modal="true"> ... </div>
//
// The action:
//   1. snapshots `document.activeElement` at mount,
//   2. focuses the first tabbable descendant on next frame,
//   3. installs a `keydown` listener that loops Tab / Shift+Tab
//      between the first and last tabbable descendants,
//   4. restores the original focus on unmount.
//
// We re-query the tabbable list on each Tab keypress rather than
// caching it: dialog contents can change (filters mutate visible
// items, tabs swap views, async loads add controls), and a stale
// snapshot would skip newly-mounted controls or dereference removed
// ones. Cost is one querySelectorAll per Tab — negligible.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'details > summary:first-of-type',
  'audio[controls]',
  'video[controls]',
  'iframe',
].join(', ');

function getTabbables(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  // Filter out elements that are display:none / visibility:hidden /
  // inside an aria-hidden subtree. `offsetParent === null` covers the
  // common cases (display:none ancestor, fixed-positioned elements
  // are an edge case but not relevant here — dialogs aren't fixed
  // children of fixed elements in this codebase).
  return candidates.filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.tabIndex !== -1 &&
      el.offsetParent !== null,
  );
}

/** Svelte action: traps Tab inside the host element while it's mounted,
 *  and restores focus to whoever had it before mount when destroyed. */
export function focusTrap(node: HTMLElement) {
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // Defer the initial focus by one frame so the dialog's content
  // (which may include a mount-time `$effect` that wires up controls)
  // has settled before we query for tabbables.
  requestAnimationFrame(() => {
    const tabbables = getTabbables(node);
    const first = tabbables[0];
    if (first) {
      first.focus();
    } else {
      // No focusable child — focus the dialog itself so keyboard users
      // are at least anchored inside it. Requires `tabindex="-1"` on
      // the host; we don't enforce it here since most callers already
      // have one for Esc handling.
      node.focus();
    }
  });

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const tabbables = getTabbables(node);
    if (tabbables.length === 0) {
      // Nothing to cycle to — keep focus on the dialog.
      event.preventDefault();
      return;
    }
    const first = tabbables[0]!;
    const last = tabbables[tabbables.length - 1]!;
    const active = document.activeElement;

    if (event.shiftKey) {
      if (active === first || !node.contains(active)) {
        last.focus();
        event.preventDefault();
      }
    } else {
      if (active === last || !node.contains(active)) {
        first.focus();
        event.preventDefault();
      }
    }
  }

  node.addEventListener('keydown', onKeyDown);

  return {
    destroy() {
      node.removeEventListener('keydown', onKeyDown);
      // Restore focus to the trigger element (the button that opened
      // the dialog, typically). If it's been removed from the DOM
      // since (rare — only happens when the dialog itself dismounts
      // its trigger, e.g. switching modules), focus falls through to
      // <body> which the browser handles gracefully.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    },
  };
}
