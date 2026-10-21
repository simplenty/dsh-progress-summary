# dsh-progress-summary

给 DeepSeek Harness 加一条**旁路生成**的进度摘要：不打扰主模型，用一个小模型把实时思考压成一行"人话"，
同时出现在 Web UI 的输入区上方和 dsh-tui 的状态行。

## 显示在哪

- **Web**：输入框上方的那一行（composer 的 dock），不是对话流里的过程组标题。
- **dsh-tui**：输入区上方的状态行。
- **开关**：设置 → 通用 → **显示进度摘要**。关掉后不产生任何模型调用，TUI 行也会立即清空。
  其它参数（模型、间隔、token 阈值、语言）在 Plugins 页的插件表单里。
- 对话流里的"工作步骤展示"是另一套东西（Chat 的四种模式 + 摘要模式补丁），本插件不改它。

## 为什么是旁路

Codex 的进度摘要来自模型/API 的独立通道（`reasoning.summary` + `commentary` 消息），
DeepSeek 只有原始 `reasoning_content`，没有这一层。两条替代路线：

- **提示词法**（现成的 working-activity / progress-narrator 用的）：要求主模型每步先说一句。
  便宜，但和主任务抢输出预算，OpenAI 自己的 Codex 迁移指南明确建议删掉这类"preamble"提示。
- **旁路法**（本插件）：主模型完全不动，另开一次低思考强度的短请求读最近的思考片段，写一行。

代价是额外调用；收益是不影响主任务，且摘要始终是"给用户看的"。

## 触发策略

分两层：**零成本的行**每个边界都更新；**模型生成的行**只在工具调用前触发。

| 触发点 | 产出 | 成本 |
|---|---|---|
| 轮次开始 | 「正在分析需求」 | 0 |
| 每个工具调用 | 「正在运行命令 · npm test」这类由工具名+参数推出的行 | 0 |
| **工具调用前**且满足两个阈值 | 小模型写一句「人话」 | 1 次调用 |
| 轮次结束 | 发 idle 清空 | 0 |

模型行的两个阈值必须同时满足：

1. **时间**：距上次播报 ≥ `minIntervalMs`（默认 20s）；
2. **token**：自上次播报以来新增内容折算 ≥ `minTokens`（默认 600，`charsPerToken` 默认 3，即约 1800 字符）。

为什么把工具调用当作唯一的模型触发点：**工具调用是"这段思维链已经写完"的唯一确定信号**。模型已经决定并提交了一个动作，它前面的推理一定是完整的；而流停顿、token 速率变化都不能证明这一点。这样也天然避免拿半截思维链去总结。

阈值不满足时不会丢弃内容：新增的字符留在缓冲区里，下一次工具调用重新判断。调用失败也一样，会把这一次消费掉的字符还回去，下一个边界重试。

没有工具调用的轮次（纯问答）不会产生模型摘要——只有起始行；这是这个策略的取舍：宁可少一次播报，也不在思维链中途切一刀。

上限：每轮最多 `maxPerTurn`（默认 40）次调用，单次输出 ≤96 token，`effort=off`。

## 安装

### 从 npm（发布后）

```bash
dsh plugin --profile web add dsh-progress-summary
dsh plugin --profile dsh-tui add dsh-progress-summary   # 可选：TUI
```

包声明了 `dsh.bundle.patch`，`dsh plugin add` 会把它加进 profile 的 bundle 层列表；
`cordis.patch.yml` 插入 `progress-summary` 行，`dsh.client` 让 Web 端加载浏览器半区。
依赖（`@deepseek-ai/dsh-session` / `dsh-llm` / `schemastery`）由 pnpm 从 registry 装进 profile。

卸载：`dsh plugin --profile web remove dsh-progress-summary`。

### 本地开发（link:）

```bash
cd /path/to/dsh-progress-summary
npm install --omit=dev
dsh plugin --profile web add "link:$PWD"
```

`link:` 只是开发期便利：profile 里是一个软链，改完源码重启 DSH 就能看到效果，不必每次
打包发布。它不影响发布——发布后用户走上面的 npm 路径，拿到的是正常安装的包。

## 配置

两种方式，效果相同。

