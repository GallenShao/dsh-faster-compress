# 发布追溯

## 审批与记录规则

每次版本变更和发布都由项目所有者（当前用户）明确审批。先完成实现、文档及测试，提供拟用版本号、目标提交、变更摘要、测试结果与发布范围供审批；获批前不修改版本号、不创建发布标签、不发布 npm 或 GitHub Release。用户可以一次批准版本变更和发布，也可以分别批准，不能将一次授权沿用到后续版本。

发布必须能追溯到确定的 Git 提交、annotated tag 和 npm tarball 校验值。按 [AGENTS.md](AGENTS.md) 执行完整流程；未发布内容写入 `CHANGELOG.md` 的 `Unreleased`。既有标签保持不变，发布后补充记录使用单独的文档提交。

## 0.2.0 · 2026-10-17

- 审批：项目所有者明确批准版本 `0.2.0`、Git 推送及 npm 发布，并要求公开仓库和 Git 历史不包含本机排障资料。
- npm：[`dsh-faster-compress@0.2.0`](https://www.npmjs.com/package/dsh-faster-compress/v/0.2.0)
- Git 提交：[`41e22ece70256a7a6d8c9c5bc9832133d0a1b6ec`](https://github.com/GallenShao/dsh-faster-compress/commit/41e22ece70256a7a6d8c9c5bc9832133d0a1b6ec)
- Git 标签：[`v0.2.0`](https://github.com/GallenShao/dsh-faster-compress/tree/v0.2.0)，annotated tag；发布后保持不变。
- tarball SHA-1：`bd6190cf005f58fe26d4761a572d2e133e6d7ffb`
- tarball integrity：`sha512-mPcanKIichYMCu3sXz0F/fV3QpkeY9ZfY0jRy7nWu3Gtt4zAPYVQk8SBXkFus1aaZMMj07tzzU+X7H3HNtUWDQ==`
- 变更：压缩历史与应用后响应计时、就绪即应用的后台摘要、安全等待和原生回退、Web preset 隔离组接入、请求推理参数继承及严格历史 RPC 生命周期修复。默认准备比例 100%、独立预热关闭；升级保留已保存设置。
- 验证：114 项回归测试、构建、语法及差异检查；确切 tarball 在隔离 DSH 0.2.0-rc.2 中启动并成功调用严格历史 RPC。模型 I/O 使用测试桩，未宣称真实端点性能收益。
- 开源审查：未推送开发提交整理后发布，本机排障报告已移出；从 GitHub 全新镜像克隆审查全部 13 个发布时可达提交与 80 个唯一文件对象，未发现排障报告、本机绝对路径、真实会话标识或匹配凭据模式。所有 26 个 npm 文件与发布提交逐字节一致，测试夹具和本地资料不进入 npm 包。既有公开历史及 `v0.1.0` 保持不变。
- 线上验证：npm `latest` 为 `0.2.0`，作者为项目所有者；远程 tarball 的 SHA-1、integrity 及完整字节均与发布物一致。中英文 README 的版本化图片已从 GitHub 下载核对。

## 0.1.0 · 2026-10-17

- 审批：用户明确要求尝试发布 npm，并在登录、验证后要求重试；随后明确要求补建 Git 记录并推送至指定仓库。
- npm：[`dsh-faster-compress@0.1.0`](https://www.npmjs.com/package/dsh-faster-compress/v/0.1.0)
- Git 提交：[`cbe7a9865f668e4cfe76b92767c74ab71e69d43c`](https://github.com/GallenShao/dsh-faster-compress/commit/cbe7a9865f668e4cfe76b92767c74ab71e69d43c)
- Git 标签：[`v0.1.0`](https://github.com/GallenShao/dsh-faster-compress/tree/v0.1.0)
- tarball SHA-1：`63da4a58fa696c3c1a96ba7a8e6f89a4e2631a4d`
- 验证：42 项回归测试、语法检查、隔离 DSH 0.2.0-rc.2 的设置页交互及发布包加载；模型 I/O 使用测试桩，未做真实模型性能基准。

此版本先发布到 npm，后补建 Git 提交和标签。补录时已将发布包内全部 19 个文件与工作区逐字节核对，一致后提交；新增的仓库维护说明不在 npm 包清单内。标签保留该版本实现和测试，不包含后续 Trace 页功能。

2026-10-17，经用户明确批准覆盖推送并要求全部历史统一署名，已将此前 10 条提交的作者、提交者及 `v0.1.0` 标签署名改为 `gallenshao <shaojialun@pku.edu.cn>`。原因是仓库局部 Git 配置曾覆盖正确身份。每条提交的文件树、消息和原始时间均保持不变，仅身份与关联对象标识变化；旧历史已在本地备份。上述发布提交链接已更新，并再次核对标签中全部 19 个发布文件与原 npm tarball 一致。此次为用户明确授权的历史修正，后续仍不得擅自移动发布标签。

`package.json` 的作者字段在后续维护提交中补全；npm 上已发布的 `0.1.0` 内容、版本号和 tarball 校验值不变，未重新发布。

后续发布须遵循 [AGENTS.md](AGENTS.md) 的流程，让 npm 版本、Git 提交和 `v<版本号>` 标签一一对应。
