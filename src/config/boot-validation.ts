/**
 * Comprehensive boot validation for Plyne v3.
 *
 * PR #4 added NOTION_TOKEN live verification + LOCAL_REPOS_BASE guard.
 * This module extends that pattern to every credential and resource the
 * daemon depends on, so we fail-fast at boot instead of bleeding 1900+
 * pm2 restarts when an upstream rotates a token.
 *
 * Checks performed:
 *   - GH_TOKEN          → `GET /user`            (api.github.com)
 *   - ANTHROPIC_API_KEY → format `sk-ant-*` (no live ping — burns quota)
 *   - TELEGRAM_BOT_TOKEN→ `GET /bot{token}/getMe`(api.telegram.org)
 *   - SUPABASE_ACCESS_TOKEN → `GET /v1/projects` (api.supabase.com)
 *   - WORKTREE_BASE     → dir exists + writable
 *
 * NOTION_TOKEN is intentionally NOT re-checked here — PR #4's
 * `verifyNotionTokenLive()` already covers it and stays the canonical
 * site for that probe.
 *
 * On any failure: `process.exit(1)` with a clear `FATAL: <key> ...` line.
 * On full pass: a single `boot validation OK` log line.
 *
 * All keys except WORKTREE_BASE are *optional* in the v3 env schema, so
 * we silently skip the live check when the var is unset (a daemon without
 * Telegram is still a valid configuration — Plyne just won't send alerts).
 * That keeps boot validation orthogonal to the env schema's required-vs-
 * optional decision.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnv } from "./env.js";
import { logger } from "./logger.js";
import { captureMessage, flushAndExit } from "../observability/sentry.js";

const FETCH_TIMEOUT_MS = 8_000;

interface CheckResult {
  key: string;
  status: "ok" | "skipped" | "failed";
  detail?: string;
}

async function checkGitHubToken(): Promise<CheckResult> {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    return { key: "GH_TOKEN", status: "skipped", detail: "unset" };
  }
  try {
    const r = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "plyne-v3-boot-check",
        Accept: "application/vnd.github+json"
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (r.status === 200) {
      const body = (await r.json()) as { login?: string };
      return { key: "GH_TOKEN", status: "ok", detail: `login=${body.login ?? "?"}` };
    }
    return {
      key: "GH_TOKEN",
      status: "failed",
      detail: `HTTP ${r.status}`
    };
  } catch (err) {
    return {
      key: "GH_TOKEN",
      status: "failed",
      detail: (err as Error).message
    };
  }
}

function checkAnthropicKey(): CheckResult {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { key: "ANTHROPIC_API_KEY", status: "skipped", detail: "unset (CLI OAuth path)" };
  }
  // Live-pinging Anthropic costs ~$0 but counts against quota and adds boot
  // latency — format check is enough to catch the common "pasted wrong key /
  // typo" failure mode. A truly invalid key surfaces on first task execution.
  if (!key.startsWith("sk-ant-")) {
    return {
      key: "ANTHROPIC_API_KEY",
      status: "failed",
      detail: "expected prefix sk-ant-*"
    };
  }
  return { key: "ANTHROPIC_API_KEY", status: "ok", detail: "format valid" };
}

async function checkTelegramToken(): Promise<CheckResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { key: "TELEGRAM_BOT_TOKEN", status: "skipped", detail: "unset" };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (r.status === 200) {
      const body = (await r.json()) as { ok?: boolean; result?: { username?: string } };
      if (body.ok) {
        return {
          key: "TELEGRAM_BOT_TOKEN",
          status: "ok",
          detail: `bot=@${body.result?.username ?? "?"}`
        };
      }
      return { key: "TELEGRAM_BOT_TOKEN", status: "failed", detail: "ok=false" };
    }
    return { key: "TELEGRAM_BOT_TOKEN", status: "failed", detail: `HTTP ${r.status}` };
  } catch (err) {
    return {
      key: "TELEGRAM_BOT_TOKEN",
      status: "failed",
      detail: (err as Error).message
    };
  }
}

async function checkSupabaseToken(): Promise<CheckResult> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    return { key: "SUPABASE_ACCESS_TOKEN", status: "skipped", detail: "unset" };
  }
  try {
    const r = await fetch("https://api.supabase.com/v1/projects", {
      headers: {
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (r.status === 200) {
      const body = (await r.json()) as Array<{ id: string }>;
      return {
        key: "SUPABASE_ACCESS_TOKEN",
        status: "ok",
        detail: `${Array.isArray(body) ? body.length : "?"} projects accessible`
      };
    }
    return { key: "SUPABASE_ACCESS_TOKEN", status: "failed", detail: `HTTP ${r.status}` };
  } catch (err) {
    return {
      key: "SUPABASE_ACCESS_TOKEN",
      status: "failed",
      detail: (err as Error).message
    };
  }
}

function checkWorktreeBase(worktreeBase: string): CheckResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(worktreeBase);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      // Try to create it — WORKTREE_BASE is a runtime sandbox, mkdir -p is
      // expected behaviour. We don't pre-stage it because the VPS layout
      // varies (dev mac vs Hetzner).
      try {
        fs.mkdirSync(worktreeBase, { recursive: true });
        return { key: "WORKTREE_BASE", status: "ok", detail: `created ${worktreeBase}` };
      } catch (mkErr) {
        return {
          key: "WORKTREE_BASE",
          status: "failed",
          detail: `cannot create: ${(mkErr as Error).message}`
        };
      }
    }
    return { key: "WORKTREE_BASE", status: "failed", detail: e.message };
  }
  if (!stat.isDirectory()) {
    return { key: "WORKTREE_BASE", status: "failed", detail: "not a directory" };
  }
  // Writable probe — a single tempfile create/unlink is the only reliable test
  // when running under non-root users with restrictive umasks.
  const probe = path.join(worktreeBase, `.plyne-v3-boot-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
  } catch (err) {
    return {
      key: "WORKTREE_BASE",
      status: "failed",
      detail: `not writable: ${(err as Error).message}`
    };
  }
  return { key: "WORKTREE_BASE", status: "ok", detail: `${worktreeBase} writable` };
}

/**
 * Run every boot check. Exits the process on any failure; logs a single
 * "boot validation OK" line on full pass.
 *
 * Safe to call multiple times in tests — no module-level side effects.
 */
