# Faster Compress

**让上下文摘要提前准备，少打断一次正在推进的工作。**

中文 · [English](README.en.md)

![Node.js 22.19+](https://img.shields.io/badge/Node.js-%E2%89%A522.19-356D50?style=flat-square)
![DSH 0.2.0-rc.2](https://img.shields.io/badge/DSH-tested_on_0.2.0--rc.2-0A7A78?style=flat-square)
![MIT](https://img.shields.io/badge/license-MIT-526B7A?style=flat-square)

![原版需要停下来等摘要；Faster Compress 提前在后台生成摘要，到 step 边界再提交。](https://cdn.jsdelivr.net/npm/dsh-faster-compress@0.1.0/assets/overview-zh.svg)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的长对话需要压缩上下文。原版在下一步开始前生成摘要，你要等它写完。**Faster Compress 把这件事提前到后台**：趁工具执行、任务继续推进时准备摘要，等真正达到压缩阈值再替换历史。

## 安装，只填一个包名

打开 DSH 侧边栏的 **插件 → 添加插件**，输入：

```text
dsh-faster-compress
```

点击安装，完成后重新启动 DSH。**默认即用，无需 API Key，也不用编辑 YAML。**

已验证 **DSH 0.2.0-rc.2**，需要 **Node.js ≥ 22.19**。它沿用当前对话的模型和已有凭据；摘要、预热请求仍按模型服务的规则计费。

<details>
<summary>只用命令行？</summary>

```sh
dsh plugin --profile web add dsh-faster-compress
```

然后重新启动 `dsh web`。桌面端请使用应用内的“添加插件”。

</details>

## 装上后，改变了什么？

| 你遇到的情况 | Faster Compress 会做什么 |
| --- | --- |
| 长任务接近上下文上限 | 默认在压缩阈值的 **85%** 就开始准备摘要 |
| 工具正在运行 | 利用这个窗口准备摘要，或尝试预热压缩后的前缀 |
| 摘要已经好了，但还没到压缩阈值 | 继续保留原来的历史，延后前缀缓存失效 |
| 达到阈值，准备提交 | 在 step 边界替换历史，保留生成期间追加的消息 |
| 摘要失败或旧内容被改写 | 丢弃准备结果，回退到原版同步压缩 |

它替换内置压缩后端，继续使用原版的摘要指令和提交事件格式。`/compact`、工具结果裁剪和图片卸载仍可使用。

## 在设置页调整，不用找配置文件

进入侧边栏 **插件 → 更快压缩 · Faster Compress**，打开插件设置页。修改后点“保存”，后续准备与预热即采用新值，无需重启。

| 设置 | 默认值 | 什么时候需要调？ |
| --- | --- | --- |
| 提前准备时机 | **85%** | 摘要经常赶不上下一次压缩时，适当调低 |
| 预热新上下文 | **开启** | 服务不复用前缀缓存、额外请求不划算时关闭 |
| 更多选项 → 后台摘要并发数 | **1** | 多会话同时运行，且模型服务确实有余力时调高 |
| 更多选项 → 预热输出上限 | **1 token** | 通常无需修改，允许 1–8 |

“恢复全部默认值”也会先暂存，点击“保存”才生效。更改并发上限不会强行中断已经运行的请求。

## 适合谁？有什么边界？

适合长时间编码、频繁调用工具、经常遇到上下文压缩停顿的任务。短对话或模型服务已满载时，收益可能很小。

- **减少等待，不承诺零等待。** 若摘要尚未完成，达到阈值时仍需等它；停止回合可以立即打断等待。
- **预热不是免费加速。** 它增加一次极短请求，缓存收益取决于服务端的复用与驱逐策略。无效时可关闭。
- **后台摘要可能白做。** 回合结束、选中内容发生变化，或摘要没有缩小内容时，准备结果会被丢弃。
- **尚无真实端点的性能基准。** 图示说明流程，不代表固定提速比例。

<details>
<summary>实现细节与高级配置</summary>

- 提前生成阶段不写入会话日志；提交时追加 `compaction/start`、`compaction/summary`、替换消息和 `compaction/end`。
- 提交后重新检查总压力。预生成摘要的提交计作第一次尝试，剩余压缩次数受原版 `compactionRetries` 限制。
- 预热会发送尚未持久化的检查点文本。若要求所有发给模型的文本都已先落日志，请关闭预热。
- 压力估算对中日韩文本可能偏低。若准备启动太晚，可在设置页调低“提前准备时机”。
- 原版后端的高级字段仍可在 `faster-compress` 行配置，例如 `thresholdRatio`、`headroomTokens`、`retainTokens`、`modelPolicies`。普通使用不需要改动它们。
- 新增字段对应 `eagerRatio`（0–1 之间，不含端点）、`warmup`、`maxConcurrent`、`warmupMaxTokens`。设置页里的 85% 对应 `eagerRatio: 0.85`。

</details>

## 开发与验证

```sh
npm install
npm run build
npm test
npm run check
npm pack
```

发布包已包含浏览器设置页和中英文 SVG，用户安装时不需要构建。服务端直接运行 JavaScript；浏览器端复用 DSH 的原生表单、保存与恢复默认交互。

回归测试覆盖阈值与区间选择、摘要取消、预算重试、预热开关与失败回退、真实 DSH Session 提交和回放，以及设置的校验与实时读取。模型 I/O 使用测试桩，未替代真实端点的性能验证。

## 发布维护

每次版本变更和发布都须由项目所有者明确审批。先完成实现、文档和测试，再提交拟用版本、变更摘要及验证结果供审阅；批准后才修改版本号、建立发布标签并发布。每个 npm 版本对应确定的 Git 提交和 `v<版本号>` 标签，详见仓库中的 [发布记录与审批规则](https://github.com/GallenShao/dsh-faster-compress/blob/main/RELEASES.md)。

[更新记录](CHANGELOG.md) · [源代码](https://github.com/GallenShao/dsh-faster-compress) · [MIT License](LICENSE)
