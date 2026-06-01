---
name: nextjs-pixel-perfect
description: |
  Anthropic Design pack → Next.js (App Router) implementation workflow. Use whenever
  a task ships UI from a design handoff and must be pixel-perfect across desktop +
  mobile breakpoints, with screenshot evidence at the end.
usage: |
  Activate when task references a design pack (PNG/Figma/Anthropic design URL),
  declares `mobile-first` or `pixel-perfect`, or has `nextjs-component-pixel-perfect`
  in its skills array. Requires `vercel` MCP + `github` MCP.
trigger_intents:
  - "implement this design"
  - "match the figma"
  - "pixel-perfect from the design pack"
  - "render this screen exactly as the mockup"
mcp_dependencies: [vercel, github]
authors: [alberto.nasciuti@kpi6.com]
version: 1.0.0
---

# Next.js Pixel-Perfect — design pack handoff

## Inputs you need before coding

1. **Design pack URL** (Anthropic Design, Figma, or local `tar.gz` like `/tmp/plyne-design-pack.tar.gz`)
2. **Target route** (e.g. `/app/(dashboard)/tasks/[id]/page.tsx`)
3. **Breakpoints** declared in task — default GMR set: `mobile=375` `tablet=768` `desktop=1280` `wide=1920`
4. **Component framework** — usually shadcn/ui + Tailwind (see memory `project_portfolio_architecture_patterns`)
5. **Dark/light mode** support — declare which is canonical for pixel-match

If any input is missing → ask in the task comments and stop. Do not invent designs.

## Phase 1 — Decompose the design

Walk through each artifact in the design pack:

- [ ] Identify atomic components (Button, Badge, Card) — check if shadcn equivalent exists; install via `pnpm dlx shadcn@latest add <name>` instead of re-implementing
- [ ] Identify composed components (TaskCard, QuotaPanel) — these go in `components/<feature>/`
- [ ] Identify layout primitives (Header, Sidebar, Container) — these go in `app/<route>/layout.tsx`
- [ ] Note typography scale — map to `tailwind.config` `fontSize` extensions
- [ ] Note color palette — map to CSS variables in `app/globals.css` `:root` + `[data-theme="dark"]`
- [ ] Note spacing rhythm — almost always 4px base; convert design px → Tailwind `space-x-N` (N = px/4)

## Phase 2 — Skeleton first (server components)

1. Start from the layout: ensure parent `layout.tsx` provides the correct container + safe-area-insets for mobile
2. Render static markup with placeholder data (hardcoded JSON) — no fetch wiring yet
3. Run `pnpm dev`, open at 375 → 768 → 1280 → 1920 width and screenshot each
4. Compare side-by-side with design pack; capture diff regions in a markdown checklist

## Phase 3 — Hydrate

1. Add `"use client"` only where interactive (state, effects, event handlers)
2. Wire data via:
   - Server Component `await fetch(...)` for static data
   - `useSWR` / `react-query` for live data (declare cache strategy explicitly)
   - Server Actions for mutations
3. Add loading + error states matching the design (skeleton shimmer, empty illustration, retry button)

## Phase 4 — Pixel-match audit

Use the GMR visual-evidence pipeline (see memory `feedback_visual_evidence_pipeline_standard`):

```bash
# Run the standard screenshot script on scorta — DO NOT inline screenshots into chat
pnpm evidence -- --url http://localhost:3000/<route> --breakpoints 375,768,1280,1920 --output /tmp/evidence-<task-id>/
```

Output: 4 PNGs + a Claude Vision verdict + a public Vercel deploy URL.

Audit checklist per breakpoint:

- [ ] Header logo + nav matches (size, alignment, gap)
- [ ] Typography hierarchy correct (h1 vs h2 vs body)
- [ ] Color palette exact (use a color picker — eyeballing fails)
- [ ] Spacing rhythm consistent (no rogue `mt-7` where `mt-8` is the system)
- [ ] Interactive states (hover, focus-visible, active, disabled) implemented
- [ ] Mobile tap targets ≥44px height
- [ ] Empty state matches
- [ ] Loading skeleton matches
- [ ] Dark mode passes (run audit again with `?theme=dark`)

## Phase 5 — Accessibility floor

Non-negotiable per route:

- [ ] All interactive elements reachable by keyboard (Tab + Shift+Tab)
- [ ] `focus-visible` ring visible against background
- [ ] Color contrast ≥ AA (4.5:1 body, 3:1 large text + UI components)
- [ ] Images have `alt=""` or descriptive alt
- [ ] Form fields have `<label htmlFor>` or `aria-label`
- [ ] Live regions use `aria-live="polite"` where dynamic content updates

## Phase 6 — Deliver

Open the PR with:

- Body: design pack URL + before/after screenshots (use the public Vercel deploy URL, not local file paths)
- Test plan: `pnpm dev` → visit `<route>` → confirm at each breakpoint
- Linked task id

## Hard rules

1. **No `<img>` for design assets** — always Next.js `<Image>` with `width`/`height` + `sizes`
2. **No inline `style={{...}}`** for design tokens — use Tailwind classes or CSS variables
3. **No `tailwind-merge` collisions** — use `cn()` helper for conditional classes
4. **No layout shift** — declare image dimensions, font fallbacks (`font-display: swap` + `next/font`)
5. **No design copy in code without screenshot evidence in the PR body** — text claim "matches Figma" is rejected by default (see memory `feedback_visual_evidence_pipeline_standard`)
