// Friend/contacts list + pending friend requests + member search + actions.
//
// RSI killed the old /api/contacts/list endpoint (now 404). The current
// spectrum identify response carries both `friends` and `friend_requests`
// (in + out), so we read contacts and pending state from the same call the
// legacy 0.2.14 extension used.
//
// Actions (accept/decline/cancel/create/remove) POST to the Spectrum API and
// require the RSI-Token on both x-rsi-token and x-tavern-id headers.

import { z } from 'zod';
import { RSI_BASE_URL, RSI_PTU_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';
import {
  assertRsiOk,
  identifyFull,
  identifyPtu,
  requirePtuToken,
  requireToken,
  RsiNotAuthenticatedError,
} from './auth.js';

export const Contact = z.object({
  nickname: z.string(),
  displayname: z.string().nullable().default(''),
  avatar: z.string().nullable().default(''),
});
export type Contact = z.infer<typeof Contact>;

export const ContactRequest = z.object({
  id: z.number().int(),
  /** 'in' = received (accept/decline), 'out' = sent (cancel). */
  direction: z.enum(['in', 'out']),
  nickname: z.string(),
  displayname: z.string().default(''),
  avatar: z.string().default(''),
});
export type ContactRequest = z.infer<typeof ContactRequest>;

export const ContactsBundle = z.object({
  contacts: z.array(Contact),
  incoming: z.array(ContactRequest),
  outgoing: z.array(ContactRequest),
});
export type ContactsBundle = z.infer<typeof ContactsBundle>;

/** Resolve the counterparty member on a friend_request entry. RSI
 *  populates either `r.member` (legacy / incoming-on-LIVE) or
 *  `r.members[]` (newer shape / outgoing-on-PTU) depending on the
 *  endpoint and direction. We try the singular field first, then scan
 *  the array for the first member that isn't us. Returning null means
 *  the entry is unusable (no counterparty to display) and the caller
 *  should skip it.
 *
 *  Reported by @DeusMaximus in #43: PTU's outgoing friend_requests
 *  populated only `r.members[]`, so the previous `r.member`-only code
 *  silently dropped every outgoing request, which then made the
 *  Sync LIVE → PTU pre-classification miss already-pending entries.
 *  Those got re-sent and the server returned ErrExistingPendingFriendRequest,
 *  which the workflow bucketed as plain ERROR. */
type FriendMemberish = {
  id?: number;
  nickname?: string;
  displayname?: string | null;
  avatar?: string | null;
};
function pickCounterparty(
  r: {
    member?: FriendMemberish | null;
    members?: ReadonlyArray<FriendMemberish> | null;
  },
  myId: number,
): FriendMemberish | null {
  if (r.member?.nickname) return r.member;
  for (const m of r.members ?? []) {
    if (m.nickname && (m.id ?? 0) !== myId) return m;
  }
  return null;
}

export async function fetchContactsBundle(): Promise<ContactsBundle> {
  const data = await identifyFull();
  if (!data) throw new RsiNotAuthenticatedError();
  const myId = data.member?.id ?? 0;

  const contacts: Contact[] = [];
  for (const f of data.friends ?? []) {
    if (!f.nickname) continue;
    contacts.push({
      nickname: f.nickname,
      displayname: f.displayname ?? '',
      avatar: f.avatar ?? '',
    });
  }
  contacts.sort((a, b) =>
    (a.displayname || a.nickname).localeCompare(b.displayname || b.nickname),
  );

  const incoming: ContactRequest[] = [];
  const outgoing: ContactRequest[] = [];
  for (const r of data.friend_requests ?? []) {
    const member = pickCounterparty(r, myId);
    if (!member?.nickname) continue;
    const req: ContactRequest = {
      id: r.id,
      direction: r.type === 'out' ? 'out' : 'in',
      nickname: member.nickname,
      displayname: member.displayname ?? '',
      avatar: member.avatar ?? '',
    };
    if (req.direction === 'out') outgoing.push(req);
    else incoming.push(req);
  }

  return { contacts, incoming, outgoing };
}

// Kept for backward-compat with the old `contacts.list` shape.
export async function fetchContactsList(): Promise<Contact[]> {
  const bundle = await fetchContactsBundle();
  return bundle.contacts;
}

// --- member search -------------------------------------------------------

export const MemberHit = z.object({
  id: z.coerce.number().int(),
  nickname: z.string(),
  displayname: z.string().default(''),
  avatar: z.string().default(''),
});
export type MemberHit = z.infer<typeof MemberHit>;

// Wire shape for /api/spectrum/search/member/autocomplete.
//
// Pre-2026-04: `data` was the array of members directly.
// Current     : `data` is a paginated envelope and the array lives at
//               `data.members`. The envelope also carries `hits`
//               (Elasticsearch raw), `page`, `pagesize`, `pages_total`
//               that we don't surface. Reported by @DeusMaximus
//               in #42 with a sanitised dump.
const RawAutocompleteMember = z.object({
  id: z.coerce.number().int(),
  nickname: z.string(),
  displayname: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
});

const MemberAutocompleteResponse = z.object({
  success: z.number().int(),
  code: z.string().nullable().optional(),
  msg: z.string().nullable().optional(),
  data: z
    .object({
      members: z.array(RawAutocompleteMember).nullable().optional(),
    })
    .nullable()
    .optional(),
});

async function spectrumPost<T>(path: string, body: unknown): Promise<T> {
  const token = await requireToken();
  const response = await fetchWithTimeout(`${RSI_BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-rsi-token': token,
      'x-tavern-id': token,
    },
    body: JSON.stringify(body),
  });
  assertRsiOk(response, path);
  return (await response.json()) as T;
}

export async function searchMembers(query: string): Promise<MemberHit[]> {
  const text = query.trim();
  if (text.length < 2) return [];
  const raw = await spectrumPost<unknown>('/api/spectrum/search/member/autocomplete', {
    community_id: null,
    ignore_self: true,
    text,
  });
  const parsed = MemberAutocompleteResponse.safeParse(raw);
  if (!parsed.success) {
    // Surface schema drift to the BG console so future RSI shape changes
    // don't silently empty the search box like the data-array→envelope
    // shift did between 1.2.x and 1.3.x.
    // eslint-disable-next-line no-console
    console.warn('[contacts] member autocomplete: unexpected shape', parsed.error.issues);
    return [];
  }
  if (parsed.data.success !== 1) {
    // Distinguish per-IP throttling from "no results" so callers (like
    // the PTU sync workflow) can back off and retry instead of treating
    // a transient failure as a hard "user not found". Other non-success
    // codes still resolve to [] for backward-compat with the autocomplete
    // box, which has no useful UI for distinguishing them.
    if (parsed.data.code === 'ErrThrottleLimit') {
      throw new RsiSpectrumActionError(
        '/api/spectrum/search/member/autocomplete',
        'ErrThrottleLimit',
        parsed.data.msg ?? 'throttled',
      );
    }
    return [];
  }
  return (parsed.data.data?.members ?? []).map((m) => ({
    id: m.id,
    nickname: m.nickname,
    displayname: m.displayname ?? '',
    avatar: m.avatar ?? '',
  }));
}

// --- actions -------------------------------------------------------------
//
// Spectrum returns a uniform { success, code, msg, data } envelope on
// every action endpoint. We surface `code` as a first-class field on the
// error class so callers can branch on machine-readable values
// (`ErrThrottleLimit`, `ErrExistingPendingFriendRequest`, …) instead of
// regexing the human-readable `msg`. Reported by @DeusMaximus in #43
// after the Sync LIVE → PTU workflow misclassified throttled and
// already-pending requests as plain ERROR because both came back as
// generic `Error(msg)`.

const SuccessResponse = z.object({
  success: z.number().int(),
  code: z.string().nullable().optional(),
  msg: z.string().nullable().optional(),
});

export class RsiSpectrumActionError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(path: string, code: string, msg: string) {
    super(msg || `${path}: ${code}`);
    this.name = 'RsiSpectrumActionError';
    this.code = code;
    this.path = path;
  }
}

async function spectrumAction(path: string, body: unknown): Promise<void> {
  const raw = await spectrumPost<unknown>(path, body);
  const parsed = SuccessResponse.safeParse(raw);
  if (!parsed.success) {
    throw new RsiSpectrumActionError(path, 'ErrInvalidResponse', 'invalid response');
  }
  if (parsed.data.success !== 1) {
    throw new RsiSpectrumActionError(
      path,
      parsed.data.code ?? 'ErrUnknown',
      parsed.data.msg ?? `${path} failed`,
    );
  }
}

export function acceptFriendRequest(requestId: number): Promise<void> {
  return spectrumAction('/api/spectrum/friend-request/accept', { request_id: requestId });
}

export function declineFriendRequest(requestId: number): Promise<void> {
  return spectrumAction('/api/spectrum/friend-request/decline', { request_id: requestId });
}

export function cancelFriendRequest(requestId: number): Promise<void> {
  return spectrumAction('/api/spectrum/friend-request/cancel', { request_id: requestId });
}

export function sendFriendRequest(memberId: number): Promise<void> {
  return spectrumAction('/api/spectrum/friend-request/create', { member_id: memberId });
}

export function removeFriend(memberId: number): Promise<void> {
  return spectrumAction('/api/spectrum/friend/remove', { member_id: memberId });
}

// --- PTU parallel helpers -------------------------------------------------
//
// PTU spectrum mirrors LIVE's endpoints 1:1 — only the base URL,
// cookie name and token header change. These functions duplicate the
// LIVE helpers with PTU plumbing so the "Sync LIVE → PTU" workflow can
// read PTU state and fire PTU friend-requests without leaking an `env`
// parameter through every LIVE call site.

async function ptuSpectrumPost<T>(path: string, body: unknown): Promise<T> {
  const token = await requirePtuToken();
  const response = await fetchWithTimeout(`${RSI_PTU_BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-rsi-ptu-token': token,
      'x-tavern-id': token,
    },
    body: JSON.stringify(body),
  });
  assertRsiOk(response, `PTU ${path}`);
  return (await response.json()) as T;
}

