# Genspark Execution Runbook — Internal App

## Before starting
- Read `prompts/master-system-prompt.md` and docs 00–06.
- Confirm repository write access and the intended branch.
- Inspect existing files and deployment configuration before changing anything.
- Use synthetic data only.

## Execution checkpoints
1. **Repository audit:** list existing code, scripts, runtime, tests and blockers.
2. **Foundation:** schema/migrations, environment example with placeholders only, safe local setup.
3. **Internal console:** protected queue, job detail, production status, QC, revision and approval.
4. **Connector:** implement the smallest API surface required by Public Embrilo; version and test it.
5. **Provider:** verify a real supported Genspark connection or keep manual-assisted mode.
6. **Quality:** run build/tests and test access denial, idempotency, unsafe state transitions and provider failure.
7. **Deployment:** deploy only to a confirmed authorized project; verify URL and health after deployment.

## Rules
- This repository is public for now; never commit credentials, live customer briefs, real output files or private notes.
- Never claim a connector, deployment or test passed without evidence.
- Never publish an unreviewed customer deliverable.
- Record blockers and the exact required action; do not silently replace missing integrations with mocks and call them live.

## Handoff checklist
- [ ] Operator access protected
- [ ] D1 schema/migrations documented and tested
- [ ] Private R2 access path documented and tested if configured
- [ ] Connector contract and auth tested
- [ ] Provider mode clearly labeled
- [ ] QC and approval gate enforced
- [ ] Build/test output recorded
- [ ] Deployment verified or explicitly pending