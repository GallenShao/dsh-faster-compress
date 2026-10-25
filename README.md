# Faster Compress

**让上下文摘要提前准备，少打断一次正在推进的工作。**

中文 · [English](README.en.md)

![Node.js 22.19+](https://img.shields.io/badge/Node.js-%E2%89%A522.19-356D50?style=flat-square)
![DSH 0.2.1-rc.2](https://img.shields.io/badge/DSH-tested_on_0.2.1--rc.2-0A7A78?style=flat-square)
![MIT](https://img.shields.io/badge/license-MIT-526B7A?style=flat-square)

![原版需要停下来等摘要；Faster Compress 提前在后台生成摘要，到 step 边界再提交。](https://raw.githubusercontent.com/GallenShao/dsh-faster-compress/v0.2.4/assets/overview-zh.svg)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**后台上下文压缩**，减少长任务中停下来等摘要的时间，并通过压缩历史查看结果、耗时和用量。

## 安装，只填一个包名

打开 DSH 侧边栏的 **插件 → 添加插件**，输入：

```text
dsh-faster-compress
```

点击安装，完成后重新启动 DSH。**默认即用，无需 API Key，也不用编辑 YAML。**

已验证 **DSH 0.2.0-rc.2 / 0.2.1-rc.2**，需要 **Node.js ≥ 22.19**。它沿用当前对话的模型和已有凭据；摘要、预热请求仍按模型服务的规则计费。

<details>
<summary>只用命令行？</summary>

```sh
dsh plugin --profile web add dsh-faster-compress
```

然后重新启动 `dsh web`。桌面端请使用应用内的“添加插件”。

</details>

## 装上后，改变了什么？

- **边工作，边准备。** 达到准备阈值后，后台生成摘要，主任务在安全余量内继续推进。
- **准备好，就应用。** 在下一次模型请求前替换上下文，保留期间新增的消息；正常回合结束后也会保留摘要，供下一轮校验复用。
- **失败时有兜底。** 摘要失败或失效时回退原生压缩，仍可使用 `/compact`。

## 压缩历史

打开会话顶部的 **压缩历史**，即可查看：

- **内容与状态**：摘要、原文摘录、是否已应用，以及失败原因。
- **耗时**：后台准备、压缩等待与应用后的首输出时间。
- **用量**：压缩前后的实测输入 token，以及摘要请求和缓存用量。

支持搜索、筛选、复制，并跟随 DSH 主题。

## 设置

进入 **插件 → 已安装 → 更快压缩 · Faster Compress**，修改后保存即可生效，无需重启。

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| 后台准备时机 | **100%** | 摘要经常来不及时可调低；此比例相对于准备阈值，并非上下文容量 |
| 预热新上下文 | **关闭** | 可选的额外请求，适合服务有余力且能复用缓存时尝试 |
| 显示压缩历史标签 | **开启** | 显示或隐藏会话中的历史页 |

通常保持默认即可。高级选项可调整输出预留、安全余量和并发数；升级保留已有设置。

DS Bot 兼容：由 ds-bot 接管压缩的会话自动跳过后台准备和预热，已有准备结果会丢弃；压缩交由 DS Bot 管理。同一预设下的普通会话仍使用加速。自动检测，无需额外配置。

## 使用须知

- 适合长对话和频繁工具调用。后台摘要仍占用模型资源并按服务商规则计费，不能保证消除所有等待。
- 未应用的摘要只保存在内存中。重启后会重新准备，或回退原生压缩。
- 历史会在 `$DSH_HOME/data/faster-compress/traces/` 保存摘要与原文摘录。隐藏标签页不会停止记录；清理这些副本时，先停止 DSH，再删除该目录。

[开发与测试](https://github.com/GallenShao/dsh-faster-compress/blob/main/tests/README.md) · [更新记录](CHANGELOG.md) · [发布记录](https://github.com/GallenShao/dsh-faster-compress/blob/main/RELEASES.md) · [源代码](https://github.com/GallenShao/dsh-faster-compress) · [MIT License](LICENSE)