**Plugins 页**：打开 Plugins → 已安装插件 → `dsh-progress-summary`，页面中间就是
「摘要模型」表单（`model` / `provider` / `effort`）。同一份表单也挂在行 `progress-summary`
的 **Configure** 下面。三个字段标了 `.volatile()`，保存后下一次摘要就生效，不需要重启。

**profile YAML**：在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 按 id 覆盖：

```yaml
- id: progress-summary
  config:
    model: auto          # 跟随会话；也可写 deepseek-flash 固定
    effort: 'off'
    minIntervalMs: 20000
    maxPerTurn: 40
    lang: zh
    tui: true
    publish: true
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `provider` / `model` | `auto` / `auto` | `auto` = 跟随会话当前模型；也可固定成任意已配置的路由（Plugins 页可改，立即生效） |
| `effort` | `off` | `off` / `low` / `high` / `max`；路由不接受时自动降级为不传 |
| `maxTokens` | `96` | 单次输出上限 |
| `timeoutMs` | `8000` | 单次调用超时，超时静默放弃 |
| `minIntervalMs` | `20000` | 两次播报的最小间隔（可在线改） |
| `minTokens` | `600` | 触发所需的估算 token 数（可在线改） |
| `charsPerToken` | `3` | token 估算除数（中英混排约 3 字符/token） |
| `excerptChars` | `700` | 送给模型的思考尾部长度 |
| `maxLineChars` | `128` | 渲染行硬上限（字符数，不是 token）；界面按两行折行 |
| `maxPerTurn` | `40` | 每轮调用上限（成本天花板） |
| `lang` | `auto` | `auto` 跟随 `DSH_TUI_LANG` / `LANG`，否则 `zh` / `en` |
| `quickLines` | `true` | 每个工具边界先发一条零成本的行，不依赖模型 |
| `subagents` | `false` | 是否也播报子智能体会话 |
| `debug` | `true` | 把阶段日志写到 `~/.dsh/progress-summary-debug.log`（上限 256KB） |
| `publish` | `true` | 提交 ignorable 插件记录，供 Web 端投影 |
| `tui` | `true` | 向组合了 TUI 的进程注册 `ctx.tuiStatus` 行 |

## 两个界面怎么拿到数据

- **Web**：宿主把摘要写成 `plugin:progress-summary/line`（`ignorable: true`，不影响 resume），
  再折叠成 `progressSummary` 会话投影；浏览器的停靠组件用 `useProjection` 读取，
  `conversation.input.dock` 里第 16 位（在 working-activity 的 15 之后）。
- **TUI**：直接 `ctx.tuiStatus.set('progress-summary', line)`，轮次结束传 `undefined` 清空。
  走的是 dsh-tui 的 XI 号稳定 seam（keyed status line），不需要 Web 的那条记录。

两个 profile 各自装载同一个包，宿主侧代码完全相同，只差有没有对应服务。

## 已知限制

- 每接受一条摘要就写一条会话记录（即使 `ignorable`）。默认节流下每轮约 10 条；
  介意日志体积就把 `publish` 关掉，Web 就没得看，只剩 TUI。
- 摘要读的是原始 CoT，模型若用英文思考，摘要仍按 `lang` 输出中文，但细节取舍会受原文影响。
- 冷启动（resume）时投影会把上一轮的最后一条记录折叠进来；`turn/start` 和 `turn/end`
  会把它清成 idle，所以不会残留"运行中"。
- 辅助模型路由必须已注册。配错 provider/model 时调用静默失败，界面只是没有这一行。

## 测试

```bash
node --test test/*.test.mjs
```

16 项：行清洗、触发节流、每轮上限、轮次结束清理、失败静默、投影折叠、接线冒烟。

## 摘要模型怎么选

默认 `auto`：插件在会话每次发请求时读取该会话记录的 `request/header`，拿到
`provider` + `model`，再用同一个 `ctx.llm` 服务发起辅助调用。也就是**你用什么模型聊天，
就用什么模型播报**，不需要额外配 key、路由或模型目录。

想省钱或要更快，就把 `model` 固定成更小的型号（例如 `deepseek-flash`）；`effort` 保持
`off` 即可。路由不认 `off` 时插件会自动退化成"不传 effort"再试一次，不会因此报错。

之所以默认跟随而不是默认固定：DSH 的模型目录因账号/供应商而异，写死一个型号在别人的
profile 里很可能不存在；跟随会话则永远可用。
