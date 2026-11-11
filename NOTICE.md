# Attribution

Story Builder and Story Review are original extension code developed for this workflow. The two copies of the local prose-counting module (`StoryBuilder/story-counts.js` and `StoryReview/review-core.js`) share the same project code so each extension can analyze a draft independently.

This repository integrates with [SillyTavern](https://github.com/SillyTavern/SillyTavern), which is a separate project distributed under its own license. SillyTavern's application code and libraries are not included here. The browser modules import the host's existing APIs at runtime.

Optional zTracker and MemoryBooks integrations use separately installed extensions. Their source, configurations, presets, and licenses are not bundled. No writing preset, lorebook, user chat, or API credential is included in this repository.

Model names identify external services; their providers are not affiliated with this project. Forks should preserve this notice and the MIT license for the code in this repository.
