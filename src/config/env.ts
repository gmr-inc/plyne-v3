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

  // ── Auto-merge (safe because the AC are machine-verified pre-PR) ───────
  // When true (default), a second poller squash-merges `pr-open` PRs once they
  // are fully green (all required CI checks SUCCESS + CodeRabbit success/
  // approved + mergeable CLEAN), then marks the task `done`. Set false to keep
  // the operator-manual-merge behaviour. The AC gate (Part 1) runs regardless.
  PLYNE_V3_AUTO_MERGE: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  // Cadence of the auto-merge poller. Slightly slower than the task poller —
  // CI + CodeRabbit take time, no value hammering GitHub every few seconds.
  PLYNE_V3_AUTO_MERGE_INTERVAL_MS: z.coerce.number().default(45000),

  // ── Claude Max usage reading + auto-pause ──────────────────────────────
  // Plyne runs on a Claude Max OAuth session. If it burns its weekly Max
  // allowance to a dead cap, every subsequent `claude` invocation fails and the
  // daemon hammers a wall. These knobs let the runner read the live Max
  // utilization and PAUSE dispatch before that happens.
  //
  // Token source: the running daemon's own `claude` invocations keep
  // ~/.claude/.credentials.json fresh in-place. We READ claudeAiOauth.accessToken
  // from there each cycle (overridable for tests / non-default homes). We never
  // rotate the refresh token ourselves — that would desync the CLI's file.
  CLAUDE_CREDENTIALS_PATH: z.string().optional(),
  // Weekly Max utilization (%) at/above which we stop dispatching tasks.
  PLYNE_V3_WEEKLY_PAUSE_PCT: z.coerce.number().default(90),
  // 5-hour session utilization (%) at/above which we stop dispatching tasks.
  PLYNE_V3_SESSION_PAUSE_PCT: z.coerce.number().default(95),

  // Auto-pause/pacing read the latest `claude_quota_snapshots` row (written by
  // the ~5-min live reporter) instead of hitting the rate-limited usage endpoint
  // directly — so the gate never 429s and always has a value. If the latest
  // snapshot is older than this many minutes we log a clear WARN but STILL apply
  // the last-good caps (the weekly cap is slow-moving so last-good is trusted;
  // the fast-moving session cap is flagged loudly). Never fail-open silently.
  PLYNE_V3_QUOTA_SNAPSHOT_MAX_AGE_MIN: z.coerce.number().default(20),

  // ── Smart pacing (proactive weekly-budget protection) ────────────────────
  // The hard caps above only brake when the allowance is nearly gone. Pacing
  // instead spreads the week's budget: it pauses NEW task claims (ready tasks
  // just wait — they're queued, not failed) whenever the current burn rate,
  // extrapolated to the weekly reset, is projected to blow past 100%. SOFT and
  // self-healing — auto-resumes as the week elapses and the rate becomes
  // sustainable. The hard caps + reactive backstop always win over pacing.
  PLYNE_V3_PACING_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  // Don't trust the burn-rate projection until at least this fraction of the
  // weekly window has elapsed (default 0.1 ≈ 17h) — early-week noise otherwise.
  PLYNE_V3_PACING_MIN_ELAPSED_FRAC: z.coerce.number().default(0.1),
  // Headroom (%) added to the 100% projection trip point. 0 → pause as soon as
  // we're projected to exceed 100% before reset; raise it to allow some burst.
  PLYNE_V3_PACING_MARGIN_PCT: z.coerce.number().default(0),

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

  // ── Auto-promotion (backlog → ready) of ingestion-created tasks ───────────
  //
  // THE GAP this closes: ingestion files real bugs in Notion `backlog`, but the
  // runner only picks `ready` tasks tagged with PLYNE_V3_TASK_PREFIX. Today an
  // operator must manually promote. Auto-promote applies a strict policy
  // (real source only, severity gate, dedupe, age gate, repo allowlist, rate
  // limit, operator-backlog circuit breaker) and — ONLY when explicitly enabled
  // — promotes a qualifying task toward execution.
  //
  // SAFETY POSTURE — default OFF / dry-run. When false (default), the policy
  // still runs and LOGS what it WOULD promote, but writes nothing. This lets us
  // observe the policy against live traffic before granting it write authority.
  // The human flips PLYNE_AUTO_PROMOTE=true to go live. Never flip it on the
  // same change that ships it.
  PLYNE_AUTO_PROMOTE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // CRUCIAL SECOND GATE. Auto-promote may take an autonomously-DETECTED signal
  // up to `ready` → runner → Claude → PR. It must NEVER let that PR auto-merge
  // unless this SEPARATE flag is also true. Default OFF keeps a human in the
  // loop for the merge of any autonomously-detected fix, even when the rest of
  // the loop is live. (The auto-merge loop itself reads PLYNE_V3_AUTO_MERGE for
  // operator-authored tasks; for auto-promoted tasks BOTH must be true.)
  PLYNE_AUTO_PROMOTE_AUTOMERGE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Max auto-promotions allowed per rolling window (rate limit). Prevents a
  // signal storm (e.g. a deploy that lights up 40 Sentry issues) from spawning
  // 40 concurrent Claude runs against real repos.
  PLYNE_AUTO_PROMOTE_MAX_PER_WINDOW: z.coerce.number().default(3),
  PLYNE_AUTO_PROMOTE_WINDOW_MS: z.coerce.number().default(60 * 60 * 1000),
  // Minimum signal age before promotion (let a blip self-resolve; the poller
  // already verifies-still-firing, this adds a soak margin). 0 disables.
  PLYNE_AUTO_PROMOTE_MIN_AGE_MS: z.coerce.number().default(0),
  // Circuit breaker: if the operator already has this many open tasks awaiting
  // attention (needs-operator / ready backlog), STOP auto-promoting — don't
  // pile autonomous work on top of a human who's already underwater. 0 disables.
  PLYNE_AUTO_PROMOTE_MAX_OPEN_BACKLOG: z.coerce.number().default(10),
  // Comma-separated allowlist of repos (org/name) auto-promote may target.
  // EMPTY = allow nothing (fail-closed). The human opts each real repo in
  // explicitly. The sandbox repo used for the e2e simulation goes here.
  PLYNE_AUTO_PROMOTE_REPO_ALLOWLIST: z.string().default(""),
  // The external_id prefix the runner picks up. Auto-promote rewrites a
  // promoted task's Name to start with this so listReadyTasks() will claim it.
  // Defaults to the same V3 test-flight prefix so promoted tasks are isolated
  // from v2 and obvious in the Notion board.
  PLYNE_AUTO_PROMOTE_PREFIX: z.string().default("V3-AUTO-"),

  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_ORG_SLUG: z.string().optional(),

  BETTERSTACK_API_TOKEN: z.string().optional(),
  BETTERSTACK_UPTIME_TOKEN: z.string().optional(),
  BETTERSTACK_QUERY_USERNAME: z.string().optional(),
  BETTERSTACK_QUERY_PASSWORD: z.string().optional(),
  BETTERSTACK_QUERY_ENDPOINT: z.string().optional(),

  BRAINTRUST_API_KEY: z.string().optional(),

  // ── SELF-observability (the daemon watching ITSELF) ──────────────────────
  //
  // DISTINCT from the ingestion keys above. The SENTRY_AUTH_TOKEN /
  // BETTERSTACK_* / BRAINTRUST_API_KEY block exists so Plyne can POLL OTHER
  // products' monitoring and file bugs. The keys below let Plyne report ITS
  // OWN crashes/logs/agent-calls — the gap that let it crash-loop ~1948 times
  // unnoticed. All optional → each sink gracefully no-ops when unset and the
  // daemon boots exactly as before (observability is purely additive).
  //
  // Sentry (errors / uncaught exceptions / FATAL boot path) — @sentry/node.
  // This is the project DSN (ingest endpoint), NOT the management auth token.
  // Create the `plyne-v3` Sentry project in org gmr-inc and paste its DSN here.
  SENTRY_DSN: z.string().optional(),
  // Traces sample rate for Sentry performance monitoring (0..1). Low by default
  // — a polling daemon would otherwise generate a flood of identical spans.
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().default(0.1),
  // Logical environment tag attached to every Sentry/OTel/Braintrust event.
  PLYNE_OBSERVABILITY_ENV: z.string().default("production"),

  // BetterStack structured-log shipping (OTLP/Logtail). The daemon's pino logs
  // are mirrored to this BetterStack source. Both must be set to activate.
  //   - BETTERSTACK_SOURCE_TOKEN  → the plyne-v3 source token
  //   - BETTERSTACK_INGESTING_HOST→ e.g. s2491435.eu-nbg-2.betterstackdata.com
  // BETTERSTACK_SOURCE_TOKEN is the self-observability source token (NOT the
  // *_API_TOKEN used for ingestion polling).
  BETTERSTACK_SOURCE_TOKEN: z.string().optional(),
  BETTERSTACK_INGESTING_HOST: z.string().optional(),

  // ── plyne-app Supabase (data DB, project ref jwduoitebqncgaqrappk)
  //
  // Single set of credentials shared by every v3 → plyne-app sink:
  //   - notifications writer (public.notifications → UI bell)
  //   - LIVE reporter (src/lib/supabase-reporter.ts): mirrors task status into
  //     public.tasks by notion_page_id and upserts public.daemon_heartbeat, so
  //     the FE reflects daemon progress in real time via Supabase realtime.
  // Both keys are OPTIONAL so v3 can boot without the dashboard wired
  // (greenfield VPS, dev/CI). When missing, every sink no-ops with a warn —
  // the daemon must never crash or block on a missing/down Supabase.
  //   URL = https://jwduoitebqncgaqrappk.supabase.co
  PLYNE_APP_SUPABASE_URL: z.string().optional(),
  PLYNE_APP_SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

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
    // Surface the env-validation FATAL to Sentry when it's active (it usually
    // is by this point — index.ts inits Sentry before any loadEnv() call).
    // Best-effort + bounded: capture THEN flush+exit so the event isn't lost.
    // No-ops to a plain exit(1) when Sentry is unconfigured or not yet init'd.
    void (async () => {
      try {
        const { captureMessage, flushAndExit } = await import("../observability/sentry.js");
        captureMessage("plyne-v3 FATAL env validation failed", "fatal", {
          phase: "env_validation",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
        });
        await flushAndExit(1);
      } catch {
        process.exit(1);
      }
    })();
    // Fallback hard-exit if the async flush path somehow stalls.
    setTimeout(() => process.exit(1), 2500);
    // Unreachable — process exits above; throw keeps the type checker happy.
    throw new Error("env validation failed");
  }
  cached = parsed.data;
  return cached;
}