export async function runBootValidation(): Promise<void> {
  const env = loadEnv();

  const results: CheckResult[] = [
    checkAnthropicKey(),
    checkWorktreeBase(env.WORKTREE_BASE),
    ...(await Promise.all([
      checkGitHubToken(),
      checkTelegramToken(),
      checkSupabaseToken()
    ]))
  ];

  const failures = results.filter((r) => r.status === "failed");

  for (const r of results) {
    logger.info({ check: r.key, status: r.status, detail: r.detail }, "boot-validation");
  }

  if (failures.length > 0) {
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.error(`FATAL: ${f.key} boot check failed: ${f.detail ?? "no detail"}`);
    }
    // SURFACE the crash-loop cause. A failed boot check (e.g. an expired
    // GH_TOKEN, a malformed ANTHROPIC_API_KEY) is exactly what drove ~1948
    // silent pm2 restarts. Report it to Sentry with the failing checks, then
    // flush (bounded) before exiting so the event isn't dropped on exit(1).
    // No-op + plain exit when Sentry is unconfigured.
    captureMessage("plyne-v3 FATAL boot validation failed", "fatal", {
      phase: "boot_validation",
      failures: failures.map((f) => ({ key: f.key, detail: f.detail }))
    });
    await flushAndExit(1);
  }

  logger.info(
    { checked: results.length, passed: results.filter((r) => r.status === "ok").length },
    "boot validation OK"
  );
}
