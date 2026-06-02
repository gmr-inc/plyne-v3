---
name: github-pr-review
description: Standard GMR pull-request review playbook. Use whenever a task involves reviewing, approving, or requesting changes on a GitHub PR. Enforces structure-naming-AC verification before any approval signal.
usage: Activate when the task config declares skills github-pr-review, or when the user asks to review a PR / validate the PR / should we merge?
mcp_dependencies: [github]
version: 1.0.0
---

# GitHub PR Review — GMR playbook

## When to invoke

- Task is about validating, approving, or requesting changes on a GitHub PR.
- PR is opened against a GMR repo (any product).
- You have `github` MCP server attached.

## Checklist (run in order, stop at first FAIL -> leave PR review comment)

### 1. PR metadata sanity

- [ ] Title follows convention: `<type>(<scope>): <subject> (TASK-ID)`
- [ ] PR body has a `## Summary` (1-3 bullets) and `## Test plan` (markdown checklist)
- [ ] Linked task id in body OR commit trailer

### 2. File structure

- [ ] No accidental commits of `.env`, `.env.local`, credentials, `*.pem`, large binaries (>500KB)
- [ ] No vendored `node_modules/` or `dist/` (unless intentional for a release)
- [ ] Lockfile updated alongside `package.json` changes — never one without the other

### 3. Naming conventions

- [ ] React components: PascalCase, one per file
- [ ] Hooks: `useXxx` camelCase
- [ ] No `tmp.*`, `foo.*`, `bar.*`, `wip.*` placeholders

### 4. Acceptance Criteria verification

- [ ] Fetch the linked task (use `plyne.task.get` if available, else Notion MCP)
- [ ] For each AC line: identify which file/test/command demonstrates it
- [ ] If `run:` directive present -> actually execute (locally or via CI logs)
- [ ] Mark each AC line OK or FAIL in the review comment

### 5. CI gates

- [ ] All required checks green (lint, typecheck, test, build, Vercel preview)
- [ ] No new test files added with `.skip` or `.only`

### 6. Code-review bot

- [ ] CodeRabbit has commented
- [ ] All HIGH-severity findings addressed

### 7. Risk surface

- [ ] No secret references hardcoded (look for `sk_`, `xoxb-`, `ghp_`, `pat_`, `eyJ`)
- [ ] DB migrations are reversible OR explicit IRREVERSIBLE + Alberto approval
- [ ] No `dangerouslySetInnerHTML` introduced without sanitization

## Hard rules

1. Never approve with `--admin` merge bypass on paying products.
2. Never approve if AC checklist has any FAIL.
3. Never approve without reading the actual diff.
4. Never force-push to a `release-please` or `releases/*` branch.
5. Quote `@jcte02` for Luna, not `@luna` (latter is a non-existent handle).
