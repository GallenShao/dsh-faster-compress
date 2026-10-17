# dsh-faster-compress

Context compaction that does not interrupt the agent.

[中文说明](README.zh.md)

## The problem

The compaction backend shipped with [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) generates a summary inside the `agent/pre-step` hook and awaits it. The next model request cannot start until the summary has been written, so a long conversation stalls at exactly the moment it has grown too large: the agent is idle, you cannot steer it, and the only thing happening is a summary being generated.

## What changes

The summary is generated while the turn keeps running, and the replacement is committed at a step boundary.

```
before   ── request ── tool ── [====== summary ======] ── request
                                     ↑ the agent waits here

after    ── request ── tool ── request ── request ── …
                     └─ [summary generated] ─┐
                                             └─ commit at the next step boundary
```

Three decisions make this work, and each one exists for a reason:

**Generate early, commit on schedule.** A committed compaction replaces the conversation prefix, which invalidates the provider's cached prefix for every later request. Committing as soon as a summary exists would trade a cached prefix for a full-price prefill earlier than necessary. So the summary is prepared once pressure passes an eager threshold (85% of the commit threshold by default), but the replacement only lands when pressure actually reaches the threshold the shipped backend would have used.

**Commit at a step boundary.** The surface is quiescent there: the previous step has closed and the next request has not been derived. Committing mid-request would leave an in-flight request behind a rewritten prefix.

**Reuse the shipped transaction.** A commit appends the same four events the stock backend does — the opening bracket that is also the compaction lock, the summary record with its shadow price, the surface replacement, and the closing bracket. Replay, pricing, the compaction invariant, and crash recovery therefore behave exactly as they do without this bundle. Nothing is written to the session log while a summary is merely being prepared, so an abandoned summary leaves no trace and the compaction lock is never held across a background wait.

Two supporting details:

- **The tool window is the preferred trigger.** A tool call is the best moment to start: the surface is quiescent until the result lands, the model is not decoding, and tools usually run long enough for the summary to finish before the next step boundary. The pressure threshold remains as a fallback for conversations with few long tools.
- **Warm-up, optional.** The first request after a commit sends a rewritten prefix that matches no cached entry, so it pays for a full prefill of the summary plus the retained tail. With `warmup: true`, that same prefix is sent with a minimal token cap while a tool runs, moving the prefill to a moment nobody is waiting on. The work is not additional, only earlier.

Because the replacement only shadows the selected span, messages that arrive while a summary is being generated stay visible and do not invalidate it. The committed history is the summary followed by everything that came after the shadowed span, which is how the shipped backend already projects a compaction.

## Install

Through the plugin manager: **Plugins → Install bundle**, with the specifier `github:<your-fork>/dsh-faster-compress`, a registry name, or the path to a packed tarball (`npm pack` in this directory produces one).

Install from a tarball, a registry, or GitHub rather than from a checked-out directory. A local-directory install links the package outside the profile dependency tree, and the `@deepseek-ai/*` peer packages are not resolvable from there; in testing the row loaded as `failed to import`. Copy-based installs place the package inside the tree with its peers linked.

If a bundle fails to load once, the running process keeps that outcome: reinstalling the same package name reports `failed to import` again without ever reaching the module, no matter what you change in the meantime. Restart the harness to retry a load.

The bundle disables the stock `compaction-basic` row and mounts a subclass of it in its place. Because that subclass registers itself as the `compaction` service, `/compact`, the tool-result pruner, and image offload keep working with no further changes.

## Configuration

All fields are optional. The stock backend's fields are accepted and behave as documented upstream; the four added fields are:

| Field | Default | Meaning |
| --- | --- | --- |
| `eagerRatio` | `0.85` | Fraction of the commit threshold at which a summary is generated ahead of time. Must be between 0 and 1. |
| `warmup` | `true` | Warm the rewritten request prefix while a tool runs, so committing costs no cold prefill. |
| `warmupMaxTokens` | `1` | Generation cap of the warm-up request. |
| `maxConcurrent` | `1` | Summaries generated concurrently across all sessions of this host. |

```yaml
- id: compaction-basic
  disabled: true

- insert:
    - id: faster-compress
      name: 'dsh-faster-compress'
      config:
        eagerRatio: 0.8
        maxConcurrent: 2
        # inherited fields still work
        thresholdRatio: 0.8
        headroomTokens: 32768
```

Set `warmup: false` when the inference endpoint evicts prefix caches faster than the gap between warm-up and commit, where warm-up would be pure overhead. Set `maxConcurrent` above 1 only when the endpoint has spare capacity; on a shared local model, keeping it at 1 avoids competing with the turn you are trying to keep fast.

## What it does not do

- **It does not remove the prefill that a compaction inherently costs.** Replacing history with a summary changes the request prefix, and the first request on that prefix must be prefilled. Warm-up moves that cost off the path you wait on; it does not delete it.
- **It does not change summary quality.** The summarization directive, the checkpoint framing, and the retention budget are the shipped backend's.
- **It does not compact below the eager threshold.** `/compact` still does what it did before.

## Known trade-offs

- **A warm-up request sends model-visible text that may never be logged.** The warm-up prefix contains the checkpoint text, which is only written to the session log if the commit actually happens. If the prepared summary is discarded instead, that request's content is reconstructable from the log except for the checkpoint framing itself. Set `warmup: false` if you need every model-visible byte to be durable at the moment it is sent.
- **A prepared summary can go stale.** If the selected span is rewritten while the summary is being generated — usually by the tool-result pruner repricing it — the summary is dropped and the compaction falls back to the inline path. You pay for one wasted summary in that case.
- **`eagerRatio` needs headroom above the measurement error.** Pressure is measured from a provider usage anchor plus a character-density estimate for everything appended since it. That estimate divides by four, which undercounts CJK text substantially, so an eager threshold set very close to the commit threshold may start too late to matter.
- **Verified against `@deepseek-ai/dsh@0.2.0-rc.2`.** The bundle relies on the documented subclass hook `summarize()` and on the shape of the resolved configuration. A change to either is visible immediately as a load or commit failure, not as silent misbehaviour. `dsh.compatibility.dshReleases` in the manifest records that claim in machine-readable form; extend it when you verify a new release.

## Development

No build step: the bundle ships the JavaScript it runs. The peer packages are published on npm, so a plain install is enough to work on it.

```sh
npm install
npm test    # threshold arithmetic and span selection
npm run check
```

Layout:

| File | Responsibility |
| --- | --- |
| `src/index.js` | The engine: when to generate, when to commit, when to drop. |
| `src/budgets.js` | Threshold arithmetic, free of imports so it can be tested alone. |
| `src/selection.js` | Span selection and stability checks with tool-pairing balance. |
| `src/checkpoint.js` | Checkpoint framing and reconstruction of request prefixes. |
| `src/transaction.js` | The durable four-event commit. |

`src/budgets.js` and `src/selection.js` re-derive formulas that the upstream package does not export. They are kept in step with `packages/compaction/compaction-basic/src/{config,region}.ts` by comment, not by import, so that an internal refactor upstream cannot break this bundle silently. The tests cover both, including the case where an unanswered tool call sits at the end of the conversation and must stay out of the shadowed span.

## License

MIT — see [LICENSE](LICENSE).