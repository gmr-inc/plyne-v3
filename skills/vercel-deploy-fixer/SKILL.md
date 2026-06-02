---
name: vercel-deploy-fixer
description: Diagnose and fix Vercel deploy failures. Reads deployment logs, classifies the failure (build / runtime / env / domain), and proposes minimal patch.
usage: Activate when task declares skills vercel-deploy-fixer, or user reports a Vercel preview/prod deploy failing.
mcp_dependencies: [vercel, github]
version: 1.0.0
---

# Vercel Deploy Fixer — GMR playbook

## Phase 1 — Classify

1. Pull latest deployment for the project (vercel MCP).
2. Read build logs + runtime logs.
3. Bucket into one of: BUILD_ERROR, RUNTIME_ERROR, ENV_MISSING, DOMAIN_DNS, FRAMEWORK_DETECTION.

## Phase 2 — Diagnose

- BUILD_ERROR: find first non-warning error line. Map to file. Check recent commits in repo.
- RUNTIME_ERROR: Sentry first (mcp__sentry__search_issues), then Vercel runtime logs.
- ENV_MISSING: list env vars on Vercel, diff against `.env.example` in repo.
- DOMAIN_DNS: check Cloudflare DNS records, verify CNAME target.
- FRAMEWORK_DETECTION: ensure framework preset matches actual stack (Next.js vs Hono backend confusion).

## Phase 3 — Fix

- Patch the smallest possible change. Branch name: `fix/vercel-deploy-<short-cause>`.
- Open PR with logs link in body.
- Verify preview deploy green before requesting review.

## Hard rules

1. Never disable a check to make CI green.
2. Never push directly to main to fix a deploy.
3. If root cause is env var not set in Vercel, file the env var addition as a separate audit-trail commit/comment.
