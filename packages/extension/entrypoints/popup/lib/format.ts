// Shared formatting helpers. Every module had its own subtly different
// copy — collected here so fixes land once.

// ---------- time --------------------------------------------------------

/** Relative time from now, compact form: "just now", "5m", "3h", "2d", "1mo". */
export function timeAgo(when: string | number | null | undefined): string {
  const secs = toEpochSeconds(when);
  if (!secs) return '';
  const diff = Math.max(0, Date.now() / 1000 - secs);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 2592000)}mo`;
}

/** Relative time until a future timestamp: "in 5m", "in 3h", "in 2d". */
export function timeUntil(when: string | number | null | undefined): string {
  const secs = toEpochSeconds(when);
  if (!secs) return '';
  const diff = Math.max(0, secs - Date.now() / 1000);
  if (diff < 3600) return `in ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `in ${Math.floor(diff / 3600)}h`;
  if (diff < 2592000) return `in ${Math.floor(diff / 86400)}d`;
  return `in ${Math.floor(diff / 2592000)}mo`;
}

/** Long-form date: "Apr 18, 2026". Accepts ISO strings or epoch seconds. */
export function formatDate(when: string | number | null | undefined): string {
  const secs = toEpochSeconds(when);
  if (!secs) return '';
  return new Date(secs * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

function toEpochSeconds(when: string | number | null | undefined): number {
  if (when == null || when === '') return 0;
  if (typeof when === 'number') return when > 1e12 ? Math.floor(when / 1000) : when;
  const ts = new Date(when).getTime();
  return isNaN(ts) ? 0 : Math.floor(ts / 1000);
}

// ---------- numbers -----------------------------------------------------

/** Compact viewer/follower counts: 123 / 1.2k / 45k. */
export function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Abbreviated big numbers: 1.2M / 45K / 123. Used for backer counts. */
export function formatAbbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ---------- currency ----------------------------------------------------

/** Always two decimals: $1,234.56. Input in dollars (not cents). */
export function formatUsd(dollars: number): string {
  return `$${dollars.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Funds raised display: $1.2M / $45K / $123. Input in CENTS. */
export function formatUsdCompact(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  return `$${dollars.toFixed(0)}`;
}

// ---------- avatar fallback ----------------------------------------------

// 8 distinct gradient pairs — picked to be readable on the dark UI and
// distinct from each other at a glance. The hash-to-index mapping is
// deterministic so the same nickname always renders with the same colour
// (helps recognition in feeds where the same author shows up multiple times).
const AVATAR_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ['from-sky-700', 'to-indigo-700'],
  ['from-emerald-700', 'to-teal-700'],
  ['from-amber-700', 'to-orange-700'],
  ['from-rose-700', 'to-pink-700'],
  ['from-violet-700', 'to-fuchsia-700'],
  ['from-cyan-700', 'to-blue-700'],
  ['from-lime-700', 'to-emerald-700'],
  ['from-red-700', 'to-rose-700'],
];

/** Author avatar fallback when no thumbnail URL is available. Returns short
 *  initials (1–2 chars) and a stable Tailwind gradient class pair derived
 *  from the source string. The two strings get concatenated so that an
 *  author with a fancy display name + plain nickname still hashes the same
 *  way regardless of which one we pass in first. */
export function avatarFallback(
  primary: string,
  secondary = '',
): { initials: string; gradientFrom: string; gradientTo: string } {
  const source = `${primary}${secondary}`.trim();
  const initials = (() => {
    const trimmed = primary.trim();
    if (!trimmed) return '?';
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words[0] && words[1]) {
      return (words[0][0]! + words[1][0]!).toUpperCase();
    }
    return trimmed.slice(0, 2).toUpperCase();
  })();
  // Tiny stable hash — sum of char codes is plenty for an 8-bucket palette.
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (hash + source.charCodeAt(i)) % 1000;
  const [from, to] = AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length]!;
  return { initials, gradientFrom: from, gradientTo: to };
}
