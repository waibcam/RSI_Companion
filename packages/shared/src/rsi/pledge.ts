// Pledge Store integration.
//
// The pledge store is a separate SPA at /pledge-store/ that fetches SKU data
// via POST /graphql using a batched operation format. The query we care about
// is `GetShipList`: it returns the catalogue of pledgeable ships with prices,
// production status, manufacturer, and composed thumbnail URLs. We mirror
// the exact shape RSI's own SPA sends so the server accepts the query.
//
// We intentionally do NOT expose cart/checkout actions — that flow stays on
// RSI. The extension is strictly a read-only catalogue view with a deep-link
// to buy.

import { z } from 'zod';
import { RSI_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';
import { fetchRsiCsrfToken, invalidateCsrfToken, readRsiToken } from './auth.js';

export const PledgeManufacturer = z.object({
  id: z.coerce.number().int(),
  name: z.string(),
});
export type PledgeManufacturer = z.infer<typeof PledgeManufacturer>;

export const PledgeShip = z.object({
  id: z.string(),
  title: z.string(),
  name: z.string(),
  /** `/pledge/ships/<brand>/<slug>` — append to RSI_BASE_URL for the detail page. */
  url: z.string(),
  slug: z.string(),
  /** classification bucket — "multi", "combat", "transport", "exploration",
   *  "industrial", "support", "competition", "ground". */
  type: z.string().default(''),
  /** free-text role, e.g. "Starter / Touring", "Heavy Fighter". */
  focus: z.string().default(''),
  /** Price in USD cents (5000 = $50.00). */
  msrp: z.number().int().default(0),
  purchasable: z.boolean().default(false),
  /** "flight-ready" | "in-concept" | other. */
  productionStatus: z.string().default(''),
  manufacturerId: z.number().int().default(0),
  manufacturerName: z.string().default(''),
  minCrew: z.number().int().nullable().default(null),
  maxCrew: z.number().int().nullable().default(null),
  /** Ship size bucket — "small" | "medium" | "large" | "capital" |
   *  "snub" | "vehicle". Drives the Size filter in the popup. */
  size: z.string().default(''),
  /** Pre-composed thumbnail URL (16:9, ~900px wide). Empty when the SKU has
   *  no thumbnail slot set up. URLs are absolute under media.rsi or relative
   *  to the site root, normalized here. */
  thumbnailUrl: z.string().default(''),
});
export type PledgeShip = z.infer<typeof PledgeShip>;

export interface PledgeShipListResult {
  ships: PledgeShip[];
  totalCount: number;
  manufacturers: PledgeManufacturer[];
}

// --- GraphQL ---------------------------------------------------------------

// Minimal subset of GetShipList — mirrors the query RSI's pledge-store SPA
// sends. We pick only the fields the popup renders to keep payloads small.
const SHIP_LIST_QUERY = `query GetShipList($query: SearchQuery!, $storeFront: String = "pledge") {
  store(name: $storeFront, browse: true) {
    search(query: $query) {
      count
      totalCount
      resources {
        ...RSIShipListFragment
      }
    }
  }
}

fragment RSIShipListFragment on RSIShip {
  id
  title
  name
  url
  slug
  type
  focus
  msrp
  purchasable
  productionStatus
  manufacturerId
  minCrew
  maxCrew
  size
  manufacturer { name }
  imageComposer { name slot url }
}`;

const MANUFACTURERS_QUERY = `query GetManufacturers {
  manufacturers { id name }
}`;

// Raw response shape — passthrough so extra fields don't break the parse.
const RawShip = z
  .object({
    id: z.union([z.string(), z.number()]).transform((v) => String(v)),
    title: z.string().default(''),
    name: z.string().default(''),
    url: z.string().default(''),
    slug: z.string().default(''),
    type: z.string().nullable().default(''),
    focus: z.string().nullable().default(''),
    msrp: z.coerce.number().int().default(0),
    purchasable: z.boolean().default(false),
    productionStatus: z.string().nullable().default(''),
    manufacturerId: z.coerce.number().int().default(0),
    minCrew: z.number().int().nullable().optional(),
    maxCrew: z.number().int().nullable().optional(),
    size: z.string().nullable().optional(),
    manufacturer: z
      .object({ name: z.string().default('') })
      .nullable()
      .optional(),
    imageComposer: z
      .array(
        z.object({
          name: z.string().default(''),
          slot: z.string().default(''),
          url: z.string().default(''),
        }),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

const ShipListBatchResponse = z.array(
  z.object({
    data: z
      .object({
        store: z
          .object({
            search: z
              .object({
                totalCount: z.coerce.number().int().default(0),
                count: z.coerce.number().int().default(0),
                resources: z.array(RawShip).default([]),
              })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
        manufacturers: z
          .array(
            z.object({
              id: z.coerce.number().int(),
              name: z.string(),
            }),
          )
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    errors: z
      .array(z.object({ message: z.string() }))
      .nullable()
      .optional(),
  }),
);

function normalizeThumbnail(raw: string | undefined): string {
  if (!raw) return '';
  if (raw.startsWith('http')) return raw;
  // imageComposer URLs are `/i/<hash>/resize(<params>)/source.webp` — the
  // RSI image-proxy endpoint. Served by the MAIN site, not the media CDN:
  // `media.robertsspaceindustries.com` only hosts direct file paths, and
  // returns 404 on the image-proxy route. This was the bug that made
  // thumbnails disappear on the Browse tab.
  if (raw.startsWith('/')) return `${RSI_BASE_URL}${raw}`;
  return raw;
}

function mapShip(raw: z.infer<typeof RawShip>): PledgeShip {
  // Prefer the 900px thumbnail slot (smaller = faster on popup); fall back
  // to whatever comes first. We only render one thumbnail per card anyway.
  const images = raw.imageComposer ?? [];
  const pref = images.find((i) => i.name === '900') ?? images[0];
  return {
    id: raw.id,
    title: raw.title || raw.name,
    name: raw.name,
    url: raw.url,
    slug: raw.slug,
    type: raw.type ?? '',
    focus: raw.focus ?? '',
    msrp: raw.msrp,
    purchasable: raw.purchasable,
    productionStatus: raw.productionStatus ?? '',
    manufacturerId: raw.manufacturerId,
    manufacturerName: raw.manufacturer?.name ?? '',
    minCrew: raw.minCrew ?? null,
    maxCrew: raw.maxCrew ?? null,
    size: raw.size ?? '',
    thumbnailUrl: normalizeThumbnail(pref?.url),
  };
}

/**
 * Fetch the full pledge-store catalogue of on-sale ships. Runs the same
 * batched POST the pledge-store SPA uses on its /ships page load; we request
 * a single oversized page (limit 200) rather than paginating — the full
 * catalogue is ~90 entries, well under any reasonable server cap, and the
 * extension caches the result for 30 minutes.
 *
 * `onlyOnSale` — when true (default), the server filter `sale: [true]`
 * drops SKUs CIG isn't currently selling (limited editions, concept sales
 * that have closed, etc.). Flip to false for a "browse everything" mode
 * when you want to render the full matrix alongside non-purchasable ships.
 */
export async function fetchPledgeShipList(
  options: { onlyOnSale?: boolean; limit?: number } = {},
): Promise<PledgeShipListResult> {
  const onlyOnSale = options.onlyOnSale ?? true;
  const limit = options.limit ?? 200;

  const batch = [
    {
      operationName: 'GetManufacturers',
      variables: {},
      query: MANUFACTURERS_QUERY,
    },
    {
      operationName: 'GetShipList',
      variables: {
        storeFront: 'pledge',
        query: {
          page: 1,
          limit,
          sort: { field: 'name', direction: 'asc' },
          ships: {
            filters: onlyOnSale ? { sale: [true] } : {},
            // imageComposer slot configuration — tells the server which
            // thumbnail sizes to render URLs for. We ask for one (900px)
            // to keep the response small.
            imageComposer: [
              { name: '900', size: 'SIZE_900', ratio: 'RATIO_16_9', extension: 'WEBP' },
            ],
            all: !onlyOnSale,
          },
        },
      },
      query: SHIP_LIST_QUERY,
    },
  ];

  const response = await fetchWithTimeout(`${RSI_BASE_URL}/graphql`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(batch),
  });
  if (!response.ok) {
    throw new Error(`pledge GraphQL returned ${response.status}`);
  }

  const raw = (await response.json()) as unknown;
  const parsed = ShipListBatchResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`pledge GraphQL: unexpected shape (${parsed.error.message})`);
  }

  // Apollo's batch transport preserves operation order, so index 0 is
  // Manufacturers and index 1 is ShipList.
  const manufacturersResp = parsed.data[0];
  const shipsResp = parsed.data[1];
  if (!manufacturersResp || !shipsResp) {
    throw new Error('pledge GraphQL: batch response missing expected entries');
  }
  const errs = [
    ...(manufacturersResp.errors ?? []),
    ...(shipsResp.errors ?? []),
  ];
  if (errs.length > 0) {
    throw new Error(`pledge GraphQL errors: ${errs.map((e) => e.message).join('; ')}`);
  }

  const manufacturers: PledgeManufacturer[] = (
    manufacturersResp.data?.manufacturers ?? []
  ).map((m) => ({ id: m.id, name: m.name }));
  manufacturers.sort((a, b) => a.name.localeCompare(b.name));

  const search = shipsResp.data?.store?.search;
  const ships = (search?.resources ?? []).map(mapShip);
  const totalCount = search?.totalCount ?? ships.length;

  return { ships, totalCount, manufacturers };
}

/**
 * Build the pledge-store ship detail URL. Keeps the "normalize any mix of
 * absolute/relative/missing paths" logic in one place so modules just call
 * `pledgeShipUrl(ship)` and get a canonical href for a "Buy on RSI" link.
 */
export function pledgeShipUrl(ship: { url?: string; slug?: string; name?: string }): string {
  const path = ship.url ?? '';
  if (!path) return `${RSI_BASE_URL}/pledge/ships`;
  if (path.startsWith('http')) return path;
  return `${RSI_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}

// --- Ship detail (inline reader) ----------------------------------------
//
// The pledge-store SPA loads a ship's spec sheet via a single `GetShip`
// GraphQL call that returns the full marketing body, dimensional/flight
// specs, the list of equipment slots (weapons, thrusters, avionics,
// modular, propulsion), variant chassis, paints, SKUs, and upgrades.
// We mirror that call here so the popup can render the same detail
// page inline rather than shipping users off to RSI.
//
// Slug choice: the GraphQL endpoint identifies ships by the DatoCMS slug
// (e.g. `p3i93go2l3vrj` for Avenger Stalker), NOT the URL-path slug
// (`Avenger-Stalker`). `PledgeShip.slug` from `fetchPledgeShipList` is
// the right value. For the Ship Matrix REST API and the CCU catalogue
// — both of which lack DatoCMS slugs — use `resolvePledgeSlugByName`
// to look up the slug from the cached ship list by ship name.

const ShipComponent = z
  .object({
    name: z.string().default(''),
    model: z.string().nullable().default(''),
    description: z.string().nullable().default(''),
    details: z.string().nullable().default(''),
    manufacturerName: z.string().nullable().default(''),
    quantity: z.coerce.number().int().default(0),
    size: z.string().nullable().default(''),
  })
  .passthrough();

const ShipVariantRaw = z
  .object({
    id: z.union([z.string(), z.number()]).transform((v) => String(v)),
    title: z.string().default(''),
    slug: z.string().default(''),
    msrp: z.coerce.number().int().default(0),
    url: z.string().nullable().default(''),
    media: z
      .object({
        thumbnail: z
          .object({ storeSmall: z.string().nullable().optional() })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const ShipPaintOrSkuRaw = z
  .object({
    id: z.union([z.string(), z.number()]).transform((v) => String(v)),
    title: z.string().default(''),
    subtitle: z.string().nullable().optional(),
    slug: z.string().default(''),
    productId: z.union([z.string(), z.number()]).transform((v) => String(v)).optional(),
    isWarbond: z.boolean().nullable().optional(),
    nativePrice: z
      .object({
        amount: z.coerce.number().int().default(0),
        discounted: z.coerce.number().int().nullable().optional(),
        discountDescription: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    imageComposer: z
      .array(
        z.object({
          name: z.string().default(''),
          slot: z.string().default(''),
          url: z.string().default(''),
        }),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

const ShipDetailRaw = z
  .object({
    id: z.union([z.string(), z.number()]).transform((v) => String(v)),
    title: z.string().default(''),
    name: z.string().default(''),
    slug: z.string().default(''),
    url: z.string().nullable().default(''),
    type: z.string().nullable().default(''),
    focus: z.string().nullable().default(''),
    msrp: z.coerce.number().int().default(0),
    purchasable: z.boolean().default(false),
    productionStatus: z.string().nullable().default(''),
    body: z.string().nullable().default(''),
    excerpt: z.string().nullable().default(''),
    size: z.string().nullable().default(''),
    minCrew: z.coerce.number().int().nullable().optional(),
    maxCrew: z.coerce.number().int().nullable().optional(),
    mass: z.coerce.number().nullable().optional(),
    length: z.coerce.number().nullable().optional(),
    beam: z.coerce.number().nullable().optional(),
    height: z.coerce.number().nullable().optional(),
    maxScmSpeed: z.coerce.number().nullable().optional(),
    afterburnerSpeed: z.coerce.number().nullable().optional(),
    cargoCapacity: z.coerce.number().nullable().optional(),
    manufacturer: z.object({ name: z.string().default('') }).nullable().optional(),
    weapons: z.array(ShipComponent).nullable().optional(),
    modular: z.array(ShipComponent).nullable().optional(),
    propulsions: z.array(ShipComponent).nullable().optional(),
    avionics: z.array(ShipComponent).nullable().optional(),
    thrusters: z.array(ShipComponent).nullable().optional(),
    shipVariants: z.array(ShipVariantRaw).nullable().optional(),
    paints: z.array(ShipPaintOrSkuRaw).nullable().optional(),
    skus: z.array(ShipPaintOrSkuRaw).nullable().optional(),
    upgrades: z
      .array(
        z.object({
          id: z.union([z.string(), z.number()]).transform((v) => String(v)),
          title: z.string().default(''),
        }).passthrough(),
      )
      .nullable()
      .optional(),
    imageComposer: z
      .array(
        z.object({
          name: z.string().default(''),
          slot: z.string().default(''),
          url: z.string().default(''),
        }),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

const GetShipResponse = z.array(
  z.object({
    data: z
      .object({
        store: z
          .object({
            context: z
              .object({
                pricing: z
                  .object({
                    currencyCode: z.string().default('USD'),
                    currencySymbol: z.string().default('$'),
                    exponent: z.coerce.number().int().default(2),
                    taxInclusive: z.boolean().default(true),
                  })
                  .nullable()
                  .optional(),
              })
              .nullable()
              .optional(),
            search: z
              .object({
                resources: z.array(ShipDetailRaw).default([]),
              })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    errors: z.array(z.object({ message: z.string() })).nullable().optional(),
  }),
);

export interface PledgeShipComponent {
  /** Human-readable component slot ("Power Plant", "S4 Weapon", etc.). */
  name: string;
  /** CIG's internal group ("power_plants", "weapons", "fuel_intakes"). */
  model: string;
  /** Short blurb, sometimes just the size bucket ("Small", "Medium"). */
  description: string;
  /** Manufacturer for slotted parts; often `TBD` for empty hardpoints. */
  manufacturerName: string;
  quantity: number;
  /** Size bucket ("small"/"medium"/...) or numeric ("3" for weapon size). */
  size: string;
}

export interface PledgeShipVariant {
  id: string;
  title: string;
  /** DatoCMS slug for fetching its own detail. */
  slug: string;
  msrp: number;
  url: string;
  thumbnailUrl: string;
}

export interface PledgeShipSku {
  id: string;
  title: string;
  /** Category label — "Ship Upgrade", "Standalone Ship", "Ship Package",
   *  etc. Disambiguates the ShipReader's Editions list when multiple
   *  SKUs share the same title (e.g. three Avenger Titan entries: one
   *  upgrade, one standalone, one package). Empty string when the
   *  server returned no subtitle. */
  subtitle: string;
  slug: string;
  thumbnailUrl: string;
  /** Limited-availability "warbond" SKU — LTI-less, usually cheaper. */
  isWarbond: boolean;
  /** Native-currency price in minor units (e.g. cents). Divide by
   *  10^exponent (from the detail's pricing context) for display. */
  price: number;
  /** Discounted price when active, else null. Same unit as `price`. */
  discountedPrice: number | null;
  /** Server-provided label for the discount ("25%", "Anniversary",
   *  etc.). Empty when there's no active discount. */
  discountLabel: string;
}

export interface PledgeShipDetail {
  id: string;
  title: string;
  name: string;
  slug: string;
  url: string;
  type: string;
  focus: string;
  /** Base MSRP in USD cents (the ship's headline price, always shown
   *  in dollars). Per-SKU prices in `skus[].price` are in the user's
   *  native currency and use the `currencySymbol` / `exponent` below. */
  msrp: number;
  purchasable: boolean;
  productionStatus: string;
  /** User-locale currency info for rendering per-SKU prices. Mirrors
   *  the pricing context the cart widget uses so per-SKU display in the
   *  Editions list matches what shows up in the cart after add. */
  currencyCode: string;
  currencySymbol: string;
  exponent: number;
  taxInclusive: boolean;
  /** Marketing copy. Short-paragraph plain text with occasional
   *  `*italic*` emphasis. */
  body: string;
  /** Short bullet-list feature highlights (one per line, `* …`). */
  excerpt: string;
  size: string;
  minCrew: number | null;
  maxCrew: number | null;
  /** Tons. */
  mass: number | null;
  /** Metres. */
  length: number | null;
  beam: number | null;
  height: number | null;
  /** m/s. */
  maxScmSpeed: number | null;
  afterburnerSpeed: number | null;
  /** SCU. */
  cargoCapacity: number | null;
  manufacturerName: string;
  weapons: PledgeShipComponent[];
  modular: PledgeShipComponent[];
  propulsions: PledgeShipComponent[];
  avionics: PledgeShipComponent[];
  thrusters: PledgeShipComponent[];
  variants: PledgeShipVariant[];
  paints: PledgeShipSku[];
  skus: PledgeShipSku[];
  /** Hero thumbnail URL (best size available, normalized). */
  thumbnailUrl: string;
}

// GetShip query — MUST be a verbatim copy of the pledge-store SPA's own
// query. RSI's GraphQL gateway rejects shape-divergent queries with a
// generic 200-OK `{ errors: [{ code: "CFUException", message: "Internal
// server error" }] }` for some ships (even when the query parses cleanly).
// We don't know the exact trigger — persisted-query cache, resolver
// assumptions on specific fields, or a whitelist — but matching the SPA
// shape byte-for-byte is the reliable path. Do not prune fields here,
// even "obviously unused" ones like rotation_x/y/z or ctm, without first
// confirming the server still accepts the pruned shape across every
// chassis slug.
const GET_SHIP_QUERY = `query GetShip($query: SearchQuery!, $storeFront: String = "pledge") {
  store(name: $storeFront, browse: true) {
    context {
      pricing {
        currencyCode
        currencySymbol
        exponent
        taxInclusive
        __typename
      }
      __typename
    }
    search(query: $query) {
      count
      resources {
        ...RSIShipDetailFragment
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment RSIShipDetailFragment on RSIShip {
  ...RSIShipBaseFragment
  isCustomizable
  body
  excerpt
  size
  maxCrew
  minCrew
  mass
  length
  beam
  height
  maxScmSpeed
  cargoCapacity
  afterburnerSpeed
  rotation_x
  rotation_y
  rotation_z
  offset_x
  offset_y
  offset_z
  viewable
  hasBuyingOptions
  chassisId
  skus { ...TySkuShipSkuFragment __typename }
  paints { ...TySkuShipSkuFragment __typename }
  shipVariants { ...RSIShipVariantFragment __typename }
  upgrades { ...TySkuUpgradeFragment __typename }
  manufacturer { ...RSIManufacturerMinimalFragment __typename }
  weapons { ...RSIShipWeaponFragment __typename }
  modular { ...RSIShipModularFragment __typename }
  propulsions { ...RSIShipPropulsionFragment __typename }
  avionics { ...RSIShipAvionicFragment __typename }
  thrusters { ...RSIShipThrusterFragment __typename }
  imageComposer { ...ImageComposerFragment __typename }
  media { ...TyItemMediaCtmFragment __typename }
  __typename
}

fragment TySkuUpgradeFragment on TySku {
  id
  title
  subtitle
  slug
  productId
  isWarbond
  stock { ...TyStockFragment __typename }
  __typename
}

fragment TyStockFragment on TyStock {
  unlimited
  show
  available
  backOrder
  qty
  backOrderQty
  level
  __typename
}

fragment RSIShipVariantFragment on RSIShip {
  id
  title
  slug
  msrp
  chassisId
  url
  media { thumbnail { storeSmall __typename } __typename }
  imageComposer { slot url name __typename }
  __typename
}

fragment RSIShipWeaponFragment on RSIShipWeapon {
  description
  manufacturerId
  details
  manufacturerName
  model
  name
  quantity
  size
  __typename
  weaponId
}

fragment RSIShipAvionicFragment on RSIShipAvionic {
  description
  manufacturerId
  details
  manufacturerName
  model
  name
  quantity
  size
  __typename
  avionicId
}

fragment RSIShipModularFragment on RSIShipModular {
  description
  manufacturerId
  details
  manufacturerName
  model
  name
  quantity
  size
  __typename
  modularId
}

fragment RSIShipPropulsionFragment on RSIShipPropulsion {
  description
  manufacturerId
  details
  manufacturerName
  model
  name
  quantity
  size
  __typename
  propulsionId
}

fragment RSIShipThrusterFragment on RSIShipThruster {
  description
  manufacturerId
  details
  manufacturerName
  model
  name
  quantity
  size
  __typename
  thrusterId
}

fragment RSIManufacturerMinimalFragment on RSIManufacturer {
  name
  __typename
}

fragment ImageComposerFragment on ImageComposer {
  name
  slot
  url
  __typename
}

fragment TyItemMediaCtmFragment on TyItemMedia {
  ctm
  __typename
}

fragment RSIShipBaseFragment on RSIShip {
  id
  title
  name
  url
  slug
  type
  focus
  msrp
  purchasable
  productionStatus
  lastUpdate
  publishStart
  __typename
}

fragment TySkuShipSkuFragment on TySku {
  id
  title
  subtitle
  slug
  productId
  isWarbond
  nativePrice { amount discounted discountDescription __typename }
  imageComposer { slot url name __typename }
  __typename
}`;

function mapShipComponent(raw: z.infer<typeof ShipComponent>): PledgeShipComponent {
  return {
    name: raw.name ?? '',
    model: raw.model ?? '',
    description: raw.description ?? '',
    manufacturerName: raw.manufacturerName ?? '',
    quantity: raw.quantity,
    size: raw.size ?? '',
  };
}

function pickThumb(images: ReadonlyArray<{ name: string; url: string }>, preferred: string[]): string {
  for (const name of preferred) {
    const hit = images.find((i) => i.name === name);
    if (hit?.url) return normalizeThumbnail(hit.url);
  }
  return images[0]?.url ? normalizeThumbnail(images[0].url) : '';
}

/**
 * Fetch the full spec sheet for a ship. `slug` is the DatoCMS slug (from
 * `PledgeShip.slug` on the Ships tab, or resolved via
 * `resolvePledgeSlugByName` for ships coming from the ship-matrix REST
 * endpoint). Returns null when the server has no resource for that slug
 * (typo, retired chassis) so callers can surface a "not found" state.
 */
export async function fetchPledgeShipDetail(slug: string): Promise<PledgeShipDetail | null> {
  const variables = {
    storeFront: 'pledge',
    query: {
      ships: {
        slugs: [slug],
        // Ask the server to compose 3 thumbnail sizes. Same pattern the
        // pledge-store SPA uses on its own detail page.
        imageComposer: [
          { name: '1024', size: 'SIZE_900', ratio: 'RATIO_16_9', extension: 'WEBP' },
          { name: '1440', size: 'SIZE_1000', ratio: 'RATIO_16_9', extension: 'WEBP' },
          { name: '2048', size: 'SIZE_1100', ratio: 'RATIO_16_9', extension: 'WEBP' },
        ],
        unslottedMedia: true,
      },
    },
  };

  const response = await fetchWithTimeout(`${RSI_BASE_URL}/graphql`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify([
      { operationName: 'GetShip', variables, query: GET_SHIP_QUERY },
    ]),
  });
  if (!response.ok) {
    throw new Error(`pledge ship detail returned ${response.status}`);
  }
  const raw = (await response.json()) as unknown;
  const parsed = GetShipResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`pledge ship detail: unexpected shape (${parsed.error.message})`);
  }
  const first = parsed.data[0];
  if (!first) return null;
  if (first.errors?.length) {
    throw new Error(`pledge ship detail errors: ${first.errors.map((e) => e.message).join('; ')}`);
  }
  const ship = first.data?.store?.search?.resources?.[0];
  if (!ship) return null;
  const pricing = first.data?.store?.context?.pricing;

  const hero = pickThumb(ship.imageComposer ?? [], ['1440', '1024', '2048']);
  return {
    id: ship.id,
    title: ship.title || ship.name,
    name: ship.name,
    slug: ship.slug,
    url: ship.url ?? '',
    type: ship.type ?? '',
    focus: ship.focus ?? '',
    msrp: ship.msrp,
    purchasable: ship.purchasable,
    productionStatus: ship.productionStatus ?? '',
    currencyCode: pricing?.currencyCode ?? 'USD',
    currencySymbol: pricing?.currencySymbol ?? '$',
    exponent: pricing?.exponent ?? 2,
    taxInclusive: pricing?.taxInclusive ?? true,
    body: ship.body ?? '',
    excerpt: ship.excerpt ?? '',
    size: ship.size ?? '',
    minCrew: ship.minCrew ?? null,
    maxCrew: ship.maxCrew ?? null,
    mass: ship.mass ?? null,
    length: ship.length ?? null,
    beam: ship.beam ?? null,
    height: ship.height ?? null,
    maxScmSpeed: ship.maxScmSpeed ?? null,
    afterburnerSpeed: ship.afterburnerSpeed ?? null,
    cargoCapacity: ship.cargoCapacity ?? null,
    manufacturerName: ship.manufacturer?.name ?? '',
    weapons: (ship.weapons ?? []).map(mapShipComponent),
    modular: (ship.modular ?? []).map(mapShipComponent),
    propulsions: (ship.propulsions ?? []).map(mapShipComponent),
    avionics: (ship.avionics ?? []).map(mapShipComponent),
    thrusters: (ship.thrusters ?? []).map(mapShipComponent),
    variants: (ship.shipVariants ?? []).map((v) => ({
      id: v.id,
      title: v.title,
      slug: v.slug,
      msrp: v.msrp,
      url: v.url ?? '',
      thumbnailUrl: v.media?.thumbnail?.storeSmall ?? '',
    })),
    paints: (ship.paints ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      subtitle: p.subtitle ?? '',
      slug: p.slug,
      thumbnailUrl: pickThumb(p.imageComposer ?? [], ['thumbnail']),
      isWarbond: p.isWarbond ?? false,
      price: p.nativePrice?.amount ?? 0,
      discountedPrice: p.nativePrice?.discounted ?? null,
      discountLabel: p.nativePrice?.discountDescription ?? '',
    })),
    skus: (ship.skus ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      subtitle: s.subtitle ?? '',
      slug: s.slug,
      thumbnailUrl: pickThumb(s.imageComposer ?? [], ['thumbnail']),
      isWarbond: s.isWarbond ?? false,
      price: s.nativePrice?.amount ?? 0,
      discountedPrice: s.nativePrice?.discounted ?? null,
      discountLabel: s.nativePrice?.discountDescription ?? '',
    })),
    thumbnailUrl: hero,
  };
}

/**
 * Last-resort slug fetch: download the ship's public URL and scrape the
 * DatoCMS slug out of the HTML. The pledge-store SPA bootstraps every
 * ship detail page with the slug embedded in its preloaded state JSON
 * (or a data attribute on the root element), so the slug is always
 * discoverable from the rendered HTML even when the pledge-ship-list
 * filters don't contain the ship (e.g. Cyclone, Greycat ROC — vehicles
 * retired from the on-sale catalogue but still pledgeable historically).
 *
 * DatoCMS slugs are a 13-char lowercase alnum string — strict enough to
 * avoid false positives against file hashes or other long IDs.
 */
export async function fetchPledgeSlugFromShipUrl(url: string): Promise<string | null> {
  if (!url) return null;
  const target = url.startsWith('http')
    ? url
    : `${RSI_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  try {
    const response = await fetchWithTimeout(target, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) return null;
    const html = await response.text();
    // Scan for the SPA's component-props data attribute first — that's
    // the canonical location on every ship detail page:
    //   <div data-rsi-component="ShipDetailPage"
    //        data-rsi-component-props='{…,"shipSlug":"kmte9k7mvctnq",…}'>
    // Fall back to looser JSON-ish and data-attr patterns for edge
    // templates (older chassis, subscriber-only variants, etc.).
    const patterns: readonly RegExp[] = [
      /"shipSlug"\s*:\s*"([a-z0-9]{13})"/,
      /data-ship-slug=["']([a-z0-9]{13})["']/,
      /"slug"\s*:\s*"([a-z0-9]{13})"/,
    ];
    for (const re of patterns) {
      const match = re.exec(html);
      if (match?.[1]) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a ship name (and optional URL) to the DatoCMS slug required by
 * `fetchPledgeShipDetail`. Used by callers (Ships module, CCU catalogue)
 * that only have the display name, not the slug. Tries three strategies
 * in order:
 *   1. Exact case/whitespace-insensitive name match
 *   2. Normalized name match (collapse hyphens/underscores/whitespace)
 *   3. URL match (both the ship matrix REST and the pledge GraphQL expose
 *      the same `/pledge/ships/<brand>/<ship>` URL — e.g. Sabre Comet in
 *      the matrix is "Sabre Comet" but in the pledge list "Comet", so
 *      name-only lookup fails but URL comparison succeeds)
 *
 * Handy pattern: pass the already-cached `fetchPledgeShipList()` result
 * here rather than re-querying. The background's cached pledge ship
 * list is the canonical source for this lookup.
 */
export function resolvePledgeSlugByName(
  name: string,
  ships: ReadonlyArray<Pick<PledgeShip, 'name' | 'slug' | 'url'>>,
  options: { url?: string | null } = {},
): string | null {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[-_\s]+/g, ' ')
      .trim();
  const target = name.trim().toLowerCase();

  if (target) {
    const byName = ships.find((s) => s.name.trim().toLowerCase() === target);
    if (byName?.slug) return byName.slug;

    const targetN = normalize(name);
    if (targetN) {
      const byNameN = ships.find((s) => normalize(s.name) === targetN);
      if (byNameN?.slug) return byNameN.slug;
    }
  }

  // URL fallback. Strip leading/trailing slashes + query/hash so
  // `/pledge/ships/aegis-avenger/Avenger-Stalker/` matches
  // `/pledge/ships/aegis-avenger/Avenger-Stalker`.
  const stripSlashes = (u: string) =>
    u.toLowerCase().replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  const targetUrl = options.url ? stripSlashes(options.url) : '';
  if (targetUrl) {
    const byUrl = ships.find((s) => stripSlashes(s.url ?? '') === targetUrl);
    if (byUrl?.slug) return byUrl.slug;
  }

  return null;
}

// --- Generic store browse ------------------------------------------------
//
// The pledge store has 10 user-visible sections (Ships / Ship Packs /
// Game Packages / Paints / Gear / Merchandise / Add-Ons / Event Tickets /
// Gift Cards / UEC) but under the hood they all use the SAME GraphQL
// operation — `GetBrowseSkusByFilter` — with different `facetIdentifiers`
// and `products` filters. A handful of sections share the same backend
// bucket and split client-side by HeapTags (Ship Packs + Gear both live
// under `extras-gear`; Add-Ons + Event Tickets + Gift Cards all live under
// `extras-add-ons`).
//
// We expose one unified `fetchStoreBrowse(categoryId)` function and let
// each category's config decide:
//   - which facetIdentifiers to send
//   - which products filter to scope to
//   - whether to post the filter under `skus` (SKU-driven listings — the
//     majority) or under `products` top-level (Merchandise uses a
//     product-type filter instead of a SKU/product pair)
//   - an optional client-side tag filter to split shared backend buckets
//     (Ship Packs vs Gear, Tickets vs Gift Cards vs Add-Ons)
//
// Ships remains on its dedicated `GetShipList` query because that response
// carries richer ship-specific fields (purchasable, productionStatus,
// manufacturer, crew count) the popup's rich card view consumes. The
// browse endpoint returns a generic TyItem that's fine for everything else.

export type StoreCategoryId =
  | 'ships'
  | 'ship-packs'
  | 'game-packages'
  | 'paints'
  | 'gear'
  | 'merchandise'
  | 'add-ons'
  | 'event-tickets'
  | 'gift-cards'
  | 'uec';

export interface StoreCategoryConfig {
  id: StoreCategoryId;
  label: string;
  /** RSI pledge-store path this category is canonically browsed at. */
  path: string;
  /** `facetIdentifiers` passed to the GraphQL query. Missing for categories
   *  that don't filter by facet (Ships has its own endpoint). */
  facet?: string;
  /** `products` scoping array passed to the query. */
  products?: number[];
  /** When true, pass `products` as the top-level filter key (Merchandise
   *  shape) instead of nested inside `skus` (majority shape). */
  productsTopLevel?: boolean;
  /** Types filter used by the merchandise shape. */
  productTypes?: string[];
}

// Each category's `facet` + `products` filter comes from inspecting what
// the pledge-store SPA itself sends when you land on that section. Many
// sibling categories share no backend — Ship Packs and Gear both live
// under different facets (`extras-packs` vs `extras-gear`), Gift Cards
// and Event Tickets are each their own facet too. Earlier versions of
// this config lumped them under `extras-add-ons` (the catch-all) which
// returned the Add-Ons rows for every sibling tab — hence the "empty"
// reports for Ship Packs / Gift Cards / Event Tickets.
export const STORE_CATEGORIES: ReadonlyArray<StoreCategoryConfig> = [
  { id: 'ships', label: 'Ships', path: '/pledge/ships' },
  {
    id: 'ship-packs',
    label: 'Ship Packs',
    path: '/store/pledge/browse/ship-packs',
    facet: 'extras-packs',
    products: [270],
  },
  {
    id: 'game-packages',
    label: 'Game Packages',
    path: '/store/pledge/browse/game-packages',
    facet: 'game-packages',
    products: [9, 45, 46],
  },
  {
    id: 'paints',
    label: 'Paints',
    path: '/store/pledge/browse/paints',
    facet: 'paints',
    products: [268],
  },
  {
    id: 'gear',
    label: 'Gear',
    path: '/store/pledge/browse/gear',
    facet: 'extras-gear',
    products: [289],
  },
  {
    id: 'merchandise',
    label: 'Merchandise',
    path: '/store/pledge/browse/merchandise',
    facet: 'merchandise',
    productsTopLevel: true,
    productTypes: ['merchandise'],
  },
  {
    id: 'add-ons',
    label: 'Add-Ons',
    path: '/store/pledge/browse/add-ons',
    facet: 'extras-add-ons',
    products: [3],
  },
  {
    id: 'event-tickets',
    label: 'Event Tickets',
    path: '/store/pledge/browse/event-tickets',
    facet: 'extras-event-tickets',
    products: [67],
  },
  {
    id: 'gift-cards',
    label: 'Gift Cards',
    path: '/store/pledge/browse/gift-cards',
    facet: 'extras-gift-cards',
    products: [60],
  },
  {
    id: 'uec',
    label: 'UEC',
    path: '/store/pledge/browse/uec',
    facet: 'extras-united-earth-credits',
    products: [41],
  },
];

const BROWSE_QUERY = `query GetBrowseSkusByFilter($query: SearchQuery, $storeFront: String = "pledge") {
  store(browse: true, name: $storeFront) {
    listing: search(query: $query) {
      resources {
        id
        slug
        name
        title
        subtitle
        url
        excerpt
        type
        media {
          thumbnail { slideshow storeSmall }
        }
        nativePrice { amount discounted discountDescription }
        stock { unlimited show available qty level }
        tags { name }
        ... on TySku {
          label
          isWarbond
          isPackage
          isVip
        }
      }
      count
      totalCount
      heapTagFiltersOptions {
        groupIdentifier
        facets {
          facet
          tagIdentifiers {
            identifier
            name
          }
        }
      }
    }
  }
}`;

export interface StoreItem {
  id: string;
  name: string;
  /** Longer variant — usually identical to `name`, occasionally has extra
   *  promo framing ("Warbond Edition", etc.). */
  title: string;
  /** Short descriptor shown as a type/category tag ("Package", "Sku"). */
  subtitle: string;
  /** Relative RSI path to the product detail page. */
  url: string;
  /** One-sentence teaser. Many items have long HTML `body` fields we
   *  intentionally skip — excerpt is enough for the popup's tile. */
  excerpt: string;
  /** Raw type token from GraphQL — "pledge", "sku", etc. */
  type: string;
  /** Primary thumbnail for the card (slideshow preferred, then storeSmall). */
  thumbnailUrl: string;
  /** Base price in cents (user's native currency). */
  msrp: number;
  /** Discounted price in cents, or null when no discount. */
  discounted: number | null;
  /** Machine-readable discount label ("25%", "10%", etc.). Empty when none. */
  discountLabel: string;
  /** Tags that also appear in the store UI — used for client-side
   *  sub-filtering (Ship Pack vs Gear, etc.). */
  tags: string[];
  /** Whether the SKU is currently purchasable. */
  available: boolean;
  /** Stock level hint from the server ('low' / 'medium' / 'high'). */
  stockLevel: string;
  /** Warbond SKUs — cheaper but LTI-less, limited availability. */
  isWarbond: boolean;
  /** Package SKU — bundles a ship + game package (or similar). */
  isPackage: boolean;
  /** VIP-gated items (subscriber perks, event exclusives). */
  isVip: boolean;
}

/** A single option in a server-driven filter group (e.g. "armor" / "clothing"
 *  under Gear; "standard" / "premium" / "limited-time" under Paints). */
export interface StoreFilterTag {
  /** ID to send back in `tagIdentifiers` when this tag is selected. */
  identifier: string;
  /** Display label (lowercase kebab in practice, the UI title-cases it). */
  name: string;
}

/** A group of server-provided filter facets. RSI returns one group per
 *  category — inside it, each facet (e.g. `gear`, `paint`) exposes a list
 *  of `tagIdentifiers` that the UI turns into chips/checkboxes. */
export interface StoreFilterGroup {
  groupIdentifier: string;
  facets: Array<{
    facet: string;
    tags: StoreFilterTag[];
  }>;
}

export interface StoreBrowseResult {
  categoryId: StoreCategoryId;
  items: StoreItem[];
  totalCount: number;
  /** Available sub-filters for this category, scraped from the server's
   *  `heapTagFiltersOptions`. The UI renders a chip per tag; clicking one
   *  re-fires the query with `tagIdentifiers` set. Empty when the category
   *  has no sub-filters (Game Packages, Add-Ons, Tickets, UEC, Gift Cards). */
  filterGroups: StoreFilterGroup[];
}

const RawStoreItem = z
  .object({
    id: z.union([z.string(), z.number()]).transform((v) => String(v)),
    slug: z.string().default(''),
    name: z.string().default(''),
    title: z.string().default(''),
    subtitle: z.string().nullable().default(''),
    url: z.string().nullable().default(''),
    excerpt: z.string().nullable().default(''),
    type: z.string().nullable().default(''),
    media: z
      .object({
        thumbnail: z
          .object({
            slideshow: z.string().nullable().optional(),
            storeSmall: z.string().nullable().optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    nativePrice: z
      .object({
        amount: z.coerce.number().int().default(0),
        discounted: z.coerce.number().int().nullable().optional(),
        discountDescription: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    stock: z
      .object({
        available: z.boolean().default(false),
        level: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    tags: z
      .array(z.object({ name: z.string().default('') }))
      .nullable()
      .optional(),
    label: z.string().nullable().optional(),
    isWarbond: z.boolean().nullable().optional(),
    isPackage: z.boolean().nullable().optional(),
    isVip: z.boolean().nullable().optional(),
  })
  .passthrough();

const RawFilterTag = z.object({
  identifier: z.string().default(''),
  name: z.string().default(''),
});
const RawFilterGroup = z.object({
  groupIdentifier: z.string().default(''),
  facets: z
    .array(
      z.object({
        facet: z.string().default(''),
        tagIdentifiers: z.array(RawFilterTag).default([]),
      }),
    )
    .default([]),
});

const BrowseBatchResponse = z.array(
  z.object({
    data: z
      .object({
        store: z
          .object({
            listing: z
              .object({
                resources: z.array(RawStoreItem).default([]),
                count: z.coerce.number().int().default(0),
                totalCount: z.coerce.number().int().default(0),
                heapTagFiltersOptions: z.array(RawFilterGroup).nullable().optional(),
              })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    errors: z.array(z.object({ message: z.string() })).nullable().optional(),
  }),
);

function mapStoreItem(raw: z.infer<typeof RawStoreItem>): StoreItem {
  // media.thumbnail mostly holds absolute URLs on the media CDN, but a
  // handful of SKUs (Handle Change Pass, some Add-Ons / Gift Cards) use
  // site-relative paths like `/media/<hash>/slideshow/Unavailable.jpg`.
  // Those MUST be prefixed with the main RSI host — the extension's
  // origin is `chrome-extension://...`, so a bare `/media/...` href
  // resolves to an extension-local 404. The media CDN *does not* serve
  // that path either (only direct-file URLs).
  const thumb =
    raw.media?.thumbnail?.slideshow ?? raw.media?.thumbnail?.storeSmall ?? '';
  const price = raw.nativePrice;
  return {
    id: raw.id,
    name: raw.name || raw.title,
    title: raw.title || raw.name,
    subtitle: raw.subtitle ?? '',
    url: raw.url ?? '',
    excerpt: raw.excerpt ?? '',
    type: raw.type ?? '',
    thumbnailUrl: normalizeThumbnail(thumb ?? ''),
    msrp: price?.amount ?? 0,
    discounted: price?.discounted ?? null,
    discountLabel: price?.discountDescription ?? '',
    tags: (raw.tags ?? []).map((t) => t.name).filter(Boolean),
    available: raw.stock?.available ?? false,
    stockLevel: raw.stock?.level ?? '',
    isWarbond: raw.isWarbond ?? false,
    isPackage: raw.isPackage ?? false,
    isVip: raw.isVip ?? false,
  };
}

/** Look up a category by id. Returns null for unknown ids. */
export function getStoreCategory(id: StoreCategoryId): StoreCategoryConfig | null {
  return STORE_CATEGORIES.find((c) => c.id === id) ?? null;
}

/**
 * Fetch items for a given pledge-store category. Ships is special-cased
 * — the UI should use `fetchPledgeShipList` for that, which returns richer
 * ship-specific metadata. Calling this with `'ships'` throws to make that
 * misuse loud instead of silently empty.
 *
 * `tagIdentifiers` narrows the result server-side (e.g. Gear → armor only;
 * Paints → limited-time only). Pass an empty array for the full category.
 */
export async function fetchStoreBrowse(
  categoryId: StoreCategoryId,
  tagIdentifiers: string[] = [],
): Promise<StoreBrowseResult> {
  const cat = getStoreCategory(categoryId);
  if (!cat) throw new Error(`unknown store category: ${categoryId}`);
  if (cat.id === 'ships') {
    throw new Error(
      "fetchStoreBrowse('ships') is not supported — use fetchPledgeShipList for the richer ships query",
    );
  }

  // Two variable shapes: `skus` (default — used by Ship Packs, Game
  // Packages, Paints, Gear, Add-Ons, Tickets, Gift Cards, UEC) and
  // `products` top-level (Merchandise).
  const filter = {
    filtersFromTags: {
      tagIdentifiers,
      facetIdentifiers: cat.facet ? [cat.facet] : [],
    },
    ...(cat.productsTopLevel
      ? { types: cat.productTypes ?? [] }
      : { products: cat.products ?? [] }),
  };
  const variables = {
    storeFront: 'pledge',
    query: {
      page: 1,
      limit: 100,
      ...(cat.productsTopLevel ? { products: filter } : { skus: filter }),
      sort: { field: 'weight', direction: 'desc' },
    },
  };

  const response = await fetchWithTimeout(`${RSI_BASE_URL}/graphql`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify([
      { operationName: 'GetBrowseSkusByFilter', variables, query: BROWSE_QUERY },
    ]),
  });
  if (!response.ok) {
    throw new Error(`pledge browse returned ${response.status}`);
  }
  const raw = (await response.json()) as unknown;
  const parsed = BrowseBatchResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`pledge browse: unexpected shape (${parsed.error.message})`);
  }
  const first = parsed.data[0];
  if (!first) throw new Error('pledge browse: empty batch response');
  if (first.errors?.length) {
    throw new Error(`pledge browse errors: ${first.errors.map((e) => e.message).join('; ')}`);
  }
  const listing = first.data?.store?.listing;
  const items = (listing?.resources ?? []).map(mapStoreItem);

  const filterGroups: StoreFilterGroup[] = (listing?.heapTagFiltersOptions ?? []).map(
    (g) => ({
      groupIdentifier: g.groupIdentifier,
      facets: g.facets.map((f) => ({
        facet: f.facet,
        tags: f.tagIdentifiers.map((t) => ({ identifier: t.identifier, name: t.name })),
      })),
    }),
  );

  return {
    categoryId: cat.id,
    items,
    totalCount: listing?.totalCount ?? items.length,
    filterGroups,
  };
}

