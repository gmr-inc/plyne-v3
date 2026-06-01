---
name: vercel-deploy-fixer
description: |
  Diagnose and fix Vercel deploy failures end-to-end: env vars, build cache, auth/OIDC,
  Next.js runtime errors, framework misdetection, and CI-vs-Vercel divergence. Use whenever
  a Vercel preview/prod deploy goes red, the deploy hangs in queue, or pages return 500/404
  after a green build.
usage: |
  Activate when task involves "Vercel deploy red", "preview broken", "production rolled back",
  or any 5xx surfacing only on Vercel (works locally). Requires the `vercel` MCP server +
  `github` MCP server (for diff/blame).
trigger_intents:
  - "vercel deploy is failing"
  - "preview returns 500"
  - "build green but page errors"
  - "deploy stuck in queue"
mcp_dependencies: [vercel, github]
authors: [alberto.nasciuti@kpi6.com]
version: 1.0.0
---

# Vercel Deploy Fixer — diagnostic playbook

## Phase 0 — Capture the failure

Before changing anything, collect:

1. Deployment URL (e.g. `https://<project>-<hash>.vercel.app`)
2. Deployment ID via `vercel inspect <url>` or `vercel:status` skill
3. Failure mode: **build failed** / **build green + runtime 5xx** / **stuck in queue** / **wrong framework detected**
4. Last green deployment ID (for diff)
5. Recent commits on the branch (`gh pr view <n> --json commits`)

Document these in the review comment before applying any fix.

## Phase 1 — Triage decision tree

### A. Build failed

1. Fetch full build logs (`vercel logs <deployment-id>` or via Vercel MCP)
2. Match against known patterns:
   - `Error: Cannot find module` → missing dep in `package.json` OR pnpm workspace not hoisted
   - `out of memory` → bump `NODE_OPTIONS=--max-old-space-size=4096` in Build Command
   - `Module parse failed: Unexpected token` → `next.config.ts` `transpilePackages` missing entry
   - `EACCES` / `ENOENT` on prisma/sharp → missing post-install hook in `vercel-build` script
   - `Type error` → if `next.config` has `typescript.ignoreBuildErrors: false`, the diff introduces a bad type — fix the type, do NOT silence the gate

### B. Build green, runtime 5xx

1. Capture client error: `gh run view` if CI vs `vercel logs --runtime` for server
2. Common culprits:
   - **Env var missing on Vercel side** — locally works because `.env.local` present
     - Run `vercel env ls preview` and `vercel env ls production`
     - Compare with `.env.example` checked into repo
   - **OIDC token rotation** — `VERCEL_OIDC_TOKEN` expired on long-running PR
     - Trigger a redeploy: it regenerates the token
   - **Supabase URL/key mismatch** — preview points to prod or vice-versa
     - Inspect `NEXT_PUBLIC_SUPABASE_URL` per environment scope
   - **Cookie domain wrong** in middleware — Vercel preview uses `*.vercel.app`, prod uses custom domain
   - **Edge runtime constraint** — Node API used in `runtime: 'edge'` route → move to `runtime: 'nodejs'` or replace API

### C. Stuck in queue

- Check Vercel status page: https://www.vercel-status.com
- If incident → wait, don't redeploy in a loop (worsens queue)
- If no incident → check team concurrency limits (Pro plan = 12 concurrent builds)

### D. Wrong framework detected

- Add explicit `vercel.json`:
  ```json
  { "framework": "nextjs", "buildCommand": "next build", "outputDirectory": ".next" }
  ```
- For Hono / non-Next backend: framework should be `null`, `outputDirectory` is the build dir, and `installCommand` may need `npm ci`
  - **Known case**: `dtwin-graph` Hono backend — Vercel preview project must be **unlinked from the repo** (see memory `reference_dtwin_graph_no_vercel_preview`)

## Phase 2 — Apply the fix

Order of operations (least disruptive first):

1. **Env var add/update** via `vercel env add` or Vercel MCP — never edit a deployed env var without recording the previous value
2. **Redeploy** the failing commit — `vercel --prebuilt` if build artifact still valid, else fresh build
3. **Code change** in a new PR — for any non-env fix, file a follow-up PR. Never commit directly to `main` to "fix Vercel".
4. **Disable framework auto-detection** with explicit `vercel.json` if misdetection persists
5. **Rollback** via Vercel UI promote-previous-deployment if user-facing production is broken AND fix-forward >15 min away

## Phase 3 — Confirm

- [ ] New deployment is `READY` (not just `BUILDING`)
- [ ] Hit the actual broken route and confirm 200 (not just `/`)
- [ ] If it was a runtime issue → tail `vercel logs --runtime --follow` for 60s to confirm no recurring error
- [ ] Capture screenshot evidence (use `plyne-app` visual-evidence pipeline if available)

## Hard rules

1. **Never disable a CI gate to make Vercel green** — fix the root cause.
2. **Never push to `main` to bypass branch protection** — even when Vercel prod is down.
3. **Never use `vercel --force` on production** without explicit user approval — it skips the build cache and can mask the actual problem.
4. **Never share env values in PR comments / chat logs** — Vercel CLI is authenticated, reference them by key only.
5. **For paying products (ME/BX/CR/IR/KX/GK/DT) any Vercel env change must be communicated to Alberto** before apply.
