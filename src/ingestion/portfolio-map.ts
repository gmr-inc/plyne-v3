/**
 * Static product → repo lookup for ingestion task creation.
 *
 * The authoritative portfolio.json lives in cto-v2 (v2 still owns the
 * portfolio registry). Rather than reach over and import it (cross-repo
 * symlink fragility on the VPS), v3 embeds the small subset of mappings
 * the ingestion module actually needs. When a new product launches the
 * operator updates this list AND portfolio.json.
 *
 * Keys here MUST match the `Product` select option names in the Notion
 * Tasks v2 DB exactly — Notion API rejects unknown select values.
 *
 * Vendor-side project slugs are mapped separately per source (e.g. Sentry
 * uses `org/<slug>`, BetterStack uses source IDs). Those mappings live
 * inside each collector file.
 */

export interface ProductEntry {
  /** Notion Product select value + GMR taxonomy key. */
  key: string;
  /** GitHub repo path (org/name) — written to Notion `Repo` property. */
  repo: string;
}

/**
 * Mirrors cto-v2/portfolio.json `products[]` as of 2026-06-01. Keep in
 * sync manually; the list is short and changes rarely.
 */
export const PORTFOLIO: ReadonlyArray<ProductEntry> = [
  { key: "marketear", repo: "gmr-inc/marketear" },
  { key: "brynx", repo: "gmr-inc/brynx" },
  { key: "crewrev", repo: "gmr-inc/crewrev-v2" },
  { key: "twipaw", repo: "gmr-inc/twipaw-app" },
  { key: "vettinghub", repo: "gmr-inc/vetting-app" },
  { key: "credem", repo: "gmr-inc/credem-wea-trends" },
  { key: "geoky", repo: "gmr-inc/geoky" },
  { key: "dtwin", repo: "gmr-inc/dtwin-app" },
  { key: "graph", repo: "gmr-inc/twin-engine" },
  { key: "klenux", repo: "gmr-inc/uxtwin" },
  { key: "cto", repo: "gmr-inc/cto-v2" },
  { key: "gmr", repo: "gmr-inc/genmr-site" },
  { key: "atwin", repo: "albertonasciuti/atwin" },
  // plyne-v3 itself — ingestion signals targeting the daemon go here.
  { key: "cto", repo: "gmr-inc/plyne-v3" }
];

/**
 * Resolve a product key → repo path. Returns `null` when the product is
 * unknown (e.g. a Sentry project we haven't onboarded yet). The caller
 * MUST skip the signal in that case — emitting a task without a valid
 * Repo crashes the Notion select validator.
 */
export function lookupRepo(productKey: string): string | null {
  for (const p of PORTFOLIO) {
    if (p.key === productKey) return p.repo;
  }
  return null;
}

/**
 * Validate a product key exists in the registry. Used by collectors to
 * short-circuit unknown products before they spend an API call.
 */
export function isKnownProduct(productKey: string): boolean {
  return lookupRepo(productKey) !== null;
}
