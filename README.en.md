# Faster Compress

**Prepare context summaries early. Keep long tasks moving.**

[中文](README.md) · English

![Node.js 22.19+](https://img.shields.io/badge/Node.js-%E2%89%A522.19-356D50?style=flat-square)
![DSH 0.2.0-rc.2](https://img.shields.io/badge/DSH-tested_on_0.2.0--rc.2-0A7A78?style=flat-square)
![MIT](https://img.shields.io/badge/license-MIT-526B7A?style=flat-square)

![Stock compaction waits for a summary. Faster Compress prepares it in the background and commits at a step boundary.](https://raw.githubusercontent.com/GallenShao/dsh-faster-compress/v0.2.2/assets/overview-en.svg)

Long conversations in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) need context compaction. The stock backend writes a summary before the next step can begin. **Faster Compress starts that work earlier, in the background**: start at the preparation threshold, let the task continue within safe headroom, and apply a ready summary before the next model request. Separate warm-up is off by default.

## Install with one package name

Open **Plugins → Add plugin** from the DSH sidebar and enter:

```text
dsh-faster-compress
```

Install, then restart DSH. **The defaults are ready to use. No new API key or YAML editing.**

Verified with **DSH 0.2.0-rc.2**; requires **Node.js ≥ 22.19**. It uses the conversation's model and existing credentials. Summary and warm-up requests remain subject to your provider's billing.

<details>
<summary>Using the command line?</summary>

```sh
dsh plugin --profile web add dsh-faster-compress
```

Then restart `dsh web`. For the desktop app, use its Add plugin screen.

</details>

## What changes?

| When… | Faster Compress… |
| --- | --- |
| Pressure reaches the preparation threshold | Starts background preparation while the task continues within safe headroom |
| The summary is ready | Applies at the next safe step boundary, preserving newly appended messages |
| Preparation is unfinished at the safety limit | Waits before the next main request, or uses stock compaction if no preparation is available |
| The next real request | Processes the new context directly, without waiting for a warm-up request |
| Preparation fails or the selected content changes | Discards the result and falls back to stock synchronous compaction |

The plugin replaces the stock compaction backend while retaining its summarization instruction and commit event format. `/compact`, tool-result pruning, and image offload remain available.

## See every compaction

Open **Compaction History** at the top of a conversation. Select a record on the left; inspect its outcome, timeline, and content on the right. Developer mode is not required.

- **Clear outcomes:** preparing, ready, waiting at the safety limit, applied, superseded, failed, or discarded with a reason. Application status follows actual replacements in the session log.
- **Traceable content:** switch between the summary, original text excerpt, and diagnostics; search, filter, and copy. Inspect the model, source range, token estimates, and available usage data.
- **Measured stages:** background generation, safety-limit wait, commit, and warm-up durations. Generation and waiting can overlap; these values do not measure time saved.
- **Response recovery:** inspect compaction blocking to first output, replacement to first output, and the TTFT of the request that produced it. First reasoning, text, and tool deltas have separate times relative to application, with failures, retries, and cancellation recorded independently.
- **Useful failures:** inspect summary and warm-up errors, stale selections, and reload invalidation. A failed warm-up does not prevent a usable summary from being committed.

The view updates automatically, supports Chinese and English, and follows the DSH theme. It shows the most recent 80 records per conversation. Native historical compactions remain visible, with `—` for preparation timings that were never recorded.

“Applied” follows actual session replacements. Request inclusion is verified separately against the checkpoint message ID and compaction ID in the DSH main request. Summary and warm-up calls are excluded. This verifies the DSH call boundary, not provider receipt or a cache hit.

Same-model summaries (including manual compaction, overflow recovery, and inline fallback) and warm-up inherit the conversation's `reasoningEffort`, preventing provider defaults from changing the chat-template prefix. A separately configured summary model retains its own defaults. Warm-up records a logical prefix fingerprint: route, reasoning, system, or tool changes invalidate it without discarding a usable summary or repeatedly warming again. Appended messages can reuse the earlier prefix but still require prefill for the new tail. Fingerprints cannot observe provider-side template changes or cache eviction.

Compaction History shows provider-reported cache-read tokens for summaries, warm-up, and subsequent request attempts, plus reasoning settings. Missing cache counts remain `—`. Warm-up completion, logical prefix matching, and actual cache hits are separate observations; TTFT is not a measurement of prefill alone.

Response durations use the host's monotonic clock. They include subsequent processing, model queuing, and request-chain waiting, but exclude browser delivery and rendering. First output follows DSH's first non-empty text, reasoning, or tool delta definition; per-kind times ignore whitespace-only text. Observation covers the first main request after application and its failed retries, then stops when that request completes. Later tool-loop requests are not accumulated; tool-only responses leave text timing as `—`. TTFT belongs to the attempt that actually produced the first output, while total waiting includes prior failures and retries. Each record keeps the latest eight attempts. Manual `/compact` can leave an idle interval before the next user input, so post-application timing can include that interval but compaction-blocking time stays unset. Restart or unload interrupts unfinished observations; historical first-token times are never inferred from completion timestamps.

The primary metric uses model-reported usage to compare input tokens (including cached tokens) for the last main response before replacement and the first response afterward. New messages, tool results, and configuration changes may affect the difference, so it is not exact compaction savings. Summary request input, output, and cache reads are shown separately; output may include reasoning and is not the stored summary size. Character estimates for the replaced span and checkpoint remain supplementary. Pending and missing usage stay explicit, never replaced with estimates. Existing history can recover these counts from native session events.

Diagnostics live separately in `$DSH_HOME/data/faster-compress/traces/` (default `~/.dsh/data/faster-compress/traces/`), without adding session events. Each conversation retains up to 80 background records, with original excerpts capped at 12,000 characters and summaries at 24,000; truncation is indicated. Only text is retained, without attachments. Common credential patterns are masked in errors; original excerpts and summaries preserve conversation content. Storage failure does not block compaction and is reported in the view.

Hiding the history tab keeps diagnostic collection enabled. To remove these local copies, stop DSH and delete that directory. Committed summaries in native session logs remain managed by DSH.

**What if an update loses the prepared summary?** Preparation is held in memory. Diagnostic files never reapply old summaries after restart. Missing results are prepared again within the safe budget; at the safety limit, they fall back to stock synchronous compaction. Failed summaries and stale selections fall back at the preparation threshold, as does reload cancellation of preparation during a live turn. Explicitly cancelled turns stay cancelled. Integration replaces the native backend inside its preset. Failed installation rolls back to native; disable/unload restores native. Hot loading leaves existing agents untouched: restart DSH after active work finishes.

## Configure it in Settings

Open **Plugins → Installed → Faster Compress** from the sidebar. Its settings appear directly on the package detail page. Save changes to apply them to subsequent preparation and warm-up requests without a restart.

| Setting | Default | When to change it |
| --- | --- | --- |
| Start preparation at | **100%** | Uses the preparation threshold; lower it if preparation often reaches the safety limit |
| Warm the new context | **Off** | Try enabling with long-running tools, spare model capacity, and a reusable prefix cache |
| Show Compaction History tab | **On** | Saving immediately shows or hides the conversation tab; diagnostics remain recorded |
| More options → Concurrent background summaries | **1** | Increase for multiple sessions only when the model provider has spare capacity |
| More options → Warm-up output limit | **1 token** | Usually leave unchanged; accepts 1–8 |
| More options → Output reservation floor | **0 (automatic)** | Set the actual output cap if metadata omits it, e.g. 32768 tokens; otherwise native compaction is used |
| More options → Input safety margin | **4096 tokens** | Estimation margin before the input limit |

Restoring defaults is staged until you save. Lowering concurrency does not interrupt requests already running. Upgrades preserve explicitly saved settings. To adopt the new defaults, set preparation to **100%** and warm-up to **Off**, or restore defaults and save.

## Where it helps—and its limits

Best suited to long coding sessions, frequent tool use, and tasks that regularly pause for compaction. Short chats or saturated model servers may benefit little.

- **Less waiting, not a zero-wait guarantee.** An unfinished summary still blocks at the safety limit. Stopping the turn immediately interrupts that wait. New summaries and appended tail messages still need prefill, normally performed by the next real request, so first output can still take time.
- **Warm-up is not free acceleration.** Output is usually just one token, but a long prompt can require substantial prefill and compete with the main request. Benefits depend on prefix identity and provider cache retention. `maxConcurrent` only limits background summaries; it does not prevent overlap with main requests. Disable warm-up if it does not help.
- **Some preparation is discarded.** Cancellation, changes to the selected span, or a summary that fails to shrink it can invalidate preparation. Normal turn completion preserves it for reuse when the conversation resumes.
- **Matching prefixes do not guarantee cache hits.** Hybrid models with recurrent state also need a retained checkpoint. Removing competing pruning cannot guarantee a restorable state at the summary cutoff; deployment-side verification remains necessary.
- **No real-endpoint performance benchmark yet.** The diagram describes the flow, not a measured speedup.

<details>
<summary>Implementation details and advanced configuration</summary>

- Preparation writes no session events. A commit appends `compaction/start`, `compaction/summary`, the replacement message, and `compaction/end`.
- Input limit `I = contextWindow − reservedCompletion`; wait limit `W = floor(I − safetyMarginTokens)`; preparation base `T = floor(min(contextWindow × thresholdRatio, I − ceil(headroomTokens / 2), W))`. Preparation starts at `floor(T × eagerRatio)`. With a 262,144 window, 32,768 output reservation, 65,536 headroom and 4,096 safety margin: input limit **229,376**, preparation **196,608**, waiting **225,280**. 196K is a preparation point, not the input capacity.
- Reservation is the larger of the request/adapter declaration and `outputReserveTokens`. Without either, use native compaction instead of treating an unknown reservation as zero. This setting does not change generation parameters. A global reservation floor may be overly conservative for smaller models.
- The host owns settings, diagnostics and shared concurrency. The engine replaces the native backend in the original standard/ptc/cordis isolated group, so automatic steps, manual commands and overflow resolve the same service. Preset policies, pruners and other plugins remain in place. No copied preset lists or DSH distribution edits. Minimal, auto-disabled and third-party backends are left alone.
- Normal background preparation never prunes old tool results. Selected-span changes cancel stale work immediately. Failure, tight budgets and overflow cancel conflicting work before native pruning, remeasurement and synchronous summaries. Native pruning is lossy and may invalidate the cached prefix; originals remain in the session log.
- History diagnostics include input limit, output reservation and both thresholds; the page indicates inactive integration or missing output metadata.
- Headroom allows progress but cannot guarantee the summary will finish in time. Failures, noncompactable selections, and overflow retain stock handling; token estimates may differ from provider counts. When concurrency slots are occupied, preparation is deferred only within the safe budget; at the limit, synchronous fallback remains available.
- Normal turn completion preserves existing preparation: running summaries may finish, and ready results are revalidated and applied at a safe step when the conversation resumes. Idle sessions are never rewritten. Cancellation, abnormal completion, selected-span replacement, session disposal, and plugin unload still cancel preparation. Each engine retains preparations for at most 24 idle sessions, releasing the oldest when full. Unapplied results are not restored across process restarts.
- History uses DSH's authenticated host access boundary, without additional per-user ownership isolation. `observeSession` resolves and validates a session; it does not authorize a user. Excerpts are also stored in local diagnostic files; hiding the tab does not delete them. When cleaning up sensitive sessions, also remove their diagnostic files from the directory described above.
- Completion callbacks never rewrite an active request's context. Application occurs at the next safe step; even optional warm-up does not delay it, and unfinished warm-up is cancelled on application.
- Total pressure is checked again after a commit. The prepared commit counts as the first attempt; additional compactions obey the stock `compactionRetries` limit.
- Warm-up sends checkpoint text before it is persisted. Disable warm-up if every model-visible byte must already be in the session log.
- Pressure estimates can undercount CJK text. Lower the preparation percentage if preparation starts too late.
- Stock advanced fields remain configurable on the `faster-compress` row, including `thresholdRatio`, `headroomTokens`, `retainTokens`, and `modelPolicies`. Ordinary use needs none of these edits.
- The added fields are `eagerRatio` (greater than 0 and at most 1), `warmup`, `maxConcurrent`, `warmupMaxTokens`, `traceTab`, `outputReserveTokens`, and `safetyMarginTokens`. The UI's 100% means `eagerRatio: 1`.

</details>

## Development and validation

```sh
npm install
npm run build
npm test
npm run check
npm pack
```

The published package includes its browser settings module and both SVG diagrams. Installation requires no build. The server runs JavaScript directly; the browser page uses DSH's native form, save, and reset interactions.

Regression tests cover budgets and selection, cancellation, pressure retries, warm-up and failure fallback, real DSH Session commits and replay, and settings validation and live reads. Model I/O is stubbed; these checks do not replace real-endpoint performance measurements.

Compaction History regressions cover persistence and recovery, session isolation, retention limits, unavailable storage, application-state projection, and RPC lifecycles. See [test instructions](https://github.com/GallenShao/dsh-faster-compress/blob/main/tests/README.md) for isolated browser checks that leave the everyday DSH profile untouched.

[Changelog](CHANGELOG.md) · [Release records](https://github.com/GallenShao/dsh-faster-compress/blob/main/RELEASES.md) · [Source](https://github.com/GallenShao/dsh-faster-compress) · [MIT License](LICENSE)
