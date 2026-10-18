# Faster Compress

**Prepare context summaries early. Keep long tasks moving.**

[中文](README.md) · English

![Node.js 22.19+](https://img.shields.io/badge/Node.js-%E2%89%A522.19-356D50?style=flat-square)
![DSH 0.2.0-rc.2](https://img.shields.io/badge/DSH-tested_on_0.2.0--rc.2-0A7A78?style=flat-square)
![MIT](https://img.shields.io/badge/license-MIT-526B7A?style=flat-square)

![Stock compaction waits for a summary. Faster Compress prepares it in the background and commits at a step boundary.](https://raw.githubusercontent.com/GallenShao/dsh-faster-compress/v0.2.2/assets/overview-en.svg)

**Background context compaction** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Reduce pauses for summaries during long tasks, and inspect results, timings, and token usage in Compaction History.

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

- **Prepare while work continues.** Background summaries start at the preparation threshold; the main task continues within safe headroom.
- **Apply when ready.** A ready summary is applied before the next model request, preserving messages added during preparation. Normal turn completion retains it for reuse on the next turn.
- **Keep the native fallback.** If preparation fails or becomes invalid, stock compaction remains available. `/compact` still works.

## Compaction History

Open **Compaction History** at the top of a conversation to inspect:

- Summaries, original text excerpts, application status, and failure reasons.
- Preparation time, compaction waiting, and first-output latency after application.
- Model-reported input tokens before and after compaction, plus summary and cache usage.

Search, filter, and copy records in a view that follows the DSH theme.

## Settings

Open **Plugins → Installed → Faster Compress**. Changes apply after saving, without a restart.

| Setting | Default | Purpose |
| --- | --- | --- |
| Start preparation at | **100%** | Lower if preparation often finishes too late; this is relative to the preparation threshold, not the context window |
| Warm the new context | **Off** | Optional extra request; useful only when the provider has spare capacity and can reuse its cache |
| Show Compaction History tab | **On** | Show or hide the conversation tab |

The defaults suit most use. Advanced options include output reservation, safety margin, and concurrency. Upgrades preserve saved settings.

## Before you use it

- Best suited to long conversations and frequent tool use. Background summaries consume model capacity and incur normal provider charges; some waiting may remain.
- Unapplied summaries stay in memory. After restart, the plugin prepares again or falls back to stock compaction.
- History stores summaries and original excerpts in `$DSH_HOME/data/faster-compress/traces/`. Hiding the tab does not stop recording. To remove these copies, stop DSH and delete that directory.

[Development and tests](https://github.com/GallenShao/dsh-faster-compress/blob/main/tests/README.md) · [Changelog](CHANGELOG.md) · [Release records](https://github.com/GallenShao/dsh-faster-compress/blob/main/RELEASES.md) · [Source](https://github.com/GallenShao/dsh-faster-compress) · [MIT License](LICENSE)
