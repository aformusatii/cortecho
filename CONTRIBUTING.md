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

All four must pass (the last when the UI or HTTP behaviour changes).
`npm run format` fixes formatting. No test needs a real Echo, an OpenAI key or
the internet.

## Pull requests and releases

- **Title:** a Conventional Commit (`feat`, `fix`, `perf`, `docs`, `test`, `ci`,
  `chore`, `refactor`, `build`; `!` or a `BREAKING CHANGE:` footer for a
  breaking change). With squash merge the title becomes the commit on `main`
  and drives the version.
- **Required checks:** `ci` (typecheck, lint, unit, e2e), `image` (the build),
  `integration` (that digest in the Docker lab) and `pr-title`. The branch must
  be up to date; the merge is **squash only** and cannot bypass checks.
- **Releases happen on merge.** `feat` publishes a minor, `fix`/`perf` a patch,
  a breaking change a major (minor while 0.x); other types publish nothing and
  only move `:main`. The release re-tags the same digest that was tested, so
  `:latest` means the newest release. Never push a `v*` tag by hand.
- A maintainer may deploy a PR's image to a stage (the production-like install
  serving the real Echo) before merging, on request. That is not a required
  step and does not replace the checks.

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
