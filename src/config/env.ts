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

  // Filter for V3 test-flight phase: only pick tasks tagged with this Repo
  // prefix or matching this external_id prefix. Architecture §"VPS deployment"
  // calls this out so v3 can run parallel to v2 without stealing v2 work.
  PLYNE_V3_TASK_PREFIX: z.string().default("V3-TEST-"),

  // Boot mode: "daemon" (default — polling loop) or "smoke" (one-shot).
  PLYNE_MODE: z.enum(["daemon", "smoke"]).default("daemon"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info")
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
