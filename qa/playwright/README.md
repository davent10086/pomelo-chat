# Browser test compatibility

The active browser tests live in `tests/e2e/`; real media lives in
`tests/special/rtc/`. Run `pnpm test:e2e` or `pnpm test:rtc` from the repository root.
Files are discovered by `**/*.e2e.spec.ts`; there is no filename allowlist.

The former `ai-assistant.e2e.spec.ts` used obsolete Copilot/address-book selectors.
Its online-model smoke is maintained in `tests/special/ai-live/assistant.e2e.spec.ts`.
Its task-selection and confirmation intent is covered by
`tests/e2e/assistant-interactions.e2e.spec.ts` with current UI and deterministic responses.
