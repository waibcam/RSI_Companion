// Direct-to-RSI roadmap fetcher. The legacy v2 backend used to proxy the
// RSI `/api/roadmap/v1/boards/<id>` endpoint and layer its own server-side
// snapshot history on top of it. v3 keeps the snapshot/diff logic entirely
// client-side (see `roadmap.snapshot` messages in the background worker),
// so the backend was left as a pure passthrough.
//
// Now that we know the endpoint still answers publicly with the same
// shape, we can skip the middleman and hit RSI directly. That drops the
// `rsi-companion.kamille.ovh` host-permission and removes the last
// runtime dependency on any personal server.

import { z } from 'zod';
import { RSI_BASE_URL, DEFAULT_ROADMAP_BOARD_ID } from '../constants.js';
import { fetchWithTimeout } from '../net.js';
import { RoadmapPayload, type RoadmapPayload as RoadmapPayloadType } from '../schemas/backend.js';

// The RSI roadmap response wraps the payload in an envelope
// `{success, code, msg, data}`. We only need the inner `data`.
const RoadmapEnvelope = z.object({
  success: z.coerce.number().int().default(1),
  code: z.string().default(''),
  msg: z.string().default(''),
  data: z.record(z.unknown()).nullable().optional(),
});

export interface RoadmapFetchResult {
  data: RoadmapPayloadType;
  /** RSI's `last_updated` timestamp (seconds since epoch). Lets the
   *  client dedupe identical snapshots across refreshes. */
  snapshotTs: number;
  /** When the extension received this payload (ms since epoch). */
  fetchedAt: number;
}

export async function fetchRsiRoadmap(
  boardId: number = DEFAULT_ROADMAP_BOARD_ID,
): Promise<RoadmapFetchResult> {
  const url = `${RSI_BASE_URL}/api/roadmap/v1/boards/${encodeURIComponent(String(boardId))}`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`roadmap: ${response.status}`);
  }
  const raw = (await response.json()) as unknown;
  const envelope = RoadmapEnvelope.safeParse(raw);
  if (!envelope.success) {
    throw new Error(`roadmap: unexpected envelope shape (${envelope.error.message})`);
  }
  if (envelope.data.success !== 1) {
    throw new Error(`roadmap: server returned success=${envelope.data.success} code=${envelope.data.code}`);
  }
  const inner = envelope.data.data ?? {};
  const data = RoadmapPayload.parse(inner);
  const snapshotTs =
    typeof inner.last_updated === 'number'
      ? Math.floor(inner.last_updated)
      : Math.floor(Date.now() / 1000);
  return { data, snapshotTs, fetchedAt: Date.now() };
}
