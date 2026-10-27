# Embrilo OS — Internal Operations System

This repository defines the operating model and architecture for Embrilo's internal production system. It is temporarily public by decision; treat every committed file as visible to anyone. It contains no credentials or customer records.

## Documentation
- docs/00-source-of-truth.md
- docs/01-market-research.md
- docs/02-architecture-clusters.md
- docs/03-data-model-api.md
- docs/04-provider-strategy.md
- docs/05-security-operations.md
- docs/06-roadmap-metrics.md
- prompts/genspark-production-master-prompt.md

## Mission
Receive customer briefs from Public Embrilo, qualify requests, create production jobs, coordinate Genspark-assisted content creation, review output, handle revisions, and authorize delivery.

## Decisions
- Separate public and internal repositories and deployments.
- Public communicates through a narrow authenticated API; never access internal D1 directly.
- Cloudflare-first: Workers, D1, private R2; add Queues when async processing is needed.
- Human QC before delivery in MVP.
- Genspark integration is unverified until an actual supported connector/API/MCP or operator handoff passes an end-to-end test.

## Current status
This is a documentation blueprint. A running app, connector, database, Genspark integration, and deployment have not been verified. Do not describe them as live.