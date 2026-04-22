// Two flavours of "orgs":
//
// 1) MyOrg — the signed-in user's own orgs, scraped from GET /account/organization
//    (HTML, requires cookie). Carries SID, name, logo, rank, level, member count.
//
// 2) PublicOrg — the global org directory, fetched anonymously through the public
//    POST /api/orgs/getOrgs JSON endpoint. The response wraps an HTML fragment of
//    `.org-cell` cards with name/SID/logo/archetype/lang/commitment/recruiting/
//    roleplay/members. No motto in the listing — that lives on /orgs/{SID}.

import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { RSI_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';
import { assertRsiHtmlNotLogin, assertRsiNotRedirectedToLogin, assertRsiOk } from './auth.js';

export const MyOrg = z.object({
  sid: z.string(),
  name: z.string(),
  logo: z.string().nullable(),
  rank: z.string().default(''),
  levelNumber: z.number().int().default(0),
  memberCount: z.number().int().default(0),
});
export type MyOrg = z.infer<typeof MyOrg>;

export const PublicOrg = z.object({
  sid: z.string(),
  name: z.string(),
  logo: z.string().nullable(),
  url: z.string(),
  archetype: z.string().default(''),
  language: z.string().default(''),
  commitment: z.string().default(''),
  recruiting: z.boolean().default(false),
  roleplay: z.boolean().default(false),
  memberCount: z.number().int().default(0),
});
export type PublicOrg = z.infer<typeof PublicOrg>;

// Filter values follow the RSI org-listing form's own codes (see
// /en/community/orgs/listing?openPanel=1 — View Source):
//
//   commitment : 'CA' | 'RE' | 'HA'
//   roleplay   : '1'  | '0'
//   recruiting : '1'  | '0'
//   size       : 'small' | 'medium' | 'large'
//   model      : 'generic' | 'corp' | 'pmc' | 'faith' | 'syndicate' | 'club'
//   activity   : numeric IDs (as strings), e.g. '9' = Bounty Hunting
//   language   : 2-letter ISO code, e.g. 'fr'
//
// Sending unknown values results in an unfiltered response.
export interface PublicOrgSearchParams {
  search?: string;
  page?: number;
  pagesize?: number;
  activity?: string[];
  language?: string[];
  model?: string[];
  size?: string[];
  commitment?: string[];
  roleplay?: string[];
  recruiting?: string[];
}

export interface PublicOrgSearchResult {
  orgs: PublicOrg[];
  totalRows: number;
  page: number;
}

function text(el: Element | null): string {
  return (el?.textContent ?? '').trim();
}

function resolveLogo(src: string | null | undefined): string | null {
  if (!src) return null;
  return src.startsWith('http') ? src : `${RSI_BASE_URL}${src}`;
}

export function parseMyOrgsPage(html: string): MyOrg[] {
  const { document } = parseHTML(html);
  const orgs: MyOrg[] = [];

  for (const card of Array.from(document.querySelectorAll('div.org-card'))) {
    const entries = card.querySelectorAll('div.info p.entry');
    const name = text(entries[0]?.querySelector('a') ?? null);
    const sid = text(
      card.querySelector('div.info div.front p.entry:nth-child(1) strong.value'),
    );
    const rank = text(
      card.querySelector('div.info div.front p.entry:nth-child(2) strong.value'),
    );
    const logo = resolveLogo(card.querySelector('div.thumb > a > img')?.getAttribute('src'));
    const levelNumber = card.querySelectorAll('div.ranking > span.active').length;
    const memberCount = Number.parseInt(
      text(card.querySelector('div.thumb > span')).replace(/[^0-9]/g, ''),
      10,
    ) || 0;

    if (!sid) continue;
    orgs.push({ sid, name, logo, rank, levelNumber, memberCount });
  }

  return orgs;
}

export async function fetchMyOrgs(): Promise<MyOrg[]> {
  return fetchOrgSection('/account/organization');
}

/**
 * Invitations received from orgs. Server-renders the same `div.org-card`
 * shape as Membership, so the parser is shared. Empty state serves an
 * `<ul class="orgs-listing"><div class="no-data">` — `parseMyOrgsPage`
 * returns [] on that path because no .org-card matches.
 */
export async function fetchOrgInvitations(): Promise<MyOrg[]> {
  return fetchOrgSection('/account/organization/invitations');
}

/**
 * Applications sent by the user — same server-side HTML layout as
 * Membership + Invitations.
 */
export async function fetchOrgApplications(): Promise<MyOrg[]> {
  return fetchOrgSection('/account/organization/applications');
}

async function fetchOrgSection(path: string): Promise<MyOrg[]> {
  const response = await fetchWithTimeout(`${RSI_BASE_URL}${path}`, {
    method: 'GET',
    credentials: 'include',
  });
  assertRsiOk(response, path);
  assertRsiNotRedirectedToLogin(response);
  const html = await response.text();
  assertRsiHtmlNotLogin(html);
  return parseMyOrgsPage(html);
}

// --- Public org directory -------------------------------------------------

function infoValue(card: Element, label: string): string {
  for (const item of Array.from(card.querySelectorAll('span.infoitem'))) {
    const lbl = text(item.querySelector('span.label')).replace(/:\s*$/, '');
    if (lbl.toLowerCase() === label.toLowerCase()) {
      return text(item.querySelector('span.value'));
    }
  }
  return '';
}

export function parsePublicOrgsHtml(html: string): PublicOrg[] {
  const { document } = parseHTML(html);
  const orgs: PublicOrg[] = [];

  for (const card of Array.from(document.querySelectorAll('div.org-cell'))) {
    const anchor = card.querySelector('a[href]');
    const href = anchor?.getAttribute('href') ?? '';
    const sid = text(card.querySelector('span.symbol')) || href.split('/').pop() || '';
    if (!sid) continue;

    const name = text(card.querySelector('h3.name'));
    const logo = resolveLogo(card.querySelector('span.thumb img')?.getAttribute('src'));
    const url = href.startsWith('http') ? href : `${RSI_BASE_URL}${href}`;

    const archetype = infoValue(card, 'Archetype');
    // The directory uses "Lang" as the label for language.
    const language = infoValue(card, 'Lang') || infoValue(card, 'Language');
    const commitment = infoValue(card, 'Commitment');
    const recruiting = /^yes$/i.test(infoValue(card, 'Recruiting'));
    const roleplay = /^yes$/i.test(infoValue(card, 'Role play') || infoValue(card, 'Roleplay'));
    const memberCount =
      Number.parseInt(infoValue(card, 'Members').replace(/[^0-9]/g, ''), 10) || 0;

    orgs.push({
      sid,
      name,
      logo,
      url,
      archetype,
      language,
      commitment,
      recruiting,
      roleplay,
      memberCount,
    });
  }

  return orgs;
}

// --- Org members ---------------------------------------------------------
//
// POST /api/orgs/getOrgMembers returns `{ data: { html, totalrows } }` where
// `html` is a fragment of <li class="member-item org-visibility-V"> rows.
// Hidden-visibility members are absent (no nickname). Pagesize caps at 32.

export interface OrgMember {
  nickname: string;
  displayName: string;
  avatar: string | null;
  rank: string;
  levelNumber: number;
  profileUrl: string;
}

export interface OrgMembersResult {
  members: OrgMember[];
  totalRows: number;
}

function parseOrgMembersHtml(html: string): OrgMember[] {
  const { document } = parseHTML(`<div>${html}</div>`);
  const members: OrgMember[] = [];

  for (const li of Array.from(
    document.querySelectorAll('li.member-item.org-visibility-V'),
  )) {
    const nickname = text(li.querySelector('.nick'));
    if (!nickname) continue;

    const displayName = text(li.querySelector('.name')) || nickname;
    const rank = text(li.querySelector('.rank'));
    const avatar = resolveLogo(li.querySelector('span.thumb > img')?.getAttribute('src'));

    const starsStyle = li.querySelector('.stars')?.getAttribute('style') ?? '';
    const starsWidth = Number.parseInt(starsStyle.replace(/^\D+/g, ''), 10) || 0;
    const levelNumber = Math.max(0, Math.min(5, Math.round(starsWidth / 20)));

    const href = li.querySelector('a[href]')?.getAttribute('href') ?? `/citizens/${nickname}`;
    const profileUrl = href.startsWith('http') ? href : `${RSI_BASE_URL}${href}`;

    members.push({ nickname, displayName, avatar, rank, levelNumber, profileUrl });
  }
  return members;
}

export async function fetchOrgMembersPage(
  token: string,
  sid: string,
  page: number,
): Promise<{ members: OrgMember[]; totalRows: number; hasMore: boolean }> {
  const body = {
    symbol: sid.toUpperCase(),
    search: '',
    pagesize: 32,
    page,
  };
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/api/orgs/getOrgMembers`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-rsi-token': token,
    },
    body: JSON.stringify(body),
  });
  assertRsiOk(response, 'api/orgs/getOrgMembers');

  const json = (await response.json()) as {
    success?: number;
    msg?: string;
    data?: { totalrows?: number | string; html?: string };
  };
  if (!json || json.success !== 1 || !json.data) {
    throw new Error(`api/orgs/getOrgMembers failed: ${json?.msg ?? 'unknown error'}`);
  }

  const html = (json.data.html ?? '').trim();
  const members = html ? parseOrgMembersHtml(html) : [];
  const totalRows = Number.parseInt(String(json.data.totalrows ?? 0), 10) || 0;
  return { members, totalRows, hasMore: html.length > 0 && members.length > 0 };
}

export async function fetchOrgMembers(
  token: string,
  sid: string,
): Promise<OrgMembersResult> {
  const all: OrgMember[] = [];
  let totalRows = 0;
  for (let page = 1; page <= 40; page++) {
    const res = await fetchOrgMembersPage(token, sid, page);
    if (res.totalRows) totalRows = res.totalRows;
    if (res.members.length === 0) break;
    all.push(...res.members);
    if (!res.hasMore) break;
  }
  return { members: all, totalRows: totalRows || all.length };
}

export async function searchPublicOrgs(
  params: PublicOrgSearchParams = {},
): Promise<PublicOrgSearchResult> {
  const page = params.page ?? 1;
  const body = {
    search: params.search ?? '',
    pagesize: params.pagesize ?? 12,
    page,
    activity: params.activity ?? [],
    language: params.language ?? [],
    model: params.model ?? [],
    size: params.size ?? [],
    commitment: params.commitment ?? [],
    roleplay: params.roleplay ?? [],
    recruiting: params.recruiting ?? [],
  };

  const response = await fetchWithTimeout(`${RSI_BASE_URL}/api/orgs/getOrgs`, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`api/orgs/getOrgs returned ${response.status}`);
  }

  const json = (await response.json()) as {
    success?: number;
    msg?: string;
    data?: { totalrows?: number; html?: string };
  };
  if (!json || json.success !== 1 || !json.data) {
    throw new Error(`api/orgs/getOrgs failed: ${json?.msg ?? 'unknown error'}`);
  }

  const html = json.data.html ?? '';
  return {
    orgs: parsePublicOrgsHtml(html),
    totalRows: json.data.totalrows ?? 0,
    page,
  };
}