// --- Generic add-to-cart -------------------------------------------------
//
// Non-CCU store items (ships, paints, gear, game packages, merch, add-ons,
// tickets, gift cards, UEC) all share a single mutation: `AddCartMultiItem`
// on the main `/graphql` endpoint. Unlike the CCU flow this is ONE round
// trip — no JWT + cart/token dance. Just a mutation that takes an array
// of {qty, skuId} and returns the newly-added line items.
//
// Server accepts multiple items in a single call (the `addMany` name is
// literal) but we currently only call it with one item per click. Left
// the array shape intact so the contract matches the SPA and bulk-add
// is trivial to layer on top later.

const ADD_CART_MULTI_MUTATION = `mutation AddCartMultiItemMutation($query: [CartAddInput!], $storeFront: String = "pledge") {
  store(name: $storeFront) {
    cart {
      mutations {
        addMany(query: $query) {
          count
          resources {
            id
            title
          }
        }
      }
    }
  }
}`;

const AddCartMultiResponse = z.array(
  z.object({
    data: z
      .object({
        store: z
          .object({
            cart: z
              .object({
                mutations: z
                  .object({
                    addMany: z
                      .object({
                        count: z.coerce.number().int().default(0),
                        resources: z.array(z.object({}).passthrough()).nullable().optional(),
                      })
                      .nullable()
                      .optional(),
                  })
                  .nullable()
                  .optional(),
              })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    errors: z.array(z.object({ message: z.string() })).nullable().optional(),
  }),
);

export interface AddCartItem {
  skuId: string;
  qty: number;
}

/**
 * Add one or more SKUs to the user's pledge-store cart. Covers every
 * non-CCU item type — ships (via specific SKU), paints, gear, game
 * packages, merch, add-ons, tickets, gift cards, UEC.
 *
 * Requires the user to be signed in. Missing CSRF is surfaced through
 * the standard "Token not set" error that the background's
 * `withCsrfRetry` wrapper converts into a scripting re-prime + retry.
 */
export async function addSkusToCart(items: AddCartItem[]): Promise<void> {
  if (items.length === 0) return;
  const csrf = await fetchRsiCsrfToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'x-kl-ajax-request': 'Ajax_Request',
  };
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/graphql`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify([
      {
        operationName: 'AddCartMultiItemMutation',
        variables: {
          storeFront: 'pledge',
          query: items.map((i) => ({ qty: i.qty, skuId: i.skuId })),
        },
        query: ADD_CART_MULTI_MUTATION,
      },
    ]),
  });
  if (!response.ok) {
    throw new Error(`add to cart returned ${response.status}`);
  }
  const raw = (await response.json()) as unknown;
  const parsed = AddCartMultiResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`add to cart: unexpected shape (${parsed.error.message})`);
  }
  const first = parsed.data[0];
  if (!first) throw new Error('add to cart: empty batch response');
  if (first.errors?.length) {
    throw new Error(`add to cart errors: ${first.errors.map((e) => e.message).join('; ')}`);
  }
  const count = first.data?.store?.cart?.mutations?.addMany?.count ?? 0;
  if (count === 0) {
    // Server accepted the request and returned 200 but added zero items
    // — usually means out-of-stock, purchasable=false, or a permissions
    // gate (subscriber-only item while signed in as a regular user).
    throw new Error('add to cart: no items added (out of stock or unavailable)');
  }
}

// --- Mini cart ------------------------------------------------------------
//
// Read-only view of the user's pledge-store cart. The SPA polls this same
// `GetMiniCartWidgetQuery` op to populate its header cart widget. The
// response carries pricing context (the user's currency + exchange rate),
// totals (subtotal + tax-inclusive total), and per-line-item data rich
// enough to render the cart inline without a second fetch.
//
// Checkout itself stays on RSI — we deep-link to /pledge/cart for payment.

const CartLineItem = z
  .object({
    id: z.union([z.string(), z.number()]).transform((v) => String(v)),
    skuId: z.union([z.string(), z.number()]).transform((v) => String(v)).optional(),
    qty: z.coerce.number().int().default(1),
    identifier: z.string().nullable().optional(),
    unitPriceWithTax: z
      .object({
        amount: z.coerce.number().int().default(0),
        discounted: z.coerce.number().int().nullable().optional(),
        discountDescription: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    sku: z
      .object({
        id: z.union([z.string(), z.number()]).transform((v) => String(v)).optional(),
        label: z.string().nullable().optional(),
        subtitle: z.string().nullable().optional(),
        isWarbond: z.boolean().nullable().optional(),
        media: z
          .object({
            thumbnail: z
              .object({ storeSmall: z.string().nullable().optional() })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    upgrade: z.object({ name: z.string().default('') }).nullable().optional(),
  })
  .passthrough();

const CartResponse = z.array(
  z.object({
    data: z
      .object({
        store: z
          .object({
            context: z
              .object({
                pricing: z
                  .object({
                    currencyCode: z.string().default('USD'),
                    currencySymbol: z.string().default('$'),
                    exponent: z.coerce.number().int().default(2),
                    taxInclusive: z.boolean().default(true),
                  })
                  .nullable()
                  .optional(),
              })
              .nullable()
              .optional(),
            cart: z
              .object({
                id: z.union([z.string(), z.number()]).transform((v) => String(v)).optional(),
                totals: z
                  .object({
                    subTotal: z.coerce.number().int().default(0),
                    total: z.coerce.number().int().default(0),
                  })
                  .nullable()
                  .optional(),
                lineItemsQties: z.coerce.number().int().default(0),
                lineItems: z.array(CartLineItem).nullable().optional(),
              })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    errors: z.array(z.object({ message: z.string() })).nullable().optional(),
  }),
);

export interface PledgeCartLineItem {
  /** Line-item id (not the SKU id — the same sku added twice produces
   *  two distinct line items). */
  id: string;
  skuId: string;
  /** Disambiguator when multiple line items share the same skuId — e.g.
   *  CCU line items use `"<fromShipId>_<toSkuId>"`. Required to target
   *  a specific line item with `removeCartItem`. Empty string for
   *  plain-SKU line items. */
  identifier: string;
  qty: number;
  /** Display name. Prefer `upgrade.name` for CCU line items (fuller
   *  context "Upgrade - X to Y"), else `sku.label`. */
  title: string;
  subtitle: string;
  /** Unit price including tax, in native-currency minor units
   *  (divide by `exponent` decimals for display). */
  unitPrice: number;
  discountedUnitPrice: number | null;
  discountLabel: string;
  thumbnailUrl: string;
  isWarbond: boolean;
  /** True when this line is a CCU / ship upgrade — UI can style it
   *  differently (amber badge) so users see at a glance what they're
   *  about to buy. */
  isUpgrade: boolean;
}

export interface PledgeCart {
  id: string | null;
  currencyCode: string;
  currencySymbol: string;
  /** Number of decimals the native currency uses (2 for most, 0 for JPY, etc.). */
  exponent: number;
  taxInclusive: boolean;
  subTotal: number;
  total: number;
  /** Total quantity across all line items (with repeats). */
  itemsQty: number;
  lineItems: PledgeCartLineItem[];
}

const GET_MINI_CART_QUERY = `query GetMiniCartWidgetQuery($storeFront: String) {
  store(name: $storeFront) {
    context {
      pricing {
        currencyCode
        currencySymbol
        exponent
        taxInclusive
      }
    }
    cart {
      id
      totals { subTotal total }
      lineItemsQties
      lineItems {
        id
        skuId
        qty
        identifier
        unitPriceWithTax { amount discounted discountDescription }
        sku {
          id
          label
          subtitle
          isWarbond
          media { thumbnail { storeSmall } }
        }
        ... on ShipUpgradeLineItem {
          upgrade { name }
        }
      }
    }
  }
}`;

export async function fetchPledgeCart(): Promise<PledgeCart> {
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/graphql`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-kl-ajax-request': 'Ajax_Request',
    },
    body: JSON.stringify([
      {
        operationName: 'GetMiniCartWidgetQuery',
        variables: { storeFront: 'pledge' },
        query: GET_MINI_CART_QUERY,
      },
    ]),
  });
  if (!response.ok) {
    throw new Error(`cart: ${response.status}`);
  }
  const raw = (await response.json()) as unknown;
  const parsed = CartResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`cart: unexpected shape (${parsed.error.message})`);
  }
  const first = parsed.data[0];
  if (!first) throw new Error('cart: empty batch response');
  if (first.errors?.length) {
    throw new Error(`cart errors: ${first.errors.map((e) => e.message).join('; ')}`);
  }
  const pricing = first.data?.store?.context?.pricing;
  const cart = first.data?.store?.cart;
  const lineItems = (cart?.lineItems ?? []).map<PledgeCartLineItem>((li) => {
    const isUpgrade = !!li.upgrade?.name;
    return {
      id: li.id,
      skuId: li.skuId ?? '',
      identifier: li.identifier ?? '',
      qty: li.qty,
      title: (li.upgrade?.name?.trim() || li.sku?.label) ?? '(unnamed)',
      subtitle: li.sku?.subtitle ?? '',
      unitPrice: li.unitPriceWithTax?.amount ?? 0,
      discountedUnitPrice: li.unitPriceWithTax?.discounted ?? null,
      discountLabel: li.unitPriceWithTax?.discountDescription ?? '',
      thumbnailUrl: li.sku?.media?.thumbnail?.storeSmall ?? '',
      isWarbond: li.sku?.isWarbond ?? false,
      isUpgrade,
    };
  });
  return {
    id: cart?.id ?? null,
    currencyCode: pricing?.currencyCode ?? 'USD',
    currencySymbol: pricing?.currencySymbol ?? '$',
    exponent: pricing?.exponent ?? 2,
    taxInclusive: pricing?.taxInclusive ?? true,
    subTotal: cart?.totals?.subTotal ?? 0,
    total: cart?.totals?.total ?? 0,
    itemsQty: cart?.lineItemsQties ?? 0,
    lineItems,
  };
}

