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

export async function fetchContactsBundle(): Promise<ContactsBundle> {
  const data = await identifyFull();
  if (!data) throw new RsiNotAuthenticatedError();

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
    const member = r.member;
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

const MemberAutocompleteResponse = z.object({
  success: z.number().int(),
  data: z
    .array(
      z.object({
        id: z.coerce.number().int(),
        nickname: z.string(),
        displayname: z.string().nullable().optional(),
        avatar: z.string().nullable().optional(),
      }),
    )
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
  if (!parsed.success || parsed.data.success !== 1) return [];
  return (parsed.data.data ?? []).map((m) => ({
    id: m.id,
    nickname: m.nickname,
    displayname: m.displayname ?? '',
    avatar: m.avatar ?? '',
  }));
}

// --- actions -------------------------------------------------------------

const SuccessResponse = z.object({
  success: z.number().int(),
  msg: z.string().optional(),
});

async function spectrumAction(path: string, body: unknown): Promise<void> {
  const raw = await spectrumPost<unknown>(path, body);
  const parsed = SuccessResponse.safeParse(raw);
  if (!parsed.success || parsed.data.success !== 1) {
    throw new Error(parsed.success ? parsed.data.msg || `${path} failed` : 'invalid response');
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
  if (!parsed.success || parsed.data.success !== 1) {
    throw new Error(parsed.success ? parsed.data.msg || `${path} failed` : 'invalid response');
  }
}

export async function fetchPtuContactsBundle(): Promise<ContactsBundle> {
  const data = await identifyPtu();
  if (!data) throw new RsiNotAuthenticatedError();

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
    const member = r.member;
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
  if (!parsed.success || parsed.data.success !== 1) return [];
  return (parsed.data.data ?? []).map((m) => ({
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
