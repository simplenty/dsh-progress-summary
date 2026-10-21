> **已弃用**：摘要现在有独立的显示位置（输入框上方的 dock）和独立开关（设置 → 通用），
> 不再作为第 5 种工作步骤展示模式。本目录仅保留当时的验证记录，安装目录中的补丁已还原。

# 摘要模式（summary work-details mode）

给 `@deepseek-ai/dsh-client-ui-chat` 增加第 5 种工作步骤展示模式：**摘要**。

现在的 4 种模式（简洁 / 标准 / 详细 / 完全展开）解决的是"过程明细露多少"，但它们都有一个共同点：
**运行中的 Turn 总是把过程逐行展开**。摘要在两者之间补一个档：

> 每个阶段只留一行过程标题，过程明细默认折叠、点一下才展开。

## 效果

运行中：

```
▸ 正在运行命令 · npm test          ← 只有这一行，实时更新
  （以下是折叠的过程明细，点击标题展开）
```

完成后：

```
▸ 已读取文件并运行了命令           ← 整轮一行；点开看每一步
```

答案正文不受影响，始终可见。

## 和"旁路摘要插件"的关系

| | 摘要模式 | 旁路摘要插件 |
|---|---|---|
| 管什么 | 显示密度：过程留几行 | 内容：这一行说什么 |
| 数据来源 | 现有的过程摘要（工具名 + 参数、步数、耗时） | 低成本辅助模型读 CoT 写成一句人话 |
| 成本 | 0 token | 每次触发几十 token |
| 作用面 | Web UI | Web UI 的停靠行 + dsh-tui 状态行 |

两者独立，可单用也可叠加：摘要模式把过程噪音压到一行；旁路插件把这一行变成"人话 + 为什么"。
叠加时如果觉得重复，可以关掉插件的 Web 停靠行，只留 TUI。

## 改了什么

只动两个文件、五处：

1. `lib/index.js`：`TRANSCRIPT_VIEW_MODES` 增加 `"summary"`（Host 端设置 schema 的取值域）。
2. `lib/client.js`：
   - `TRANSCRIPT_VIEW_MODES` 同样增加（设置选择器据此生成选项）；
   - 展示策略表增加 `summary`：`liveProcessDetail: true` + `collapseLiveTurns: true`；
   - 折叠时机的叉乘表 `withTiming` 增加 `summary`；
   - 中英文案 `settings.transcript.summary`（摘要 / Summary）；
   - `ChatGroupSeat` 的 `grouped` 判定增加 `policy.collapseLiveTurns`，让**运行中的 Turn** 也按"标题 + 可展开正文"渲染。

`collapseLiveTurns` 是唯一的新策略字段，其余全部复用现有机制——所以没有新增渲染分支，也没有新增数据。

## 应用

```bash
# 目标默认是全局 dsh 里自带的 ui-chat
bash apply.sh

# 或显式指定
bash apply.sh /path/to/node_modules/@deepseek-ai/dsh-client-ui-chat
```

脚本会先备份 `lib/*.js`（`*.bak-<时间戳>`），再用 `patch -p1` 应用两个补丁。

**必须重启 `dsh web`**：Host 端的设置 schema 也是打包产物的一部分，只刷新页面不会生效。

回滚：把备份文件复制回去，再重启。

## 注意

- 这是对**已安装构建产物**的补丁，升级 `@deepseek-ai/dsh` 会被覆盖；它用于验证手感，不是长期方案。
- 长期方案是把同样五处改动放进 `packages/client/ui-chat` 源码（`src/chat-settings.ts`、`src/client/presentation-policy.ts`、`src/client/locale.ts`、`src/client/chat/ChatGroupSeat.tsx`），随版本发布。
- 摘要在**思考阶段**只有"正在分析请求"这类粗粒度标题（因为此时没有工具详情）；想要更具体的一句话，叠加旁路摘要插件。
