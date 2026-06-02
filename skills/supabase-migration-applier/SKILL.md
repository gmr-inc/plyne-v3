---
name: supabase-migration-applier
description: Safe migration workflow — dry-run, backup, apply, verify. Refuses to run on prod without explicit confirm.
usage: Activate when task declares skills supabase-migration-applier, or user asks to apply a SQL migration on a Supabase project.
mcp_dependencies: [supabase]
version: 1.0.0
---

# Supabase Migration Applier — GMR playbook

## Phase 1 — Dry-run

1. Read the migration SQL file.
2. Identify destructive ops (DROP, ALTER COLUMN TYPE, TRUNCATE).
3. If destructive: REQUIRE Alberto explicit confirmation in chat.

## Phase 2 — Backup

1. Use supabase MCP to dump affected tables to a snapshot table `_bk_YYYYMMDD_<table>`.
2. Record snapshot ids in task comment for rollback path.

## Phase 3 — Apply

1. Run migration via supabase MCP execute_sql.
2. Verify by running 1-2 sample SELECTs to confirm shape.
3. Comment on task with applied migration name + timestamp.

## Phase 4 — Verify

- Re-run app-side smoke test (if relevant).
- Tail Sentry for new errors in next 10 minutes.

## Hard rules

1. Never apply to production without Alberto confirm.
2. Always create backup table for destructive migrations.
3. Always commit the migration file to the repo BEFORE applying (audit trail).
