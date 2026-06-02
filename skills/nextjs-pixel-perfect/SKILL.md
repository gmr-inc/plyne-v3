---
name: nextjs-pixel-perfect
description: Anthropic Design pack -> Next.js handoff workflow. Pixel-perfect implementation of design specs into Next.js + Tailwind + shadcn.
usage: Activate when task declares skills nextjs-pixel-perfect, or user provides a design URL/screenshot and asks for Next.js implementation.
mcp_dependencies: [vercel, github]
version: 1.0.0
---

# Next.js Pixel Perfect — GMR playbook

## Phase 1 — Spec ingestion

1. Open design pack URL (Anthropic Design or Figma export).
2. Inventory: components, tokens (colors, spacing, typography), interactions.
3. Map to shadcn primitives where possible (Button, Card, Dialog, etc.).

## Phase 2 — Implementation

1. Start with tokens (`tailwind.config.ts` extends + CSS vars).
2. Build static layout first (no interactions).
3. Add interactions + state.
4. Co-locate component tests `*.test.tsx`.

## Phase 3 — Visual evidence

1. Run Playwright screenshot script on the changed pages.
2. Diff against design pack screenshots.
3. Post Claude Vision verdict + public Vercel deploy URL in PR body.

## Hard rules

1. Never ship without visual evidence in PR body (memory rule).
2. Never copy-paste from old products — start from shadcn primitives.
3. Lighthouse a11y score must be >= 90 before requesting review.
