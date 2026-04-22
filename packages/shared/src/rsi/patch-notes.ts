// Patch notes are a filtered view of the Comm-Link listing. `/en/patch-notes`
// serves the same hub-block HTML as `/en/comm-link` but constrained to the
// "Patch Notes" type. We reuse the Comm-Link parser and just post-process to
// pick out the channel (LIVE / PTU / EPTU / TECH-PREVIEW / 4.X) from the title.
//
// Examples of titles we parse:
//   "Star Citizen Alpha 4.7"        -> channel: LIVE, version: 4.7
//   "Star Citizen Alpha 4.7.1 EPTU" -> channel: EPTU, version: 4.7.1
//   "Star Citizen Alpha 3.24.2 PTU" -> channel: PTU, version: 3.24.2

import { RSI_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';
import { parseCommLinkListing, type CommLinkArticle } from './commlink.js';

export type PatchChannel = 'LIVE' | 'PTU' | 'EPTU' | 'TECH-PREVIEW' | 'UNKNOWN';

export interface PatchNote extends CommLinkArticle {
  version: string | null;
  channel: PatchChannel;
}

const CHANNEL_ORDER: PatchChannel[] = ['TECH-PREVIEW', 'EPTU', 'PTU', 'LIVE'];

function detectChannel(title: string): PatchChannel {
  const upper = title.toUpperCase();
  for (const ch of CHANNEL_ORDER) {
    if (upper.includes(ch)) return ch;
  }
  // No explicit channel label usually means the LIVE patch.
  if (/ALPHA\s+\d/.test(upper)) return 'LIVE';
  return 'UNKNOWN';
}

function detectVersion(title: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[a-z])?)/i.exec(title);
  return m?.[1] ?? null;
}

export function parsePatchNotesListing(html: string): PatchNote[] {
  return parseCommLinkListing(html).articles.map((a) => ({
    ...a,
    version: detectVersion(a.title),
    channel: detectChannel(a.title),
  }));
}

export async function fetchPatchNotes(page = 1): Promise<PatchNote[]> {
  const url = `${RSI_BASE_URL}/en/patch-notes?page=${encodeURIComponent(String(page))}`;
  const response = await fetchWithTimeout(url, {
    credentials: 'omit',
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!response.ok) {
    throw new Error(`patch-notes page ${page} returned ${response.status}`);
  }
  const html = await response.text();
  return parsePatchNotesListing(html);
}
