# SillyTavern Story Workflow

Two companion extensions for planning, writing, checking, and reviewing a long story from a normal SillyTavern chat prompt.

**Story Builder** prepares an outline, writes connected sections, checks continuity, and combines the accepted prose. **Story Review** runs independent continuity and prose reviews and proposes bounded revisions. The finished manuscript can be added to chat. A live activity panel shows request timing and response status without dumping your prompt or model reasoning.

This is an early release. Model output can still fail validation or leave editorial findings. A source reference proves where text came from; it does not prove that a model interpreted it correctly.

## Requirements

- SillyTavern 1.19 or later with an OpenRouter chat-completions connection.
- Node.js 20 or later for the installer and tests.
- Both extension folders installed together with the exact names `StoryBuilder` and `StoryReview`.

This repository contains two extensions, so use the installer below or copy the two folders manually. Pasting the monorepo URL into SillyTavern's single-extension installer is not supported.

## Install

Clone or download this repository, then run these commands from its directory:

```sh
node scripts/install.mjs --target "/path/to/SillyTavern"
node scripts/install.mjs --target "/path/to/SillyTavern" --apply
```

The first command previews the files. The second installs them under `public/scripts/extensions/third-party`, backing up files that it replaces. It does not edit SillyTavern settings, writing presets, connection profiles, lorebooks, or chats. On first load, the extensions fill in only their own missing preferences; existing values win.

For a manual installation, copy `extensions/StoryBuilder` and `extensions/StoryReview` into SillyTavern's `public/scripts/extensions/third-party` folder. Back up existing folders before replacing them.

Refresh SillyTavern after installation. In **Extensions → Story Builder**, choose your writer, planner, and reviewer models and check your length and spending settings. Enable **Run Story Builder on Send and Regenerate** when you want the automatic workflow. It starts off so installation does not intercept ordinary chat requests unexpectedly.

## Use

1. Open a one-character chat and select your OpenRouter connection and usual writing preset.
2. Set the story targets and choose the workflow options in Story Builder.
3. Send your complete story prompt normally. To replace an existing reply, save your edit to the latest user prompt and choose **Regenerate**.
4. Follow the activity panel. **View details** shows the outline, accepted sections, and editorial findings.

The workflow preserves the complete context supplied by SillyTavern's normal prompt preparation. Hidden history and inactive lorebook entries are not magically recovered. Each later section receives the accepted earlier sections. Planning uses code-generated source references so the planner does not have to reproduce long quotations exactly.

**Pause** preserves completed work in the current browser tab. **Resume** continues the unfinished stage. Download a partial manuscript before closing or refreshing the tab; unfinished jobs are not saved as durable disk checkpoints. An edited source chat or changed writing settings can require a fresh outline.

## Cost and models

Every planning, writing, checking, review, and revision request can incur provider charges. A long source is reused across multiple requests. Output length, latency, and cost vary by model and provider.

The public starter preferences use Aion 3.5 for writing and Aion 3.5 Mini for planning and review, targeting 10,000–12,000 words in four sections. They allow one revision round with at most two revised passages and set a **$1 workflow spending limit**. Automatic Send/Regenerate interception remains off until you enable it.

Before dispatching a request, the workflow reserves an estimate using uncached input pricing and the maximum output allowance. If another request would exceed the limit, it pauses and preserves the staged work. **Resume retains the same cost ledger and does not reset the allowance.** A large source may prevent a 10,000–12,000-word story from finishing within $1. The limit is a pre-request safeguard, not a provider billing guarantee: provider tokenization, interrupted requests, and delayed usage reports can differ from the estimate. Review the estimate and limit before starting a job.

Story Builder's automatic zTracker updates are off while a positive spending limit is active. This does not change zTracker's own global settings or its behavior on normal chat replies. Standalone automatic Story Review starts off and has separate controls; its independent requests are not part of a Builder job's limit.

## Optional extensions

- **zTracker:** installed separately. The automatic handoff expects modules with IDs `scene-tracker` and `plot-log`, the `/ztracker-generate` command, and cancellation/stale-write guards in zTracker itself. Those third-party changes and module configurations are not bundled here. Keep automatic tracker updates off unless your installation implements that contract; use zTracker's own controls otherwise. External tracker requests are outside Story Builder's cost accounting.
- **MemoryBooks:** installed separately. Memory creation remains an explicit action; this repository includes no saved memory books or automatic history-hiding operation.
- **NastyTavern:** the progress panel includes layout support. Custom themes and fork versions may require adjustment.

## Develop and fork

```sh
npm test
```

Tests use invented fixtures and mock transports. They do not contact models or read your SillyTavern chats. The repository does not include the maintainer's local installations, provider-response artifacts, or private writing configuration.

```text
extensions/StoryBuilder/   orchestration, source capture, progress UI
extensions/StoryReview/    editorial services and standalone review UI
scripts/install.mjs       portable files-only installer
tests/builder/            Builder regressions
tests/review/             Review regressions
tests/package/            setup privacy and installer checks
```

Fork the repository and make your changes on a branch. Keep the source-preservation checks, cancellation behavior, and bounded retries intact. Reports should include the extension versions, the stage that failed, and a redacted activity log; do not post prompts, credentials, or private chats unless you intend to share them publicly.

Licensed under [MIT](LICENSE). See [NOTICE.md](NOTICE.md) for integration attribution.
