/**
 * Shared plyne-app Supabase client for Plyne v3 reporters.
 *
 * v3's "outbound" sinks (notifications-writer, the live reporter) all talk to
 * the SAME plyne-app Supabase project (ref jwduoitebqncgaqrappk) using the same
 * service-role credentials. Rather than each module spinning up its own
 * `createClient`, they share this lazily-constructed singleton.
 *
 * Posture: BEST-EFFORT. Both env vars are OPTIONAL in the v3 env schema. When
 * either is missing the client is `null` and every caller must no-op (warn
 * once, never throw). The daemon must boot and run fine with these unset —
 * the FE simply won't see live daemon progress until the operator sets them.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";

let _client: SupabaseClient | null | undefined;
let _warned = false;

/**
 * Returns the shared plyne-app Supabase client, or `null` when the
 * PLYNE_APP_SUPABASE_* env vars are absent. On the first `null` result we emit
 * a single warn so the misconfiguration is visible in logs without spamming
 * every poll/heartbeat tick.
 */
export function getAppSupabase(): SupabaseClient | null {
  if (_client !== undefined) return _client;
  const env = loadEnv();
  const url = env.PLYNE_APP_SUPABASE_URL;
  const key = env.PLYNE_APP_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (!_warned) {
      logger.warn(
        "supabase-app: PLYNE_APP_SUPABASE_URL / PLYNE_APP_SUPABASE_SERVICE_ROLE_KEY not set — " +
          "live reporter disabled (FE will not reflect daemon progress). Daemon continues normally."
      );
      _warned = true;
    }
    _client = null;
    return _client;
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  logger.info("supabase-app: client initialized (live reporter enabled)");
  return _client;
}

/** True when the PLYNE_APP_SUPABASE_* credentials are present. */
export function isAppSupabaseConfigured(): boolean {
  return getAppSupabase() !== null;
}

/** Test helper — reset the memoized client/warn state between cases. */
export const __test = {
  reset(): void {
    _client = undefined;
    _warned = false;
  },
  injectClient(c: SupabaseClient | null): void {
    _client = c;
    _warned = c === null;
  }
};
