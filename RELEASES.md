# 发布追溯

## 0.1.0 · 2026-10-17

- npm：[`dsh-faster-compress@0.1.0`](https://www.npmjs.com/package/dsh-faster-compress/v/0.1.0)
- Git 标签：[`v0.1.0`](https://github.com/GallenShao/dsh-faster-compress/tree/v0.1.0)
- tarball SHA-1：`63da4a58fa696c3c1a96ba7a8e6f89a4e2631a4d`
- 验证：42 项回归测试、语法检查、隔离 DSH 0.2.0-rc.2 的设置页交互及发布包加载；模型 I/O 使用测试桩，未做真实模型性能基准。

此版本先发布到 npm，后补建 Git 提交和标签。补录时已将发布包内全部 19 个文件与工作区逐字节核对，一致后提交；新增的仓库维护说明不在 npm 包清单内。标签保留该版本实现和测试，不包含后续 Trace 页功能。

后续发布须遵循 [AGENTS.md](AGENTS.md) 的流程，让 npm 版本、Git 提交和 `v<版本号>` 标签一一对应。
