# ship-codes.json — attribution

The `ship-codes.json` table in this directory was seeded from the
HangarXPLOR project's static lookup table:

  https://github.com/dolkensp/HangarXPLOR/blob/master/src/web_resources/ship-codes.json
  Initial seed taken at master HEAD on 2026-05-04.

HangarXPLOR is MIT-licensed (Copyright (c) Mark Dingle / dolkensp).
Full license text: https://github.com/dolkensp/HangarXPLOR/blob/master/LICENSE

We use this table as a starting point for our own Hangar module's
HTF (`shiplist.json`) export, so that consumers of the HangarXPLOR
ecosystem (third-party value calculators, hangar-matching tools,
buyback helpers, etc.) accept our exports without translation.

The MIT license requires:
  1. The copyright notice and permission notice be retained in
     copies or substantial portions of the original. Done — see
     this file.
  2. No warranty / no liability claim. Standard for MIT.

Subsequent edits to `ship-codes.json` (additions for ships RSI has
released after the seed date, alias entries, etc.) are our own
work, but the bulk of the table remains derived from upstream.

Schema (per entry):

```json
{
  "ship_code": "RSI_AURORA_LN",
  "ship_name": "Aurora LN",
  "manufacturer_code": "RSI",
  "manufacturer_name": "Roberts Space Industries"
}
```

`ship_code` is the canonical identifier that downstream tooling
keys off. `ship_name` is the matching key against the parsed
hangar HTML (case-sensitive trailing text after the manufacturer-
prefix strip).
