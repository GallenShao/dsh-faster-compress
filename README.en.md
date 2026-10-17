# Faster Compress

**Prepare context summaries early. Keep long tasks moving.**

[中文](README.md) · English

![Node.js 22.19+](https://img.shields.io/badge/Node.js-%E2%89%A522.19-356D50?style=flat-square)
![DSH 0.2.0-rc.2](https://img.shields.io/badge/DSH-tested_on_0.2.0--rc.2-0A7A78?style=flat-square)
![MIT](https://img.shields.io/badge/license-MIT-526B7A?style=flat-square)

![Stock compaction waits for a summary. Faster Compress prepares it in the background and commits at a step boundary.](https://cdn.jsdelivr.net/npm/dsh-faster-compress@0.1.0/assets/overview-en.svg)

Long conversations in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) need context compaction. The stock backend writes a summary before the next step can begin. **Faster Compress starts that work earlier, in the background**: prepare while tools run and the task moves forward, then replace history when pressure reaches the compaction threshold.

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
| A long task approaches the context limit | Starts preparation at **85%** of the compaction threshold by default |
| A tool is running | Uses the window to prepare a summary or try to warm the new prefix |
| The summary is ready before the threshold | Keeps the original history, delaying prefix-cache invalidation |
| Pressure reaches the threshold | Commits at a step boundary and preserves messages appended during preparation |
| Preparation fails or the selected content changes | Discards the result and falls back to stock synchronous compaction |

The plugin replaces the stock compaction backend while retaining its summarization instruction and commit event format. `/compact`, tool-result pruning, and image offload remain available.

## Configure it in Settings

Open **Plugins → Faster Compress** from the sidebar to reach its settings page. Save changes to apply them to subsequent preparation and warm-up requests without a restart.

| Setting | Default | When to change it |
| --- | --- | --- |
| Start preparation at | **85%** | Lower it if summaries often miss the compaction deadline |
| Warm the new context | **On** | Turn off when your provider does not reuse prefix caches or the extra request is not worthwhile |
| More options → Concurrent background summaries | **1** | Increase for multiple sessions only when the model provider has spare capacity |
| More options → Warm-up output limit | **1 token** | Usually leave unchanged; accepts 1–8 |

Restoring defaults is staged until you save. Lowering concurrency does not interrupt requests already running.

## Where it helps—and its limits

Best suited to long coding sessions, frequent tool use, and tasks that regularly pause for compaction. Short chats or saturated model servers may benefit little.

- **Less waiting, not a zero-wait guarantee.** An unfinished summary still blocks at the threshold. Stopping the turn immediately interrupts that wait.
- **Warm-up is not free acceleration.** It adds a tiny request. Benefits depend on the provider's cache reuse and eviction; disable it if it does not help.
- **Some preparation is discarded.** A turn may end, the selected span may change, or the summary may fail to shrink it.
- **No real-endpoint performance benchmark yet.** The diagram describes the flow, not a measured speedup.

<details>
<summary>Implementation details and advanced configuration</summary>

- Preparation writes no session events. A commit appends `compaction/start`, `compaction/summary`, the replacement message, and `compaction/end`.
- Total pressure is checked again after a commit. The prepared commit counts as the first attempt; additional compactions obey the stock `compactionRetries` limit.
- Warm-up sends checkpoint text before it is persisted. Disable warm-up if every model-visible byte must already be in the session log.
- Pressure estimates can undercount CJK text. Lower the preparation percentage if preparation starts too late.
- Stock advanced fields remain configurable on the `faster-compress` row, including `thresholdRatio`, `headroomTokens`, `retainTokens`, and `modelPolicies`. Ordinary use needs none of these edits.
- The added fields are `eagerRatio` (strictly between 0 and 1), `warmup`, `maxConcurrent`, and `warmupMaxTokens`. The UI's 85% means `eagerRatio: 0.85`.

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

[Changelog](CHANGELOG.md) · [MIT License](LICENSE)
