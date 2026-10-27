# Embrilo OS — UI/UX Redesign Specification

Status: design baseline for the existing internal console. This document changes presentation and information architecture, not the workflow or authorization model.

## Product experience

Embrilo OS is an operations workspace for handling AI-assisted content orders. The operator's primary question is: **what needs attention now, and what is the safest next action?** Do not make the operator infer this from a dense table or raw state code.

## Visual direction

- Premium, restrained, modern, calm, editorial SaaS.
- Warm off-white canvas, white surfaces, deep forest-green primary, restrained lime accent, dark ink, muted gray-green text.
- Strong typographic hierarchy, generous whitespace, subtle borders and low-elevation shadows.
- Avoid neon gradients, excessive glassmorphism, decorative dashboards, huge empty hero sections, emoji icons, and rainbow status colors.
- Use a consistent spacing scale, radius scale, typography scale, focus treatment, and semantic color tokens.
- Keep content density useful for an operations console; visual polish must not hide information or actions.

## Language and terminology

- Indonesian-first interface. Keep stable technical identifiers (job IDs, provider IDs, state codes, correlation IDs) unchanged where needed.
- Use plain language: Antrean, Pemeriksaan, Brief, Produksi AI, Tinjauan kualitas, Revisi, Hasil terkirim, Audit.
- Explain technical failures in operator-friendly language; show a correlation reference for support.
- Avoid mixed English/Indonesian sentences except for proper product names and unavoidable identifiers.

## Information architecture

1. **Antrean** — top priority: open work count, work requiring attention, filters, searchable/reference-first job rows, status, service, priority, assignee, age/last update.
2. **Detail pekerjaan** — clear job header and current status; a primary next-action panel; brief and source facts; prompt/production runs; QC; revisions/delivery; assets; audit timeline.
3. **Produksi AI** — clear explanation that Genspark is manual-assisted until a supported automated connector is verified. Copy-ready prompt and output attachment should feel like a guided handoff, not a raw debug panel.
4. **Metrik** — meaningful labels and definitions, no unexplained metric keys; emphasize cycle time, accepted output, revisions, operator effort, and provider blocks.
5. **Audit** — searchable/scannable activity, safe metadata, readable timestamps and correlation IDs.

## Interaction requirements

- Every page has one clear title and a short contextual description.
- One visually dominant primary action per workflow state; destructive actions are separated and clearly named.
- Forms group related fields, use persistent labels, show field-level validation, and preserve entered data after recoverable errors.
- Status uses text plus restrained color; never rely on color alone.
- Tables scroll horizontally on small screens, keep critical identifiers visible, and offer a useful empty state.
- Buttons show hover, focus, disabled and submitting states. Prevent accidental double submits without silently trapping the user.
- Confirmation messages identify what changed. Error messages explain the recovery step.
- Keyboard navigation, visible focus, semantic headings, accessible names, reduced-motion support and readable contrast are mandatory.
- Do not introduce a client framework or large UI dependency solely for visual polish; maintain the existing Hono JSX server-rendered architecture unless evidence proves it blocks a requirement.

## Architecture guardrails

- UI changes must preserve existing Hono routes, server-side role checks, CSRF protections, state-transition rules, audit writes, and customer-scope checks.
- Do not move authorization into the browser.
- Do not expose internal notes, private assets, provider secrets, customer tokens, or unapproved deliverables.
- Keep static assets external to comply with the current CSP. No inline scripts or inline event handlers.
- Keep the Public Embrilo app separate from this internal repo and deployment.

## Acceptance checklist

- [ ] Queue page clearly distinguishes work requiring attention from other jobs.
- [ ] Job page presents current state, next action, brief, prompt/run, QC and delivery in a predictable hierarchy.
- [ ] Main navigation and operator-facing copy are Indonesian-first and consistent.
- [ ] Login, queue, job detail, metrics, provider status and audit pages work at 320px mobile width and desktop widths.
- [ ] Keyboard focus and reduced-motion preferences remain usable.
- [ ] Existing security/workflow tests remain green; new UI behavior does not bypass server checks.
- [ ] Build and tests are run against the actual current branch before any deployment claim.
- [ ] Visual review is performed on real rendered pages; a CSS-only commit is not proof of finished UX.
