# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

Initial release.

### Added

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
