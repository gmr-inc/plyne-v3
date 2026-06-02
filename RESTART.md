# Plyne v3 — restart pipeline

Post-deploy / post-merge restart procedure for the `plyne-v3` daemon
running on the Hetzner VPS (`128.140.125.58`).

> Operator-only. chat-Claude does NOT run this in production unless
> the user explicitly says so. See `CLAUDE.md` in cto-v2.

## 1. Standard restart (after merge to `main`)

```bash
ssh -i ~/.ssh/id_ed25519_macscorta root@128.140.125.58 'su - plyne -c "
cd /home/plyne/Desktop/Projects/plyne-v3 &&
git pull origin main &&
npm install --production &&
npm run build &&
pm2 restart plyne-v3 --update-env
"'
```

Notes:
- `--update-env` forces pm2 to re-read `.env` (otherwise it caches the
  env from the original `pm2 start`).
- `npm install --production` skips devDependencies — these stay off the
  VPS to keep the image small.
- `npm run build` regenerates `dist/`. The pm2 process points at
  `dist/index.js`, not source.
- `git pull` is fast-forward only by default — if conflicts surface, do
  NOT force-pull. Inspect manually first.

## 2. Verification (after restart)

### 2a. pm2 status

```bash
ssh root@128.140.125.58 'su - plyne -c "pm2 list"'
```

Expected:
- `plyne-v3` row shows `online`.
- `↺` (restarts) is 0 or unchanged vs pre-restart.
- `uptime` > 0 (rising).

If `↺` keeps climbing → crash loop. Inspect logs:

```bash
ssh root@128.140.125.58 'su - plyne -c "pm2 logs plyne-v3 --lines 100 --nostream"'
```

Look for `FATAL:` lines — boot validation surfaces every credential
or path issue with that prefix.

### 2b. Boot-log sanity

The boot sequence emits these structured pino lines (in order):

1. `vercel-env-pull: applied` (or `skipped` / `debug: gated off`)
2. `plyne-v3 boot` — mode/model/extendedThinking/taskPrefix
3. `boot-validation` × N — one per check (`ANTHROPIC_API_KEY`,
   `WORKTREE_BASE`, `GH_TOKEN`, `TELEGRAM_BOT_TOKEN`,
   `SUPABASE_ACCESS_TOKEN`), each with `status: ok|skipped|failed`
4. `boot validation OK` — single summary line. **If you don't see this,
   the daemon did NOT finish booting.**
5. `plyne-v3 hardening checks passed (notion token live, repos base
   accessible)`
6. `api: listening` on port `7733`

### 2c. BetterStack telemetry probe

After 2 minutes uptime, query BetterStack:

```text
source = plyne-v3 (id 2440243 if shared with cto-v2; verify on platform)
level  = error
window = last 2 min
```

Expected: 0 hits. Any `level=error` entries are real signals — investigate
before declaring the restart healthy.

## 3. Vercel env pull verification

If `PLYNE_V3_PULL_VERCEL_ENV=true` was added to `.env`, confirm at boot:

- Look for the `vercel-env-pull: applied` log line.
- Its `fromVercel` field lists which keys came from Vercel (i.e. were
  unset in `.env` and populated from the API).
- Its `preservedLocal` field lists keys that were left alone because
  `.env` (or the parent shell) had a value — local wins by design.

If `vercel-env-pull: skipped` with `VERCEL_TOKEN missing` → fix `.env`
or set the gate to `false` and rely on the file.

## 4. v3 MCP server status (Task D)

The v3 codebase already ships an MCP server at `src/mcp/server.ts` —
mounted by `src/api/server.ts` at `POST /mcp` on the same port as
`/health` (default `7733`).

### Current state (as of this commit)

- **Local-only**: `http://127.0.0.1:7733/mcp` on the VPS.
- **NOT exposed publicly**. `https://plyne.dev/mcp` redirects to
  `/login` — that hostname maps to the `plyne-app` Next.js project on
  Vercel, NOT the v3 MCP server on the VPS. They're different things.
- The cloudflared tunnel that fronts the VPS today (if any) does not
  publish port 7733.

### Required wiring (follow-up, NOT in this PR — effort L)

Pick one of:

**Option A — separate hostname via cloudflared tunnel.**
   1. On the VPS: add a tunnel route in `~/.cloudflared/config.yml`:
      ```yaml
      ingress:
        - hostname: plyne-v3.genmr.co
          service: http://127.0.0.1:7733
      ```
   2. DNS: `plyne-v3.genmr.co` CNAME to the cloudflared tunnel.
   3. `cloudflared tunnel route dns <tunnel-id> plyne-v3.genmr.co`.
   4. Restart cloudflared: `sudo systemctl restart cloudflared`.

**Option B — path prefix under `plyne.dev`.**
   1. Add a Next.js middleware rewrite in the `plyne-app` repo so
      `/v3/mcp` proxies to the VPS `:7733/mcp`.
   2. Add the VPS IP to the upstream allowlist (Cloudflare rules).
   3. NOTE: this couples v3 availability to the `plyne-app` Vercel
      deployment — usually undesirable.

**Option C (preferred) — separate hostname.** Same as A; keeps blast
   radius scoped (a `plyne-app` outage doesn't take down v3's MCP).

Open follow-up task: `PL-CTO-PLYNE-V3-MCP-PUBLIC-EXPOSE-001` (file
manually after this PR merges).

### Smoke test the MCP server locally (post-restart)

```bash
ssh root@128.140.125.58 'su - plyne -c "
curl -s -X POST http://127.0.0.1:7733/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' | head -c 400
"'
```

Expected: a JSON-RPC response listing the 12 plyne.* tools. If it
returns HTML or `Cannot POST /mcp`, the API server didn't mount the
MCP handler — re-check `src/api/server.ts` and `src/mcp/server.ts`.

## 5. Rollback (if something went sideways)

```bash
ssh root@128.140.125.58 'su - plyne -c "
cd /home/plyne/Desktop/Projects/plyne-v3 &&
git log --oneline -5 &&
git reset --hard HEAD~1 &&  # only if you're sure the last commit is the regression
npm install --production && npm run build &&
pm2 restart plyne-v3 --update-env
"'
```

Then file the regression as a `PL-CTO-PLYNE-V3-*` task and move on.
Don't keep manually reverting — capture the failure mode for the next
fix-forward.

## 6. Stop / start (audit windows)

Per `feedback_plyne_on_off_audit_policy.md`, the daemon is ON 24/7 by
default. Only stop for active audit/debug sessions:

```bash
ssh root@128.140.125.58 'su - plyne -c "pm2 stop plyne-v3"'
# ... do the audit, restart when done:
ssh root@128.140.125.58 'su - plyne -c "pm2 start plyne-v3 --update-env"'
```

`pm2 stop` does NOT lose the process registration — `pm2 list` will
still show it (status `stopped`). `pm2 delete` would lose it; don't do
that without intent.
