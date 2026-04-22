// Account dashboard summary — served by RSI's Orion GraphQL gateway.
//
// The legacy HTML at `/account/dashboard` was replaced by a React SPA that
// hydrates via POST `/graphql` using an `accountDashboard` query. We issue
// that same query directly and surface the fields that matter: identity,
// credit balances (Store / UEC / REC), Concierge progress, featured badges,
// and the dashboard's outbound quick-links.

import { z } from 'zod';
import { RSI_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';
import { assertRsiOk, RsiNotAuthenticatedError } from './auth.js';

export const DashboardCredit = z.object({
  /** Machine name: "store", "uec", "rec". */
  variant: z.string().default(''),
  /** UI label: "Store", "UEC", "REC". */
  label: z.string().default(''),
  /** Currency code: "USD", "UEC", "REC". */
  currency: z.string().default(''),
  /** Currency symbol, e.g. "$" or "¤". */
  symbol: z.string().default(''),
  /** Raw amount. For USD/store this is cents (12170 = $121.70).
   *  For UEC and REC it is the direct unit value. */
  value: z.number().int().default(0),
});
export type DashboardCredit = z.infer<typeof DashboardCredit>;

export const DashboardConcierge = z.object({
  /** Current level, e.g. "Grand Admiral". Empty when no concierge tier. */
  currentLevel: z.string().default(''),
  /** Next level, e.g. "Space Marshal". Empty at max or when none. */
  nextLevel: z.string().default(''),
  /** Progress toward the next level, 0–100. */
  nextLevelPercentage: z.number().int().default(0),
});
export type DashboardConcierge = z.infer<typeof DashboardConcierge>;

export const DashboardBadge = z.object({
  title: z.string().default(''),
  alt: z.string().default(''),
  image: z.string().nullable(),
  href: z.string().nullable(),
});
export type DashboardBadge = z.infer<typeof DashboardBadge>;

export const DashboardSubscriber = z.object({
  /** "Centurion", "Imperator", etc. Null when not a subscriber. */
  type: z.string().default(''),
  /** "Monthly", "Annual", etc. */
  frequency: z.string().default(''),
});
export type DashboardSubscriber = z.infer<typeof DashboardSubscriber>;

export const DashboardLinks = z.object({
  billing: z.string().nullable(),
  concierge: z.string().nullable(),
  hangar: z.string().nullable(),
  settings: z.string().nullable(),
  becomeSubscriber: z.string().nullable(),
  subscriberStore: z.string().nullable(),
  subscribersVault: z.string().nullable(),
});
export type DashboardLinks = z.infer<typeof DashboardLinks>;

export const DashboardSummary = z.object({
  /** RSI handle (nickname). */
  handle: z.string(),
  /** Display name (usually the first name). */
  displayName: z.string().default(''),
  avatarUrl: z.string().nullable(),
  /** Full timestamp as returned by RSI, e.g. "2015-12-21 15:38:21". */
  enlistedSince: z.string().default(''),
  country: z.string().default(''),
  credits: z.array(DashboardCredit).default([]),
  concierge: DashboardConcierge,
  subscriber: DashboardSubscriber.nullable(),
  badges: z.array(DashboardBadge).default([]),
  links: DashboardLinks,
});
export type DashboardSummary = z.infer<typeof DashboardSummary>;

const DASHBOARD_QUERY = `query AccountDashboard {
  accountDashboard {
    account {
      avatar
      displayname
      nickname
      countryName
      enlistedSince
      creditsData { currency label symbol value variant }
      conciergeData { conciergeCurrentLevel conciergeNextLevel conciergeNextLevelPercentage }
      subscriberData { frequency type }
      featuredBadges { href image { alt src title } }
    }
    links {
      linkBecomeSubscriber
      linkBilling
      linkConcierge
      linkHangar
      linkSettings
      linkSubscriberStore
      linkSubscribersVault
    }
  }
}`;

function resolveUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  return src.startsWith('http') ? src : `${RSI_BASE_URL}${src}`;
}

