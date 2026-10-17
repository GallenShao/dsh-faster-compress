# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.2.1 — 2026-10-17

### Changed

- Show model-reported main-request input before and after context replacement as
  the primary history metric, including cache reads/writes. Explain that new
  messages and tool results make this observed change, not exact token savings.
- Show summary request input, output, and cache reads separately. Output may
  include reasoning and is not the stored checkpoint size. Move the estimated
  replaced-span/checkpoint comparison into supplementary information.
- Recover measurements for existing history from native session events; show
  pending or unavailable usage explicitly rather than substituting estimates.
  Preserve compression selection, scheduling, and standard request behavior.

## 0.2.0 — 2026-10-17

Upgrades preserve saved settings. To adopt the new defaults, set preparation
to 100% and warm-up to Off, then restart DSH after active work finishes.

### Changed

- Replace the actual stock backend inside each Web preset's isolated compaction
  group; share settings, history and concurrency at the host. Preserve native
  policies, commands and pruners, roll back failed integration, restore on unload,
  and leave already-live revisions untouched during hot installation.
- Keep old tool results intact during normal preparation. Cancel stale summaries
  on selected-span replacement; cancel conflicting work before native fallback.
- Add output reservation floor and input safety margin settings. Unknown output
  metadata uses native compaction. A 262144/32768 window/output configuration
  starts at 196608 and waits at 225280 with default headroom and safety margin.
- Show inactive integration and unknown output budgets in Compaction History.

- Start background preparation at a budget-aware preparation threshold by default (`eagerRatio: 1`),
  then apply a ready summary at the next safe step without waiting for pressure.
- Disable separate warm-up by default; retain it as an opt-in that never delays
  application. Explicitly saved settings are preserved on upgrade.
- Allow progress during preparation until a safety limit that preserves the
  full output reservation and a separate configurable safety margin. Wait cancellably there,
  with stock fallback for missing, failed, or stale preparation and busy slots.
- Update bilingual settings, history explanations, README diagrams, and budget
  diagnostics to distinguish preparation from safety-limit waiting.

### Added

- Reasoning settings, provider cache-read usage, and logical warm-up prefix
  verification in Compaction History, with unknown cache counts kept unknown.
- Host-observed recovery latency after compaction: blocking-to-first-output,
  apply-to-first-output, and output-producing main-request TTFT, with separate
  reasoning, text, and tool delta timings and bounded retry diagnostics.
- Verify checkpoint inclusion at DSH's marked main-request boundary; exclude
  summary/warm-up calls and preserve unknown timings across restart or cancellation.
- Per-conversation Compaction History view with live history, application state,
  summaries and original excerpts, stage timings, usage, and error diagnostics.
- Live `traceTab` setting, bilingual copy, theme-aware responsive layout,
  filters, search, copy, and keyboard-accessible content tabs.
- Bounded local diagnostic journals and native compaction history recovery
  through DSH's authenticated gateway; no extra session event types.
- Regression coverage for journal recovery, state projection, storage failures,
  reload fallback, and client registration, plus an isolated browser fixture.

### Fixed

- Keep the history service mounted after dependency injection: returning its
  child Fiber was an invalid Cordis plugin effect and withdrew the strict RPC
  definition. Cover startup, preset replacement, strict gateway reads, host
  unload/reload and invalid-input rejection with the real Typert registry.
- Inherit conversation reasoning effort in same-model summaries and warm-up,
  including manual compaction, overflow recovery, and inline fallback. Preserve
  stock summary prompts and independently routed models' defaults.
- Invalidate warm-up when its route, reasoning effort, or logical prefix changes;
  preserve usable summaries and report streamed warm-up errors as failures.
- Render settings on the installed package's detail page instead of creating
  a separate card among official plugin settings.
- Improve settings spacing, readable form width, and toggle label hierarchy.
- Fall back to stock compaction when plugin unload cancels preparation during
  a live turn, while preserving explicit turn cancellation.
- Discard late summary results from providers that ignore cancellation.

## 0.1.0

### Fixed

- Separate eager settings from the stock backend's strict configuration so
  explicit settings load successfully.
- Make pending-summary waits cancellable and cancel abandoned background work.
- Recheck pressure after a prepared commit and honor the remaining compaction
  retries before returning success.
- Consume the asynchronous warm-up stream and respect `warmup: false`.
- Let a model-specific retention ratio replace a global absolute retention budget.

### Added

- A native DSH plugin settings page in Chinese and English, with live settings,
  validation, staged saves, and restore-default actions.
- Chinese-first README, a maintained English edition, and bilingual SVG diagrams.
- Ready-to-install browser assets in the npm package; no consumer build required.
- Engine regression tests using real DSH sessions for commits and replay, with
  stubbed model I/O for cancellation, warm-up, pressure retries, and fallbacks.

### Initial features

- Background summary generation started at an eager pressure threshold
  (`eagerRatio`, default 0.85) or when a tool call opens a quiescent window.
- Commitment of the prepared replacement at the step boundary where the
  session surface is quiescent, so no in-flight request is left behind a
  rewritten prefix.
- Optional prefix-cache warm-up of the post-commit request prefix while a tool
  runs (`warmup`, `warmupMaxTokens`).
- Global cap on concurrent background summaries (`maxConcurrent`).
- Drop-and-fall-back handling when a prepared summary goes stale, fails, or
  does not shrink its span enough; the shipped inline path still runs.
- Unit tests for threshold arithmetic and span selection, on Node's built-in
  test runner, covering the case where an unanswered tool call must stay
  outside the shadowed span.

### Known limitations

- The prefill that replacing history inherently costs is moved off the waiting
  path by warm-up, not removed.
- A warm-up request sends checkpoint framing that is only logged if the commit
  happens.
- Verified against `@deepseek-ai/dsh@0.2.0-rc.2`.
