# 项目约定

- 默认 README 使用中文；同步维护 `README.en.md`。
- 优先参照当前安装的 DSH 发布包确认接口。父目录的 `AGENTS.md` 记录了本机运行时的位置和限制。
- 不修改用户日常使用的 DSH 配置；集成验证使用隔离的 `DSH_HOME`。

## npm 发布与 Git 追溯

用户要求：每次 npm 发布必须维护对应 Git 提交和 release tag。不得从未提交的工作区发布。

1. 更新 `package.json` 版本与 `CHANGELOG.md`；运行构建、必要的回归测试、语法检查及 `git diff --check`。
2. 检查 npm 包清单，确认构建产物、文档和源代码齐全，且不含凭据、日志、临时文件。
3. 提交该版本全部源文件、测试、文档和构建产物。`git status --porcelain` 必须为空。
4. 从该提交生成最终 tarball，核对包中每个文件都与提交内容一致；打包不得留下未提交变更。
5. 创建与版本号对应的 annotated tag：`v<package.json.version>`，标签说明包含版本、验证情况和 tarball SHA-1。不得重定向、覆盖或强推已发布标签。
6. 将版本提交和标签推送到 `origin`，核对远程标签指向；再发布步骤 4 中核验过的确切 tarball。推送或认证失败时说明阻碍，不可省略 Git 步骤。
7. 发布后验证 npm 版本、`latest`（若此次发布使用该标签）、tarball 校验值，以及 README 依赖的在线资源。报告版本、Git 提交和标签。

发布认证需要用户在浏览器完成时，使用 `npm publish --browser=false` 配合交互终端展示验证链接；不要索要密码、长期 token 或恢复码。

首次 `0.1.0` 先发布后补建 Git 记录，是一次历史补录，依据见 `RELEASES.md`。这不构成后续发布可以省略提交或标签的例外。