interface RawAccount {
  avatar: string | null;
  displayname: string | null;
  nickname: string | null;
  countryName: string | null;
  enlistedSince: string | null;
  creditsData: Array<{
    currency: string | null;
    label: string | null;
    symbol: string | null;
    value: number | null;
    variant: string | null;
  }> | null;
  conciergeData: {
    conciergeCurrentLevel: string | null;
    conciergeNextLevel: string | null;
    conciergeNextLevelPercentage: number | null;
  } | null;
  subscriberData: { frequency: string | null; type: string | null } | null;
  featuredBadges: Array<{
    href: string | null;
    image: { alt: string | null; src: string | null; title: string | null } | null;
  }> | null;
}

interface RawLinks {
  linkBecomeSubscriber: string | null;
  linkBilling: string | null;
  linkConcierge: string | null;
  linkHangar: string | null;
  linkSettings: string | null;
  linkSubscriberStore: string | null;
  linkSubscribersVault: string | null;
}

interface GraphQLResponse {
  data?: { accountDashboard?: { account: RawAccount | null; links: RawLinks | null } | null };
  errors?: Array<{ message: string }>;
}

export async function fetchDashboardSummary(): Promise<DashboardSummary | null> {
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/graphql`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: DASHBOARD_QUERY, operationName: 'AccountDashboard' }),
  });
  assertRsiOk(response, 'graphql accountDashboard');
  const json = (await response.json()) as GraphQLResponse;
  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join('; ');
    // RSI's GraphQL returns auth failures as 200 + errors; surface as auth
    // so the popup shows SignInPrompt instead of a raw error.
    if (/unauth|forbid|not.*(logged|signed).*in|session/i.test(msg)) {
      throw new RsiNotAuthenticatedError();
    }
    throw new Error(`graphql accountDashboard: ${msg}`);
  }
  const dash = json.data?.accountDashboard;
  const account = dash?.account;
  // GraphQL happily returns account:null for an unauthenticated-but-tokened
  // request — treat that as an auth failure so the popup shows SignInPrompt.
  if (!account || !account.nickname) throw new RsiNotAuthenticatedError();

  const credits: DashboardCredit[] = (account.creditsData ?? []).map((c) => ({
    variant: c.variant ?? '',
    label: c.label ?? '',
    currency: c.currency ?? '',
    symbol: c.symbol ?? '',
    value: c.value ?? 0,
  }));

  const cd = account.conciergeData;
  const concierge: DashboardConcierge = {
    currentLevel: cd?.conciergeCurrentLevel ?? '',
    nextLevel: cd?.conciergeNextLevel ?? '',
    nextLevelPercentage: cd?.conciergeNextLevelPercentage ?? 0,
  };

  const subscriber: DashboardSubscriber | null = account.subscriberData
    ? {
        type: account.subscriberData.type ?? '',
        frequency: account.subscriberData.frequency ?? '',
      }
    : null;

  const badges: DashboardBadge[] = (account.featuredBadges ?? []).map((b) => ({
    title: b.image?.title ?? '',
    alt: b.image?.alt ?? '',
    image: resolveUrl(b.image?.src ?? null),
    href: resolveUrl(b.href ?? null),
  }));

  const rawLinks = dash?.links ?? null;
  const links: DashboardLinks = {
    billing: resolveUrl(rawLinks?.linkBilling ?? null),
    concierge: resolveUrl(rawLinks?.linkConcierge ?? null),
    hangar: resolveUrl(rawLinks?.linkHangar ?? null),
    settings: resolveUrl(rawLinks?.linkSettings ?? null),
    becomeSubscriber: resolveUrl(rawLinks?.linkBecomeSubscriber ?? null),
    subscriberStore: resolveUrl(rawLinks?.linkSubscriberStore ?? null),
    subscribersVault: resolveUrl(rawLinks?.linkSubscribersVault ?? null),
  };

  return {
    handle: account.nickname,
    displayName: account.displayname ?? account.nickname,
    avatarUrl: resolveUrl(account.avatar),
    enlistedSince: account.enlistedSince ?? '',
    country: account.countryName ?? '',
    credits,
    concierge,
    subscriber,
    badges,
    links,
  };
}