async function ptuSpectrumAction(path: string, body: unknown): Promise<void> {
  const raw = await ptuSpectrumPost<unknown>(path, body);
  const parsed = SuccessResponse.safeParse(raw);
  if (!parsed.success) {
    throw new RsiSpectrumActionError(`PTU ${path}`, 'ErrInvalidResponse', 'invalid response');
  }
  if (parsed.data.success !== 1) {
    throw new RsiSpectrumActionError(
      `PTU ${path}`,
      parsed.data.code ?? 'ErrUnknown',
      parsed.data.msg ?? `${path} failed`,
    );
  }
}

export async function fetchPtuContactsBundle(): Promise<ContactsBundle> {
  const data = await identifyPtu();
  if (!data) throw new RsiNotAuthenticatedError();
  const myId = data.member?.id ?? 0;

  const contacts: Contact[] = [];
  for (const f of data.friends ?? []) {
    if (!f.nickname) continue;
    contacts.push({
      nickname: f.nickname,
      displayname: f.displayname ?? '',
      avatar: f.avatar ?? '',
    });
  }

  const incoming: ContactRequest[] = [];
  const outgoing: ContactRequest[] = [];
  for (const r of data.friend_requests ?? []) {
    const member = pickCounterparty(r, myId);
    if (!member?.nickname) continue;
    const req: ContactRequest = {
      id: r.id,
      direction: r.type === 'out' ? 'out' : 'in',
      nickname: member.nickname,
      displayname: member.displayname ?? '',
      avatar: member.avatar ?? '',
    };
    if (req.direction === 'out') outgoing.push(req);
    else incoming.push(req);
  }

  return { contacts, incoming, outgoing };
}

export async function searchPtuMembers(query: string): Promise<MemberHit[]> {
  const text = query.trim();
  if (text.length < 2) return [];
  const raw = await ptuSpectrumPost<unknown>('/api/spectrum/search/member/autocomplete', {
    community_id: null,
    ignore_self: true,
    text,
  });
  const parsed = MemberAutocompleteResponse.safeParse(raw);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.warn('[contacts/ptu] member autocomplete: unexpected shape', parsed.error.issues);
    return [];
  }
  if (parsed.data.success !== 1) {
    if (parsed.data.code === 'ErrThrottleLimit') {
      throw new RsiSpectrumActionError(
        'PTU /api/spectrum/search/member/autocomplete',
        'ErrThrottleLimit',
        parsed.data.msg ?? 'throttled',
      );
    }
    return [];
  }
  return (parsed.data.data?.members ?? []).map((m) => ({
    id: m.id,
    nickname: m.nickname,
    displayname: m.displayname ?? '',
    avatar: m.avatar ?? '',
  }));
}

export function sendPtuFriendRequest(memberId: number): Promise<void> {
  return ptuSpectrumAction('/api/spectrum/friend-request/create', {
    member_id: memberId,
  });
}
