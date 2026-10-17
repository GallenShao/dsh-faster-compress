# 发布追溯

## 审批与记录规则

每次版本变更和发布都由项目所有者（当前用户）明确审批。先完成实现、文档及测试，提供拟用版本号、目标提交、变更摘要、测试结果与发布范围供审批；获批前不修改版本号、不创建发布标签、不发布 npm 或 GitHub Release。用户可以一次批准版本变更和发布，也可以分别批准，不能将一次授权沿用到后续版本。

发布必须能追溯到确定的 Git 提交、annotated tag 和 npm tarball 校验值。按 [AGENTS.md](AGENTS.md) 执行完整流程；未发布内容写入 `CHANGELOG.md` 的 `Unreleased`。既有标签保持不变，发布后补充记录使用单独的文档提交。

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
