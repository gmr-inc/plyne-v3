---
name: supabase-migration-applier
description: |
  Safe Supabase migration workflow for GMR projects. Walks through dry-run, backup,
  apply, and verify steps so a migration is never applied to production without a
  reversible escape hatch. Use whenever a task involves running a `.sql` migration
  against a Supabase project, especially production.
usage: |
  Activate when task involves `supabase migration`, `psql apply`, `schema change`,
  `RLS update`, or any `INSERT/UPDATE/DELETE`/`ALTER`/`DROP` against a Supabase DB.
  Requires `supabase` MCP server.
trigger_intents:
  - "apply this migration"
  - "run the SQL against prod"
  - "alter table on supabase"
  - "fix RLS policies"
mcp_dependencies: [supabase]
authors: [alberto.nasciuti@kpi6.com]
version: 1.0.0
---

# Supabase Migration Applier — safe workflow

## Pre-flight gates (refuse to proceed if ANY fails)

- [ ] Migration file path identified (e.g. `supabase/migrations/20260601_*.sql`)
- [ ] Target environment declared explicitly: `dev` | `staging` | `prod`
- [ ] If `prod`: explicit user confirmation captured in the task history (no "yes" inferred)
- [ ] Migration file is checked into git (NEVER run a SQL string from chat against prod)
- [ ] DB connection info present in env (`SUPABASE_DB_URL` or `SUPABASE_PROJECT_REF` + service role)
- [ ] Backup branch / restore-point capability confirmed (Pro plan or self-managed dump)

## Phase 1 — Dry run

1. List statements:
   ```bash
   supabase db diff --linked --schema public
   # OR for offline file:
   psql "$SUPABASE_DB_URL_DRY" -f supabase/migrations/<file>.sql --single-transaction --set ON_ERROR_STOP=on --echo-all --dry-run-with-explain 2>&1 | tee /tmp/migration-dryrun.log
   ```
2. Classify each statement by risk:
   - 🟢 SAFE: `CREATE TABLE`, `CREATE INDEX CONCURRENTLY`, `CREATE POLICY`, `GRANT`, `ALTER TABLE … ADD COLUMN <nullable>`
   - 🟡 LOCKY: `ALTER TABLE … ADD COLUMN NOT NULL DEFAULT …` (table rewrite), `CREATE UNIQUE INDEX` (no CONCURRENTLY), `DROP POLICY` (RLS gap window)
   - 🔴 DESTRUCTIVE: `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE … WHERE` without limit, `ALTER COLUMN TYPE` (rewrite + may lose data)
3. If 🔴 present → REQUIRE an explicit `# AUTHORIZED DESTRUCTION` comment in the migration file (see memory `feedback_spec_authorize_destruction`). Refuse otherwise.

## Phase 2 — Backup

Pick the lightest backup that still allows full restore:

- **Schema-only** (DDL change, no data loss expected):
  ```bash
  pg_dump "$SUPABASE_DB_URL" --schema-only --no-owner --no-privileges > /tmp/backup-schema-$(date +%Y%m%d-%H%M%S).sql
  ```
- **Full** (data-altering migration):
  ```bash
  pg_dump "$SUPABASE_DB_URL" --no-owner --no-privileges --format=custom \
    -f /tmp/backup-full-$(date +%Y%m%d-%H%M%S).dump
  ```
- **Supabase Point-in-Time Recovery** (Pro/Team plan): trigger via dashboard or MCP, record the timestamp T0
- **Targeted snapshot** of affected tables only:
  ```bash
  psql "$SUPABASE_DB_URL" -c "CREATE TABLE <table>_backup_<ts> AS SELECT * FROM <table>;"
  ```

Capture the backup path / PITR timestamp in the task history.

## Phase 3 — Apply

Always apply inside a single transaction unless the migration contains `CREATE INDEX CONCURRENTLY` (which cannot run in a transaction):

```bash
psql "$SUPABASE_DB_URL" \
  --single-transaction \
  --set ON_ERROR_STOP=on \
  -f supabase/migrations/<file>.sql \
  2>&1 | tee /tmp/migration-apply.log
```

For Supabase-managed projects, prefer `supabase db push --linked` which:
- Validates against the local migration history
- Records the migration row in `supabase_migrations.schema_migrations`
- Aborts cleanly on error

## Phase 4 — Verify

Run product-specific smoke queries declared in the AC. Examples:

```sql
-- Row counts unchanged on tables not in scope
SELECT count(*) FROM <unrelated_table>;

-- New column populated for legacy rows (if migration includes a backfill)
SELECT count(*) FROM <table> WHERE <new_col> IS NULL;  -- expect 0

-- RLS still enforced
SET role anon;
SELECT count(*) FROM <protected_table>;  -- expect 0 or RLS error
RESET role;

-- Indexes valid
SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='<table>';
```

## Phase 5 — Rollback (only if verify fails)

1. If migration was a single transaction and failed → already rolled back, log the error and stop.
2. If migration committed but verify shows damage:
   - **Schema-only backup**: drop offending objects + restore from `pg_dump --schema-only` (skip data restore)
   - **Full backup**: `pg_restore --clean --if-exists --dbname="$SUPABASE_DB_URL" /tmp/backup-full-*.dump`
   - **PITR**: trigger restore-to-timestamp T0 via Supabase dashboard
3. File a follow-up task with status `needs-operator` describing what went wrong + the new migration plan

## Hard rules

1. **Never run a destructive migration on prod without explicit Alberto / PO approval.**
2. **Never run a migration whose file is not checked into git.**
3. **Never skip the backup step on prod**, even for "trivial" changes.
4. **Never run `DROP TABLE` / `TRUNCATE` outside a transaction.**
5. **Never apply Supabase breaking changes preemptively** (legacy keys, Data API auto-expose) — those have org-wide rollout dates (see memory `project_supabase_2026_changes`).
6. **For paying products (ME/BX/CR/IR/KX/GK/DT)** the apply step requires real-time confirmation in the task channel.