// --- Cart mutations (remove, clear) ---------------------------------------
//
// Both mutations live on the main `/graphql` endpoint and share the same
// CSRF + Kasada-marker header contract as `addSkusToCart`. The full SPA
// queries also pull a huge upsells/fragments payload; we strip that
// since the popup re-fetches the cart via `fetchPledgeCart` after each
// mutation anyway.

const REMOVE_CART_ITEM_MUTATION = `mutation RemoveCartItemAutomatedUpsellsMutation($skuId: ID!, $identifier: String, $storeFront: String) {
  store(name: $storeFront) {
    cart {
      mutations {
        remove(skuId: $skuId, identifier: $identifier)
      }
    }
  }
}`;

const CLEAR_CART_MUTATION = `mutation ClearCartMutation($storeFront: String) {
  store(name: $storeFront) {
    cart {
      mutations {
        clear
      }
    }
  }
}`;

const CartMutationBoolResponse = z.array(
  z.object({
    data: z
      .object({
        store: z
          .object({
            cart: z
              .object({
                mutations: z
                  .object({
                    remove: z.boolean().nullable().optional(),
                    clear: z.boolean().nullable().optional(),
                  })
                  .nullable()
                  .optional(),
              })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    errors: z.array(z.object({ message: z.string() })).nullable().optional(),
  }),
);

async function postCartMutation(operationName: string, query: string, variables: unknown): Promise<{
  remove: boolean | null;
  clear: boolean | null;
}> {
  const csrf = await fetchRsiCsrfToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'x-kl-ajax-request': 'Ajax_Request',
  };
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/graphql`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify([{ operationName, variables, query }]),
  });
  if (!response.ok) {
    throw new Error(`${operationName}: ${response.status}`);
  }
  const raw = (await response.json()) as unknown;
  const parsed = CartMutationBoolResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${operationName}: unexpected shape (${parsed.error.message})`);
  }
  const first = parsed.data[0];
  if (!first) throw new Error(`${operationName}: empty batch response`);
  if (first.errors?.length) {
    throw new Error(`${operationName} errors: ${first.errors.map((e) => e.message).join('; ')}`);
  }
  const mut = first.data?.store?.cart?.mutations;
  return {
    remove: mut?.remove ?? null,
    clear: mut?.clear ?? null,
  };
}

/**
 * Remove one line item from the cart. `skuId` + `identifier` together
 * uniquely target a line — CCU line items use `identifier` to
 * disambiguate same-SKU-multiple-lines (one per fromShip), non-CCU
 * items pass an empty string.
 */
export async function removeCartItem(skuId: string, identifier: string): Promise<void> {
  const result = await postCartMutation(
    'RemoveCartItemAutomatedUpsellsMutation',
    REMOVE_CART_ITEM_MUTATION,
    { skuId, identifier, storeFront: 'pledge' },
  );
  if (result.remove !== true) {
    throw new Error('remove: server refused (item may already be gone)');
  }
}

/** Clear the user's entire pledge cart. Destructive — UI layer should
 *  confirm before calling. */
export async function clearCart(): Promise<void> {
  const result = await postCartMutation(
    'ClearCartMutation',
    CLEAR_CART_MUTATION,
    { storeFront: 'pledge' },
  );
  if (result.clear !== true) {
    throw new Error('clear: server refused');
  }
}

// --- CCU (Cross-Chassis Upgrade) -----------------------------------------
//
// The CCU flow doesn't live at a dedicated URL anymore — it's embedded in
// the pledge-store SPA and driven by TWO GraphQL operations against a
// separate endpoint (`/pledge-store/api/upgrade/graphql`, not the global
// `/graphql` the browse catalogue uses):
//
//   initShipUpgrade — full catalogue of every ship the user can pick as
//                     source or target, with a server-side `owned` flag per
//                     ship (cross-checked against their hangar), per-ship
//                     base MSRP, and all sellable SKUs. Fire once per
//                     session; cached at the handler layer.
//
//   filterShips(fromId) — given a source ship id, returns the eligible
//                     target ships with their `upgradePrice` (the real CCU
//                     cost, after any discount CIG has currently applied).
//                     This is the number the extension wants to display —
//                     MSRP delta is only an estimate; upgradePrice is
//                     authoritative.
//
// The extension drives the full upgrade flow itself — CSRF priming
// (`primeCsrfFromOpenTabs` in the background), upgrade-session bootstrap
// (`primeCcuSession` below), the CCU GraphQL calls, and the two-step
// add-to-cart dance (`addCcuToCart`). Payment is the only thing that
// stays on RSI: the extension deep-links to `/pledge/cart` and the user
// enters card details there.

const CCU_GRAPHQL_URL = `${RSI_BASE_URL}/pledge-store/api/upgrade/graphql`;
const SET_AUTH_TOKEN_URL = `${RSI_BASE_URL}/api/account/v2/setAuthToken`;
const SET_CONTEXT_TOKEN_URL = `${RSI_BASE_URL}/api/ship-upgrades/setContextToken`;

// --- CCU session bootstrap ------------------------------------------------
//
// The /pledge-store/api/upgrade/graphql endpoint won't accept a bare CSRF
// header on a cold session — it responds "Token not set" for every op
// until the client has called two bootstrap endpoints:
//
//   1. POST /api/account/v2/setAuthToken   body {}                           → returns a JWT
//   2. POST /api/ship-upgrades/setContextToken body {fromShipId: null, …}    → OK
//
// Both require the `x-rsi-token` header (= Rsi-Token session cookie value)
// and the Kasada ajax marker. The pair establishes a per-session "upgrade
// context" on the server which subsequent GraphQL calls key off. We run
// both on the first CCU call of a SW lifetime, and cache a flag so we
// skip the dance on subsequent calls. Cookie-change handlers invalidate
// the flag so a sign-in/out correctly re-primes on next use.

let ccuSessionPrimed = false;
// `Promise<void>` — the IIFE signals success by setting `ccuSessionPrimed`
// before resolving, and throws on failure. Callers only need to await
// completion, not a return value.
let ccuSessionInFlight: Promise<void> | null = null;

export function invalidateCcuSession(): void {
  ccuSessionPrimed = false;
  ccuSessionInFlight = null;
}

/** Whether the CCU upgrade session has been successfully bootstrapped
 *  (setAuthToken + setContextToken both returned 200). Used by the
 *  Settings module's session-status panel. */
export function isCcuSessionPrimed(): boolean {
  return ccuSessionPrimed;
}

export async function primeCcuSession(): Promise<void> {
  if (ccuSessionPrimed) return;
  if (ccuSessionInFlight) return ccuSessionInFlight;
  ccuSessionInFlight = (async () => {
    try {
      const token = await readRsiToken();
      if (!token) {
        throw new Error('ccu session: sign-in required (no Rsi-Token cookie)');
      }
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=UTF-8',
        'x-rsi-token': token,
        'x-kl-ajax-request': 'Ajax_Request',
      };
      // Step 1 — setAuthToken. Body is a literal `{}`. Response echoes a
      // JWT we don't need to capture (the server stores it on the
      // session); we only care that the call succeeds.
      const auth = await fetchWithTimeout(SET_AUTH_TOKEN_URL, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: '{}',
      });
      if (!auth.ok) {
        throw new Error(`ccu session: setAuthToken returned ${auth.status}`);
      }

      // Step 2 — setContextToken. Opens a fresh upgrade context with no
      // preselected ships. The pledge-store SPA sends this exact payload.
      const ctx = await fetchWithTimeout(SET_CONTEXT_TOKEN_URL, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          fromShipId: null,
          toShipId: null,
          toSkuId: null,
          pledgeId: null,
        }),
      });
      if (!ctx.ok) {
        throw new Error(`ccu session: setContextToken returned ${ctx.status}`);
      }

      ccuSessionPrimed = true;
    } finally {
      ccuSessionInFlight = null;
    }
  })();
  return ccuSessionInFlight;
}

