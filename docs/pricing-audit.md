# Pricing audit (2026-01-26)

## Current flow (as-is)
- Settings ? “Aggiorna prezzi” calls `services/priceService.syncPrices()` which fetches EODHD history (or Sheets latest as fallback) and upserts `db.prices`.
- Backfill uses `services/priceService.backfillPricesForPortfolio()` ? EODHD history ? `db.prices`.
- Coverage uses `services/priceService.getPriceCoverage()` + `buildCoverageRows()`.
- Canonical price ticker is `preferredListing.symbol` (fallback `instrument.ticker`).
- Provider config is stored in `AppSettings.priceTickerConfig` keyed by canonical ticker.

## Key risk points
- Listing mismatch (instrument ticker vs preferredListing symbol) leads to “0/7” coverage and 404s.
- Missing ISIN reduces auto-mapping quality when instruments are created.
- Currency tagging from EODHD was hardcoded and could mislabel CHF/EUR listings.

## Patch summary (this change)
- Transactions UI now shows a price status badge using the same coverage logic as Settings and deep-links to Listings & FX for quick fixes.
- New instrument creation can optionally auto-attach listings from ISIN (EODHD search) and seed `priceTickerConfig` defaults without schema changes.
- `syncPrices` adds a small delay to reduce 429s and ensures currencies are set from preferred listing/instrument (EODHD no longer hardcodes USD).

## Files touched
- `pages/Transactions.tsx` (status badge + ISIN attach + deep link)
- `services/priceService.ts` (throttle + currency handling)
- `services/priceAttach.ts` (new helper)
- `services/priceAttach.test.ts`, `services/priceService.test.ts` (tests)
