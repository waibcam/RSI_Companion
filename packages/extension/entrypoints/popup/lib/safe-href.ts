// Whitelist-based scheme guard for `<a href>` values that come from
// untrusted sources (RSI API responses — Galactapedia markdown, Spectrum
// rich text, Comm-Link links, etc.).
//
// Even though our render-side click handlers already validate hostnames
// before navigating, the raw `href=` attribute remains exploitable in
// two paths:
//   1. middle-click / cmd-click — bypass our click handler entirely,
//      browser opens whatever scheme is in `href`.
//   2. context menu "Open in new tab" — same bypass.
// A `javascript:`/`data:text/html;base64,…`/`vbscript:` href would
// then execute. A reflected RSI vuln (or a future RSI-side editor
// that lets users write hyperlinks) would chain into our DOM.
//
// We whitelist three schemes:
//   - http:    (legacy non-TLS — RSI redirects, but external links
//              we render might be on http-only sites).
//   - https:   (the overwhelming majority of useful links).
//   - mailto:  (Galactapedia text occasionally embeds contact-style
//              addresses; harmless and useful to preserve).
//
// Anything else — including `javascript:`, `data:`, `file:`,
// `vbscript:`, custom schemes — collapses to `about:blank#blocked`.
// `about:blank` is a no-op navigation in every browser and the
// `#blocked` fragment makes it easy to spot in DevTools / network
// logs if someone reports a "click does nothing" bug.
//
// Relative / fragment hrefs (`/path`, `#section`, `?q=…`) are accepted
// as-is — the URL parser would treat them as same-origin which is the
// expected interpretation in our extension popup.

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const BLOCKED_FALLBACK = 'about:blank#blocked';

/** Sanitises an untrusted `href` value to a string safe for `<a href>`.
 *  Returns the original href when the scheme is on the allow-list, a
 *  no-op `about:blank` URL otherwise. Pass-through for relative URLs
 *  and empty/null inputs. */
export function safeHref(href: string | null | undefined): string {
  if (!href) return BLOCKED_FALLBACK;
  const trimmed = href.trim();
  if (trimmed.length === 0) return BLOCKED_FALLBACK;

  // Relative URL (no scheme): allow as-is. Fragment / path / query
  // forms all start with `#`, `/`, `?` or a non-scheme character
  // (no colon before the first `/`).
  // We detect the absolute case by trying to match `scheme:` at the
  // start — case-insensitive, must be ASCII letters/digits per RFC 3986.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!schemeMatch) return trimmed;

  const scheme = (schemeMatch[1] ?? '').toLowerCase() + ':';
  if (ALLOWED_SCHEMES.has(scheme)) return trimmed;

  return BLOCKED_FALLBACK;
}
