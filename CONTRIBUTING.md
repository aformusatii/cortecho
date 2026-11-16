# Contributing to Cortecho

Thanks for helping. This project is small and opinionated; read this page
before opening a large pull request.

## Before you start

- For a bug, open an issue with the `/health` output and `cortecho doctor`
  output (remove addresses, names and keys first).
- For an Echo model that works, use the **Device report** template.
- For a larger feature, open an issue first so we can agree on the approach.

## Quality gates

Run from the repository root:

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e     # when the UI or HTTP behaviour changes
```

All four must pass. `npm run format` fixes formatting. No test needs a real
Echo, an OpenAI key or the internet.

## Adding a tool

A tool is one file in `apps/api/src/tools/plugins/` plus one registration line.
Read the example in [docs/development.md](docs/development.md#adding-a-tool).

- Mark it `destructive: true` if it changes the real world. Destructive tools
  are hidden from the model and refused unless their name is in
  `TOOLS_ALLOW_DESTRUCTIVE`.
- The model only chooses **names** from a fixed list, never URLs or command
  lines.
- Add a test and document the new variable in `docs/configuration.md`.

## Adding a setting

One descriptor in `packages/shared/src/settings.registry.ts` plus the code that
reads it. The UI is generated. Never add a behaviour setting to `config.ts`:
that file is environment-only.

## Adding an ESPHome message

Check hassmic's `proto_esphome.c` first; the code wins over documentation. Add
the message to `messages.ts`, handle it in the client or pipeline, teach
`FakeEcho` to send it, and cover it in `voice-pipeline.test.ts`. Device-admin
messages are out of scope: Cortecho must never change the Echo's configuration.

## Conventions

- TypeScript must be erasable (Node strips types): no `enum`, no `namespace`,
  no constructor parameter properties; `import type` for types; `.ts` in
  relative imports.
- Comments explain **why**, at the decisions a reader could trip on.
- Errors use `{ error: { code, message, fields? } }`.
- Keep secrets write-only and never log audio, keys or tokens.

## Reporting a device

Only the Echo Dot 2nd gen is tested today. For another model, use the
**Device report** template with the model, firmware, echo-dot-assist version,
`hassmic.conf` `PROTO`, and whether the voice loop (wake word → answer) works.
Do not include your API keys or LAN addresses.
