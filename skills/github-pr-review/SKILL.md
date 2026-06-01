---
name: github-pr-review
description: |
  Standard GMR pull-request review playbook. Use whenever a task involves reviewing,
  approving, or requesting changes on a GitHub PR — whether the PR was opened by Plyne,
  another teammate, or a third-party contributor. Enforces structure-naming-AC verification
  before any approval signal.
usage: |
  Activate when the task config declares `skills: ["github-pr-review"]`, or when the user
  asks to "review this PR" / "validate the PR for me" / "should we merge?".
trigger_intents:
  - "review PR #N"
  - "should we merge this"
  - "is this PR ready"
  - "validate acceptance criteria for PR"
mcp_dependencies: [github]
authors: [alberto.nasciuti@kpi6.com]
version: 1.0.0
---

# GitHub PR Review — GMR playbook

## When to invoke

- Task is about validating, approving, or requesting changes on a GitHub PR.
- PR is opened against a GMR repo (any product).
- You have `github` MCP server attached.

## Checklist (run in order, stop at first FAIL → leave PR review comment)

### 1. PR metadata sanity

- [ ] Title follows convention: `<type>(<scope>): <subject> (TASK-ID)`
  - `type` ∈ feat|fix|chore|refactor|test|docs|ci
  - `scope` typically the product or area
  - TASK-ID matches `^[A-Z]{2,6}-[A-Z0-9-]+$` (e.g. `PL-CTO-FOO-001`, `BX-PULSE-002`)
- [ ] PR body has a `## Summary` (1-3 bullets) and `## Test plan` (markdown checklist)
- [ ] Linked task id in body OR commit trailer

### 2. File structure

- [ ] No accidental commits of `.env`, `.env.local`, credentials, `*.pem`, large binaries (>500KB)
- [ ] No vendored `node_modules/` or `dist/` (unless intentional for a release)
- [ ] Lockfile (`package-lock.json`, `pnpm-lock.yaml`, `bun.lock`) updated alongside `package.json` changes — never one without the other

### 3. Naming conventions

- [ ] React components: PascalCase, one per file
- [ ] Hooks: `useXxx` camelCase
- [ ] Test files: co-located `*.test.ts(x)` OR `__tests__/*`
- [ ] No `tmp.*`, `foo.*`, `bar.*`, `wip.*` placeholders in the diff

### 4. Acceptance Criteria verification

- [ ] Fetch the linked task (use `plyne.task.get` if available, else Notion MCP)
- [ ] For each AC line in the task body:
  - [ ] Identify which file/test/command demonstrates it
  - [ ] If `run:` directive present → actually execute (locally or via CI logs)
  - [ ] If `expect_exit: 0` declared → confirm CI green
- [ ] Mark each AC line ✓ or ✗ in the review comment

### 5. CI gates

- [ ] All required checks ✅ (lint, typecheck, test, build, Vercel preview)
- [ ] No new test files added with `.skip` or `.only`
- [ ] If coverage threshold configured → did not drop

### 6. Code-review bot

- [ ] CodeRabbit (or whichever bot is configured via `BOT_REVIEWER_LOGIN_SUBSTRING`) has commented
- [ ] All HIGH-severity findings addressed (LOW/INFO can be deferred with explicit note)

### 7. Risk surface

- [ ] No secret references hardcoded (look for `sk_`, `xoxb-`, `ghp_`, `pat_`, `eyJ` JWT prefixes)
- [ ] DB migrations are reversible OR have an explicit `# IRREVERSIBLE` comment + Alberto approval
- [ ] Route handler diff has auth check (search the diff for `getUser`, `getSession`, `requireAuth`)
- [ ] No `dangerouslySetInnerHTML` introduced without sanitization

## Output format

Always post the review as a single GitHub PR review comment with this structure:

```markdown
## Review — <task-id>

**Verdict**: APPROVE / REQUEST_CHANGES / COMMENT

### AC verification
- [x] AC1: …
- [ ] AC2: missing — see file X line Y

### Findings
- 🔴 BLOCKER: <issue>
- 🟡 NIT: <issue>
- 🟢 OK: <area>

### Test plan executed
- [x] `pnpm test` — green (exit 0)
- [ ] manual: …
```

## Hard rules (do NOT violate)

1. **Never approve with --admin merge bypass** on paying products (PL-CTO ok, ME/BX/CR/IR/KX/GK/DT not ok).
2. **Never approve if AC checklist has any ✗** — request changes instead.
3. **Never approve without reading the actual diff** — title-only review is forbidden.
4. **Never force-push to a `release-please` or `releases/*` branch.**
5. **Quote `@jcte02` for Luna, not `@luna`** (latter is a non-existent handle that spams random users).
