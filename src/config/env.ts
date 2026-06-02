/**
 * Plyne v3 env contract — minimal, fail-fast, no surprises.
 *
 * The v2 env loader had ~80 keys covering 6 agents that no longer exist
 * (spec-validator, spec-guardian, decomposer, supervisor, output-validator,
 * task-author). v3 only needs: Anthropic auth + Notion + a handful of
 * orchestrator knobs.
 */
import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  // Claude model selection — see /tmp/plyne-v3-architecture.md §"Model selection".
  PLYNE_CLAUDE_MODEL: z.string().default("claude-opus-4-8"),
  PLYNE_EXTENDED_THINKING: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  // Anthropic auth — either API key OR OAuth Max session token (rotator picks).
  ANTHROPIC_API_KEY: z.string().optional(),

  // Notion task DB (mirror only post-cutover; primary moves to Supabase later).
  NOTION_TOKEN: z.string().min(1, "NOTION_TOKEN required"),
  NOTION_TASKS_DB_ID: z.string().min(1, "NOTION_TASKS_DB_ID required"),

  // Claude CLI path (absolute, since pm2's PATH on the VPS is minimal).
  CLAUDE_CLI_PATH: z.string().default("/usr/bin/claude"),

  // Worktree sandbox base — Claude spawns inside per-task git worktrees.
  WORKTREE_BASE: z.string().default("/tmp/plyne-v3-worktrees"),

  // Polling cadence + safety cap.
  POLL_INTERVAL_MS: z.coerce.number().default(15000),
  MAX_CONCURRENT_TASKS: z.coerce.number().default(3),

  // HTTP API port (health + MCP endpoint).
  API_PORT: z.coerce.number().default(7733),

  // Shared bearer secret protecting the SSE `/activity/stream` endpoint.
  // plyne-app uses this same value to authenticate the upstream connection
  // from its `/api/v1/activity` proxy route. Optional in env contract so the
  // daemon can boot without the dashboard wired; the SSE handler returns
  // 503 when missing, which makes the misconfiguration obvious instead of
  // silently allowing unauthenticated streaming.
  PLYNE_DAEMON_API_TOKEN: z.string().optional(),

  // Filter for V3 test-flight phase: only pick tasks tagged with this Repo
  // prefix or matching this external_id prefix. Architecture §"VPS deployment"
  // calls this out so v3 can run parallel to v2 without stealing v2 work.
  PLYNE_V3_TASK_PREFIX: z.string().default("V3-TEST-"),

  // Boot mode: "daemon" (default — polling loop) or "smoke" (one-shot).
  PLYNE_MODE: z.enum(["daemon", "smoke"]).default("daemon"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // ── Monitoring ingestion (Sentry / BetterStack / Braintrust / Statuspage)
  //
  // All keys are optional — when missing the corresponding poller no-ops
  // gracefully (logged at info on boot). The daemon must run even when
  // monitoring isn't fully wired (greenfield VPS, dev environment).
  //
  // Set `PLYNE_INGESTION_ENABLED=false` to disable the whole subsystem
  // even when credentials are present (useful during audit/debug windows
  // per memory feedback_plyne_on_off_audit_policy.md).
  PLYNE_INGESTION_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_ORG_SLUG: z.string().optional(),

  BETTERSTACK_API_TOKEN: z.string().optional(),
  BETTERSTACK_UPTIME_TOKEN: z.string().optional(),
  BETTERSTACK_QUERY_USERNAME: z.string().optional(),
  BETTERSTACK_QUERY_PASSWORD: z.string().optional(),
  BETTERSTACK_QUERY_ENDPOINT: z.string().optional(),

  BRAINTRUST_API_KEY: z.string().optional(),

  // Poll cadences — exposed so on-call can tune without a rebuild.
  // Defaults match the spec (Sentry 10m, BS 5m, Braintrust 30m, Statuspage 2m).
  INGEST_SENTRY_INTERVAL_MS: z.coerce.number().default(10 * 60 * 1000),
  INGEST_BETTERSTACK_INTERVAL_MS: z.coerce.number().default(5 * 60 * 1000),
  INGEST_BRAINTRUST_INTERVAL_MS: z.coerce.number().default(30 * 60 * 1000),
  INGEST_STATUSPAGE_INTERVAL_MS: z.coerce.number().default(2 * 60 * 1000)
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("[plyne-v3] env validation failed:", parsed.error.format());
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