const INIT_SHIP_UPGRADE_QUERY = `query initShipUpgrade {
  ships {
    id
    name
    medias { productThumbMediumAndSmall slideShow }
    manufacturer { id name }
    focus
    type
    flyableStatus
    owned
    msrp
    link
    skus { id title available price body unlimitedStock availableStock }
  }
  manufacturers { id name }
  app {
    isAnonymous
    buyback { credit }
  }
}`;

const FILTER_SHIPS_QUERY = `query filterShips($fromId: Int, $toId: Int, $fromFilters: [FilterConstraintValues], $toFilters: [FilterConstraintValues]) {
  from(to: $toId, filters: $fromFilters) { ships { id } }
  to(from: $fromId, filters: $toFilters) {
    featured { reason style tagLabel tagStyle footNotes shipId }
    ships {
      id
      skus {
        id
        price
        upgradePrice
        unlimitedStock
        showStock
        available
        availableStock
      }
    }
  }
}`;

const CcuSku = z.object({
  id: z.coerce.number().int(),
  title: z.string().default(''),
  available: z.boolean().default(false),
  price: z.coerce.number().int().default(0),
  body: z.string().nullable().optional(),
  unlimitedStock: z.boolean().default(false),
  availableStock: z.coerce.number().int().default(0),
});
export type CcuSku = z.infer<typeof CcuSku>;

