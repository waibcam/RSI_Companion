// Global stats surfaced in the popup top bar:
//   - Star Citizens crowdfunding totals (fans + funds) from the anonymous
//     POST /api/stats/getCrowdfundStats endpoint
//   - User's referral stats (recruits + prospects + progress toward the
//     next reward). The old /account/referral-program HTML scraping broke
//     when RSI rebuilt the referral page as a client-rendered SPA. The
//     new path is a GraphQL batch: GetReferralRecruitsList (counts) +
//     ReferralCampaignRewards (reward thresholds) against the same
//     /graphql endpoint the dashboard uses. Auth is carried by the
//     existing Rsi-Token cookie via credentials: 'include'.
//   - Available buy-back tokens scraped from /account/buy-back-pledges (this
//     is parsed on the buyback fetch itself and merged in by the background)

import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { RSI_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';
import { assertRsiOk, RsiNotAuthenticatedError } from './auth.js';

export const CrowdfundStats = z.object({
  /** Number of Star Citizens (backers). */
  fans: z.number().int().default(0),
  /** Pledged funds in USD cents. Legacy showed this as dollars. */
  funds: z.number().int().default(0),
});
export type CrowdfundStats = z.infer<typeof CrowdfundStats>;

export const ReferralStats = z.object({
  /** Active recruits the user brought in (converted, got game package). */
  recruits: z.number().int().default(0),
  /** Signed-up prospects that haven't converted yet. */
  prospects: z.number().int().default(0),
  /** Current progress count toward next reward (== recruits). */
  progressCurrent: z.number().int().default(0),
  /** Threshold for the next reward (0 when none left). */
  progressTarget: z.number().int().default(0),
  /** Title of the next reward, or empty when the user has claimed everything. */
  nextRank: z.string().default(''),
  /** Active campaign id used to hit the GraphQL endpoints. */
  campaignId: z.string().default('2'),
});
export type ReferralStats = z.infer<typeof ReferralStats>;

const CrowdfundResponse = z.object({
  success: z.number().int(),
  data: z
    .object({
      fans: z.coerce.number().int().default(0),
      funds: z.coerce.number().int().default(0),
    })
    .nullable()
    .optional(),
});

export async function fetchCrowdfundStats(): Promise<CrowdfundStats> {
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/api/stats/getCrowdfundStats`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ chart: 'day', fans: true, funds: true }),
  });
  if (!response.ok) throw new Error(`getCrowdfundStats returned ${response.status}`);
  const raw = (await response.json()) as unknown;
  const parsed = CrowdfundResponse.safeParse(raw);
  if (!parsed.success || parsed.data.success !== 1 || !parsed.data.data) {
    return { fans: 0, funds: 0 };
  }
  return parsed.data.data;
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').trim();
}

function parseCount(s: string): number {
  const m = /(\d[\d,]*)/.exec(s);
  const raw = m?.[1];
  if (!raw) return 0;
  return Number.parseInt(raw.replace(/,/g, ''), 10) || 0;
}

// --- Referral GraphQL (replaces the HTML scrape) --------------------------
//
// The RSI referral page batches two relevant queries on load:
//   1. GetReferralRecruitsList — returns { recruitsCount, prospectsCount }
//      (we request limit:1 since we only want the totals, not the list)
//   2. ReferralCampaignRewards — returns the ordered list of rewards with
//      their `referrals` thresholds (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 25,
//      42, 50, 75, 100, 200, 500, 1042). We pick the smallest whose
//      threshold is strictly greater than recruitsCount as the "next rank"
//      — that drives the progress bar + reward name in the popup.
//
// `campaignId: "2"` is the current (2025/2026) referral campaign — if CIG
// ever bumps it, we'd need to read it from the `ReferralActiveCampaign`
// query or similar. Hardcoded for now.

const DEFAULT_REFERRAL_CAMPAIGN_ID = '2';

const REFERRAL_BATCH_QUERY = [
  {
    operationName: 'GetReferralRecruitsList',
    variables: {
      campaignId: DEFAULT_REFERRAL_CAMPAIGN_ID,
      converted: false,
      display: 'ALL_TIME',
      limit: 1,
      page: 1,
      sortBy: 'NEWEST',
    },
    query: `query GetReferralRecruitsList($campaignId: ID!, $converted: Boolean!, $display: ReferralRecruitsListDisplay, $limit: Int!, $page: Int!, $sortBy: ReferralRecruitsListSortBy) {
      referralRecruitsList(query: {campaignId: $campaignId, converted: $converted, display: $display, limit: $limit, page: $page, sortBy: $sortBy}) {
        recruitsCount
        prospectsCount
      }
    }`,
  },
  {
    operationName: 'ReferralCampaignRewards',
    variables: { campaignId: DEFAULT_REFERRAL_CAMPAIGN_ID },
    query: `query ReferralCampaignRewards($campaignId: ID!) {
      referralRewardsByCampaign(campaignId: $campaignId) {
        id
        title
        referrals
      }
    }`,
  },
];

const RecruitsListPayload = z.object({
  data: z
    .object({
      referralRecruitsList: z
        .object({
          recruitsCount: z.coerce.number().int().default(0),
          prospectsCount: z.coerce.number().int().default(0),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const RewardsPayload = z.object({
  data: z
    .object({
      referralRewardsByCampaign: z
        .array(
          z.object({
            id: z.string(),
            title: z.string().default(''),
            referrals: z.coerce.number().int().default(0),
          }),
        )
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const BatchResponse = z.tuple([RecruitsListPayload, RewardsPayload]);

export async function fetchReferralStats(): Promise<ReferralStats> {
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/graphql`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(REFERRAL_BATCH_QUERY),
  });
  if (response.status === 401 || response.status === 403) {
    throw new RsiNotAuthenticatedError();
  }
  assertRsiOk(response, 'graphql referral');

  const raw = (await response.json()) as unknown;
  const parsed = BatchResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`referral GraphQL: unexpected shape (${parsed.error.message})`);
  }
  const [recruitsResp, rewardsResp] = parsed.data;

  // The query returns `account:null` / no data shape when the session is
  // stale (the server accepts the call but refuses to surface per-user
  // data). Treat that as not-signed-in so the UI falls back gracefully.
  const counts = recruitsResp.data?.referralRecruitsList;
  if (!counts) throw new RsiNotAuthenticatedError();

  const recruits = counts.recruitsCount;
  const prospects = counts.prospectsCount;

  const rewards = (rewardsResp.data?.referralRewardsByCampaign ?? [])
    .slice()
    .sort((a, b) => a.referrals - b.referrals);

  // Next reward: smallest referrals threshold strictly greater than the
  // current recruit count. Returns undefined when the user has crossed
  // every tier — at that point we zero out the progress target and the
  // popup renders recruits/prospects without a bar.
  const next = rewards.find((r) => r.referrals > recruits);

  return {
    recruits,
    prospects,
    progressCurrent: recruits,
    progressTarget: next?.referrals ?? 0,
    nextRank: next?.title ?? '',
    campaignId: DEFAULT_REFERRAL_CAMPAIGN_ID,
  };
}

export function parseBuyBackTokenCount(html: string): number {
  const { document } = parseHTML(html);
  return parseCount(text(document.querySelector('p.buy-back-warning > strong')));
}
