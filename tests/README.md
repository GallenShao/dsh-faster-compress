# 回归与浏览器联调 / Regression and browser checks

## 自动回归 / Automated checks

```sh
npm run build
npm test
npm run check
git diff --check
```

模型调用均使用桩；Session 提交、原生事件回放、配置 schema 和 RPC 描述符使用当前安装的 DSH 包。测试不会读取日常会话或调用付费模型。

Model calls are stubbed. Session commits, event replay, config schemas, and RPC descriptors use installed DSH packages. Tests do not access everyday conversations or invoke paid models.

调度回归使用真实 DSH `agent/pre-step` 回调、Session 和原生回退：验证默认在准备阈值启动、完成回调不改上下文、就绪即在下一安全边界提交、保留新增尾部、默认无预热、可选预热不延迟应用、输出预留变化后的等待线、并发占满和失败回退。历史自定义提前比例与开启预热的配置仍单独覆盖。

Scheduling regressions exercise the real stock pre-step hook, Session, and fallback: budget-aware preparation launch, no callback-time mutation, ready application at the next boundary, tail preservation, no default warm-up, nonblocking optional warm-up, changed output reservations, concurrency saturation, and failure fallback. Existing custom preparation ratios and opt-in warming remain covered separately.

生命周期回归覆盖正常回合结束后的摘要保留与复用、取消和销毁、迟到的异步查询、模型容量缓存失效，以及空闲会话的保留上限。

Lifecycle regressions cover preparation retention and reuse across normal turn completion, cancellation and disposal, late asynchronous lookups, model-capacity cache invalidation, and idle-session retention limits.

## 隔离浏览器联调 / Isolated browser check

1. 创建独立临时目录作为 `DSH_HOME`，用 DSH CLI 在其中初始化 Web profile，并安装或链接当前源码包。不要指向日常 `~/.dsh`。兼容回归覆盖 DSH `0.2.0-rc.2` 和 `0.2.1-rc.2`。
2. 在这个临时 profile 的 `cordis.patch.yml` 追加下面的测试插件，将路径换成当前 checkout 的绝对路径。
3. 使用 `DSH_HOME=<临时目录> DSH_TRACE_FIXTURE=1 dsh web --port 3098` 启动，通过启动时提供的认证 URL 打开浏览器。不需要配置模型。
4. 展开“未分组”，打开标题带“联调样例（测试数据）”的会话，选择“压缩历史”。

```yaml
- insert:
    - id: trace-fixture
      name: 'file:///absolute/path/to/dsh-faster-compress/tests/fixtures/trace-host.mjs'
```

Create an isolated temporary `DSH_HOME`, initialize its Web profile with DSH CLI, and install/link this checkout. Add the fixture above to that profile's patch, replacing the absolute path. Launch with `DSH_TRACE_FIXTURE=1`; open the authenticated URL printed by DSH. Expand the ungrouped workspace and select the clearly marked sample conversation. No model configuration is required.

样例通过真实 Session 提交制造“已应用、已被替换”两条记录，并补充待应用、失败、丢弃三条诊断。耗时、token 数及内容均为测试数据，不代表性能结果。每次启动生成独立会话；测试插件不包含在 npm 发布包中。

The fixture uses real Session commits for applied/superseded checkpoints, plus three diagnostic examples (ready, failed, discarded). Timings, tokens, and content are synthetic, not benchmark results. Each launch creates a separate session. Fixtures are excluded from the npm package.

检查 / Verify:

- 5 条记录、1 个当前检查点；“曾应用”含已被替换记录。
- 已应用记录显示主请求核验及恢复输出、应用后首输出、TTFT；示例通过真实 `llm/stream` 中间层读取模拟思考和正文增量，不发网络请求。
- 摘要、原文、诊断切换，筛选、搜索、复制及键盘左右键切换内容标签。
- 保存 `traceTab: false` 后标签立即隐藏；重新启用后恢复。
- 浅色、深色、窄屏布局无横向页面溢出；滚动到底仍能查看内容。
- 打开另一空会话，不出现前一会话的记录。
- 服务不可达时显示读取失败与重试，不把失败当作空历史。

Verify five records and one current checkpoint; filters, search, content tabs, copy, and keyboard navigation; immediate hide/show after saving the setting; light/dark and narrow layouts; empty-session isolation; and a retry state when the service is unavailable.

The applied example also exercises the real `llm/stream` middleware with locally generated reasoning/text deltas. Verify checkpoint inclusion, recovery latency, post-application latency, and TTFT; no provider is contacted. `response.test.mjs` separately verifies timing arithmetic, retries, cancellation, empty output, source identity, session isolation, manual compaction, restart, and stream pass-through.

推理参数回归直接调用上游摘要实现并截获模型请求，覆盖后台、手动、overflow、回退、跨模型及并发会话；预热前缀变化和流式错误不影响摘要提交。响应测试区分逻辑前缀匹配与实际缓存计数，缺失计数保持未知。这些回归不构成真实模型端点的性能基准。

Reasoning regressions run the stock summarizer with captured model I/O across background, manual, overflow, fallback, cross-model, and concurrent-session paths. Warm-up invalidation and streamed errors preserve usable summaries. Response tests separate logical prefix identity from reported cache usage and preserve unknown values. These regressions are not a live-endpoint performance benchmark.

结束后停止测试 DSH、移除测试 patch 或删除临时 profile；不要保留测试插件在日常 profile 中。

Stop the test host and remove its fixture patch or temporary profile when done.

Preset integration regressions load the installed standard/ptc/cordis compaction groups through the real Cordis Loader and Preset Registry, dispatch AgentRegistry creation and scoped pre-step events, verify command resolution, and check rollback, unload restoration, minimal/custom/disabled policies and hot-load deferral. The surrounding Agent loop/model and command transport are test fixtures, not a live inference benchmark.

接入回归加载实际安装的 Web preset 压缩组，使用真实 Loader、Preset Registry、AgentRegistry 创建事件和作用域步骤事件；验证手动命令解析、回滚、卸载恢复及 minimal/自定义/禁用策略。外围模型循环与命令传输为测试桩，不调用模型服务。

用量回归覆盖缓存读取与写入计数、原生历史恢复、替换前最近一次和替换后首次主请求、缺失 usage、检查点被替换及经核验的实时 usage；摘要输出不混入上下文输入，估算不补齐实测。

Usage regressions cover cache reads/writes, native historical reconstruction, adjacent main-request measurements, missing usage, superseded checkpoints, and verified live usage. Summary output is not counted as context input, and estimates never fill gaps in measured usage.