const CcuShip = z.object({
  id: z.coerce.number().int(),
  name: z.string().default(''),
  medias: z
    .object({
      productThumbMediumAndSmall: z.string().nullable().optional(),
      slideShow: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  manufacturer: z
    .object({ id: z.coerce.number().int(), name: z.string().default('') })
    .nullable()
    .optional(),
  focus: z.string().nullable().default(''),
  type: z.string().nullable().default(''),
  flyableStatus: z.string().nullable().default(''),
  owned: z.boolean().default(false),
  msrp: z.coerce.number().int().default(0),
  link: z.string().nullable().default(''),
  // skus can legitimately be null for chassis CIG lists in the upgrade tool
  // as valid targets but doesn't currently sell a standalone SKU for
  // (variants, retired concept skus etc.). Coerce null → [] so downstream
  // code can always iterate without a guard.
  skus: z.array(CcuSku).nullable().default([]),
});

export interface CcuCatalogue {
  ships: Array<{
    id: number;
    name: string;
    manufacturerId: number;
    manufacturerName: string;
    focus: string;
    type: string;
    flyableStatus: string;
    owned: boolean;
    msrp: number;
    link: string;
    thumbnailUrl: string;
    skus: CcuSku[];
  }>;
  manufacturers: Array<{ id: number; name: string }>;
  buybackCredit: number;
  isAnonymous: boolean;
}

const CcuInitResponse = z.array(
  z.object({
    data: z
      .object({
        // `ships` can be `null` when the session is fresh / anonymous —
        // nullable+default coerces to [] so downstream `.filter(...)`
        // doesn't NPE. Same pattern as `skus` further up.
        ships: z.array(CcuShip).nullable().default([]),
        manufacturers: z
          .array(
            z.object({
              id: z.coerce.number().int(),
              name: z.string().default(''),
            }),
          )
          .nullable()
          .default([]),
        app: z
          .object({
            isAnonymous: z.boolean().default(false),
            buyback: z
              .object({ credit: z.coerce.number().int().default(0) })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    errors: z.array(z.object({ message: z.string() })).nullable().optional(),
  }),
);

async function postCcuGraphql(body: unknown, retry = true): Promise<unknown> {
  // Three gating layers for the CCU GraphQL endpoint:
  //   1. `primeCcuSession()` — runs setAuthToken + setContextToken once
  //      per SW lifetime. WITHOUT this the server returns "Token not
  //      set" even when the CSRF header is valid.
  //   2. `x-csrf-token` — read from the `<meta name="csrf-token">` tag
  //      in any open RSI tab (primed by the background) or scraped
  //      from a rendered page.
  //   3. `x-kl-ajax-request: Ajax_Request` — anti-bot marker the SPA
  //      always sends; the edge layer rejects without it.
  //
  // Failure modes we retry:
  //   - HTTP 403 (cached token was valid but server rotated it)
  //   - HTTP 200 + GraphQL error containing "Token not set" (any of the
  //     three layers was missing — most commonly a fresh SW with an
  //     un-primed session, or a rotated CSRF)
  // On retry we invalidate BOTH the CSRF cache AND the session-primed
  // flag, which re-runs the full bootstrap dance.
  await primeCcuSession();
  const csrf = await fetchRsiCsrfToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    // Required marker on CCU GraphQL requests. RSI's edge layer checks
    // for this header and returns "Token not set" on CSRF-protected
    // endpoints if it's missing — even when a valid x-csrf-token IS
    // supplied. The SPA always sends it; we match the shape verbatim.
    'x-kl-ajax-request': 'Ajax_Request',
  };
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetchWithTimeout(CCU_GRAPHQL_URL, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body),
  });
  if (response.status === 403 && retry) {
    invalidateCsrfToken();
    invalidateCcuSession();
    return postCcuGraphql(body, false);
  }
  if (!response.ok) {
    throw new Error(`ccu GraphQL returned ${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  if (retry && hasTokenNotSetError(payload)) {
    invalidateCsrfToken();
    invalidateCcuSession();
    return postCcuGraphql(body, false);
  }
  return payload;
}

/** True when a CCU batch response contains at least one "Token not set"
 *  GraphQL error. That's the server's way of signaling a stale/missing
 *  CSRF token through the GraphQL layer (instead of an HTTP 403). */
function hasTokenNotSetError(payload: unknown): boolean {
  if (!Array.isArray(payload)) return false;
  for (const entry of payload) {
    const errors = (entry as { errors?: Array<{ message?: string }> })?.errors;
    if (!Array.isArray(errors)) continue;
    for (const e of errors) {
      if (typeof e?.message === 'string' && /token not set/i.test(e.message)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Fetch the CCU catalogue — every ship CIG exposes to the upgrade tool,
 * with the user's hangar ownership flag pre-resolved server-side.
 * Returns ships sorted by name within manufacturer (we let the UI regroup).
 */
export async function fetchCcuInit(): Promise<CcuCatalogue> {
  const raw = await postCcuGraphql([
    { operationName: 'initShipUpgrade', variables: {}, query: INIT_SHIP_UPGRADE_QUERY },
  ]);
  const parsed = CcuInitResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`ccu init: unexpected shape (${parsed.error.message})`);
  }
  const first = parsed.data[0];
  if (!first) throw new Error('ccu init: empty batch response');
  if (first.errors?.length) {
    throw new Error(`ccu init errors: ${first.errors.map((e) => e.message).join('; ')}`);
  }
  const data = first.data;
  if (!data) throw new Error('ccu init: missing data');

  const ships = (data.ships ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    manufacturerId: s.manufacturer?.id ?? 0,
    manufacturerName: s.manufacturer?.name ?? '',
    focus: s.focus ?? '',
    type: s.type ?? '',
    flyableStatus: s.flyableStatus ?? '',
    owned: s.owned,
    msrp: s.msrp,
    link: s.link ?? '',
    thumbnailUrl: s.medias?.productThumbMediumAndSmall ?? '',
    skus: s.skus ?? [],
  }));

  const manufacturers = (data.manufacturers ?? [])
    .map((m) => ({ id: m.id, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    ships,
    manufacturers,
    buybackCredit: data.app?.buyback?.credit ?? 0,
    isAnonymous: data.app?.isAnonymous ?? true,
  };
}

const CcuTargetSku = z.object({
  id: z.coerce.number().int(),
  /** Destination ship's SKU price (base). Displayed as "target value". */
  price: z.coerce.number().int().default(0),
  /** ACTUAL upgrade cost for this route (source→target). Null when the
   *  query was issued without a fromId, or when the route isn't currently
   *  sold as a CCU (expired concept, removed chassis, etc.). */
  upgradePrice: z.coerce.number().int().nullable().default(null),
  unlimitedStock: z.boolean().default(false),
  showStock: z.boolean().default(false),
  available: z.boolean().default(false),
  availableStock: z.coerce.number().int().default(0),
});
export type CcuTargetSku = z.infer<typeof CcuTargetSku>;

const CcuFiltered = z.object({
  from: z
    .object({ ships: z.array(z.object({ id: z.coerce.number().int() })).default([]) })
    .nullable()
    .optional(),
  to: z
    .object({
      featured: z
        .array(
          z.object({
            shipId: z.coerce.number().int(),
            reason: z.string().nullable().optional(),
            style: z.string().nullable().optional(),
            tagLabel: z.string().nullable().optional(),
            tagStyle: z.string().nullable().optional(),
            footNotes: z.string().nullable().optional(),
          }),
        )
        .nullable()
        .optional(),
      ships: z
        .array(
          z.object({
            id: z.coerce.number().int(),
            skus: z.array(CcuTargetSku).default([]),
          }),
        )
        .default([]),
    })
    .nullable()
    .optional(),
});

const CcuFilterResponse = z.array(
  z.object({
    data: CcuFiltered.nullable().optional(),
    errors: z.array(z.object({ message: z.string() })).nullable().optional(),
  }),
);

export interface CcuTargetsResult {
  /** Ship ids the user can select as a source when targeting another ship. */
  fromShipIds: number[];
  /** Ship ids that are reachable as targets from the caller's chosen source. */
  targets: Array<{
    shipId: number;
    skus: CcuTargetSku[];
    /** Lowest upgradePrice among this ship's CCU skus, in cents. null when
     *  the route exists but all skus reported null upgradePrice (e.g. the
     *  ship isn't a CCU destination, or the user picked no source). */
    minUpgradePrice: number | null;
  }>;
}

/**
 * Given a source ship id, query the upgrade graph for eligible targets.
 * Returns the ship ids that have a SKU path from `fromId`, plus the
 * per-ship skus with the real `upgradePrice` the user will pay. Pass
 * `fromId: null` to get the catalogue of all possible sources without
 * computing upgrade prices.
 */
export async function fetchCcuTargets(fromId: number | null): Promise<CcuTargetsResult> {
  const raw = await postCcuGraphql([
    {
      operationName: 'filterShips',
      variables: {
        fromId,
        toId: null,
        fromFilters: [],
        toFilters: [],
      },
      query: FILTER_SHIPS_QUERY,
    },
  ]);
  const parsed = CcuFilterResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`ccu filter: unexpected shape (${parsed.error.message})`);
  }
  const first = parsed.data[0];
  if (!first) throw new Error('ccu filter: empty batch response');
  if (first.errors?.length) {
    throw new Error(`ccu filter errors: ${first.errors.map((e) => e.message).join('; ')}`);
  }
  const data = first.data;
  if (!data) return { fromShipIds: [], targets: [] };

  const fromShipIds = (data.from?.ships ?? []).map((s) => s.id);
  const targets = (data.to?.ships ?? []).map((t) => {
    const prices = t.skus
      .map((s) => s.upgradePrice)
      .filter((p): p is number => typeof p === 'number');
    return {
      shipId: t.id,
      skus: t.skus,
      minUpgradePrice: prices.length > 0 ? Math.min(...prices) : null,
    };
  });
  return { fromShipIds, targets };
}

// --- Add-to-cart ---------------------------------------------------------
//
// Adding a CCU to the cart is a two-step dance, mirroring what the
// pledge-store SPA does behind its "Add to Cart" button:
//
//   1. Mutation `addToCart(from, to)` on /pledge-store/api/upgrade/graphql,
//      gated by the CSRF header. Returns a short-lived JWT that encodes the
//      SKU, source ship, price, and cart action (type: "UPGRADE").
//
//   2. POST /api/store/v2/cart/token with `{ jwt }`, gated by `x-rsi-token`
//      (the session cookie value). Server decodes the JWT, verifies the
//      signature, and commits the line item to the cart. Returns
//      `{ success: 1, code: "OK" }` on success.
//
// The two endpoints use DIFFERENT auth schemes (csrf vs rsi-token) because
// they live in different backend services — the upgrade GraphQL runs in the
// pledge-store app, the cart commit runs in the core store-v2 API.
//
// The JWT has a 30-second exp (visible in the decoded payload) so we commit
// it immediately and surface a clear error if step 2 fails — retrying later
// with the same JWT won't work.

const CART_TOKEN_URL = `${RSI_BASE_URL}/api/store/v2/cart/token`;

const AddToCartResponse = z.array(
  z.object({
    data: z
      .object({
        addToCart: z
          .object({ jwt: z.string().default('') })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
    errors: z.array(z.object({ message: z.string() })).nullable().optional(),
  }),
);

const CartTokenResponse = z.object({
  success: z.coerce.number().int().default(0),
  code: z.string().default(''),
  msg: z.string().default(''),
});

const ADD_TO_CART_MUTATION = `mutation addToCart($from: Int!, $to: Int!) {
  addToCart(from: $from, to: $to) {
    jwt
  }
}`;

/**
 * Add a CCU line item to the user's pledge-store cart.
 *
 * @param fromShipId - Source ship id (not a sku id). Same value used as the
 *                     `from` arg in `filterShips`.
 * @param toSkuId    - Destination **SKU** id (from `filterShips` ->
 *                     `to.ships[].skus[].id`). Passing a ship id here will
 *                     fail server-side with a validation error.
 *
 * Requires the user to be signed in — the cart-token endpoint returns 401
 * for anonymous sessions. Callers should gate the UI on `identifyFull()`.
 */
export async function addCcuToCart(fromShipId: number, toSkuId: number): Promise<void> {
  // Step 1 — upgrade GraphQL mutation. `postCcuGraphql` handles the CSRF
  // header + 403-retry, so we just parse the response shape.
  const raw = await postCcuGraphql([
    {
      operationName: 'addToCart',
      variables: { from: fromShipId, to: toSkuId },
      query: ADD_TO_CART_MUTATION,
    },
  ]);
  const parsed = AddToCartResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`addToCart: unexpected shape (${parsed.error.message})`);
  }
  const first = parsed.data[0];
  if (!first) throw new Error('addToCart: empty batch response');
  if (first.errors?.length) {
    throw new Error(`addToCart errors: ${first.errors.map((e) => e.message).join('; ')}`);
  }
  const jwt = first.data?.addToCart?.jwt;
  if (!jwt) throw new Error('addToCart: server returned no jwt');

  // Step 2 — commit the JWT to the cart. Uses a different auth header
  // (`x-rsi-token` = session cookie value) because this endpoint lives in
  // the core store-v2 service, not the pledge-store app.
  const token = await readRsiToken();
  if (!token) throw new Error('cart/token: not signed in');
  const response = await fetchWithTimeout(CART_TOKEN_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
      'x-rsi-token': token,
    },
    body: JSON.stringify({ jwt }),
  });
  if (!response.ok) {
    throw new Error(`cart/token returned ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  const cartParsed = CartTokenResponse.safeParse(body);
  if (!cartParsed.success) {
    throw new Error(`cart/token: unexpected shape (${cartParsed.error.message})`);
  }
  if (cartParsed.data.success !== 1) {
    throw new Error(`cart/token failed: ${cartParsed.data.msg || cartParsed.data.code}`);
  }
}
