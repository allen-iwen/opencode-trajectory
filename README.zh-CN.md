# opencode-trajectory

[English](./README.md) · [集成指南](./INTEGRATION.md)

给 [OpenCode](https://opencode.ai) 装一个 **append-only 轨迹记录器**，外加一个零依赖的离线查看器。每轮对话里发生了什么、模型调了什么工具、参数和返回是什么、每一步花了多久、烧了多少 token —— 全部落到磁盘，可以事后逐帧复盘。

```
.opencode/trajectory/
├── _boot.json / _boot.log          每次插件启动留痕（用来确认它真的加载了）
└── sessions/
    ├── ses_abc123.jsonl            一个会话一份 append-only 日志
    └── ses_abc123.1.jsonl          超过 16MB 自动轮转
```

---

## 1. 它解决什么

OpenCode 本身有会话、`opencode debug`、分享链接、父子 agent 导航，但拿不到 **payload + 耗时 + token + 来源** 一体化时间线：你想知道「第 7 步那个 `bash` 到底传了什么、返回了什么、为什么慢了 4 秒」，得在多个视图之间来回拼。

DeepSeek Harness 的轨迹视图是框架级设计（append-only 事件流 + 按来源筛选 + 分叉回放）。本插件不做框架，只做**旁路记录**：订阅 OpenCode 的官方事件流，把它重建成一份同构的 append-only 日志，再用静态页面渲染。

### 与 DSH 的真实差距（不含糊）

| 能力 | DSH | 本插件 |
|---|---|---|
| append-only 事件日志 | 框架原生 | 靠 `event` 钩子重建 |
| 消息 / 工具 / 子 agent / 重试 / 权限 | ✅ | ✅ |
| 每步 payload 与耗时 | ✅ | ✅（来自 `ToolPart.state.time`） |
| 按来源筛选 | ✅ | ✅（user / assistant / tool / system / harness） |
| 从任意节点分叉、回放 | ✅ | ❌ 只标记可回退点（snapshot / messageID） |
| LLM 请求原始 body、完整上下文快照 | ✅ | ❌ 插件层拿不到 |
| 改 TUI 内嵌面板 | ✅ | ❌ 插件 API 无 UI 注入点（`PluginModule.tui: never`） |

结论：**能做「事后复盘 + 外部可视化」，做不到「框架内交互式分叉」**。想真分叉，用 DSH；想留在 OpenCode 里把执行过程看穿，用这个。

---

## 2. 为什么是 `event` 流，不是 `tool.execute.before/after`

这是最容易踩错的设计点，值得单独说。

| | `event` 钩子 | `tool.execute.before/after` |
|---|---|---|
| 能拿到 `messageID` / `partID` | ✅ | ❌ 只有 `sessionID` + `callID`，无法对齐消息树 |
| 工具返回（完整） | ✅ `ToolPart.state.output` | ⚠️ 出错路径拿不到 `output` |
| 工具耗时 | ✅ `state.time.start/end`，不用自己算 | 需手工计时 |
| 权限询问 / 重试 / 压缩 / 子 agent | ✅ | ❌ 全都拿不到 |
| 侵入性 | **零**：只读订阅，hook 从不改 `output` | 需要保证不抛错，否则中断工具执行 |

所以主力只有两个钩子：

```ts
event          // 全部事实来源，只读
chat.message   // 用户回合的权威时点（带稳定 messageID，避免与 event 重复）
```

`tool.execute.before/after` 一个都不用。插件崩了也不会影响会话 —— 每个 hook 都包在 try/catch 里，失败只上报一次 `client.app.log`。

---

## 3. 安装

### 方式 A：本地插件（推荐，零构建）

```bash
git clone <this repo> && cd opencode-trajectory
npm install          # 只为构建和测试，运行时零依赖
npm run build        # → dist/opencode-trajectory.js（单文件）
npm run install-plugin            # 装到 ~/.config/opencode/plugins/
# 或：npm run install-plugin -- --project   # 装到 ./.opencode/plugins/
```

必须是**单文件**：OpenCode 会加载插件目录下每一个 `.ts`/`.js`，多文件安装会让 `store.ts`、`normalize.ts` 被当成插件加载从而报错。bundle 就是为此存在的。

重启 opencode，跑一轮对话，然后：

```bash
node bin/cli.mjs serve --open
```

> **安装时唯一容易踩的坑**：目录扫描（`.opencode/plugins/`）和 `opencode.json` 的 `plugin` 数组**二选一**。两边都写会让插件实例化两次、每条记录写两遍。代码里做了进程内单例保护（按 directory 加锁），即使配置重复也只保留一个记录器，但别依赖这层兜底。

### 先看效果（不必跑真实会话）

```bash
npm run demo     # 生成含子 agent / 工具失败 / 重试 / 权限询问的示例轨迹
node bin/cli.mjs serve --dir .opencode/trajectory-demo --open
```

### 方式 B：`opencode.json` 声明（发布到 npm 后）

```json
{
  "plugin": ["opencode-trajectory"]
}
```

插件选项走数组形式：

```json
{
  "plugin": [["opencode-trajectory", { "captureReasoning": false, "maxPayloadChars": 4000 }]]
}
```

### 方式 C：项目级 `.opencode/plugins/`

同方式 A，把 `--project` 加上即可。项目级和全局级会同时加载，别装两遍。

### 方式 D：zip 分发包（给别人的电脑 / 内嵌 opencode）

```bash
npm run pack        # → out/opencode-trajectory-<version>.zip（约 46KB）
```

对方电脑无需 git / npm 账号，只要 Node ≥ 18：

```bash
# 解压后两条命令
node opencode-trajectory/scripts/install.mjs   # 插件进 ~/.config/opencode/plugins/
node opencode-trajectory/bin/cli.mjs serve     # 任何项目目录里看轨迹
```

内嵌 opencode（如自研系统的 ai-coding 功能跑 `opencode serve`）：把 `dist/opencode-trajectory.js`
放进**那台服务器/容器**的 `~/.config/opencode/plugins/`（或该项目的 `.opencode/plugins/`）即可，
轨迹落在服务端进程 cwd 的 `.opencode/trajectory/`。给系统加个查看入口有三种姿势：

1. `node bin/cli.mjs serve --port 7788` 起个只读端口，系统里 iframe / 新窗口链过去；
2. `node bin/cli.mjs export --session <id> --out x.html` 出单文件 HTML，直接当分享件挂进系统；
3. 轨迹本身是 JSONL，`docs/` 不依赖 viewer —— 后端直接读 `.opencode/trajectory/sessions/*.jsonl` 做自己的 UI。

---

## 4. 采集了什么

| `k` | 含义 | 关键字段 |
|---|---|---|
| `session` | 会话元信息与血缘 | `id` `parentID` `title` `directory` |
| `message` | 消息级事实（收尾时覆盖式更新） | `role` `agent` `providerID/modelID` `tokens{input,output,reasoning,cacheRead,cacheWrite}` `cost` `time{created,completed}` `finish` `error` |
| `text` | 流式正文，**增量**记录 | `pid` `d`(delta) `r`(reset) `syn`(系统注入) |
| `reasoning` | 思维链，同上 | 同上 |
| `tool` | 工具调用，**状态变迁**逐条 | `tool` `st`(pending/running/completed/error) `input` `output` `title` `error` `t0` `t1` `clipped` |
| `step` | 一次 LLM 往返边界 | `ph`(start/finish) `reason` `tokens` `cost` `snapshot` |
| `subtask` | 子 agent 派生 | `agent` `description` `prompt` |
| `error` | 会话/provider/abort 错误 | `name` `message` `detail` |
| `status` | busy / retry(attempt,next) / idle | `st` `attempt` `next` |
| `permission` | 权限询问与答复 | `ph` `permID` `type` `title` `response` |
| `file` | 文件变动（来自 patch/file 事件） | `file` `op` |
| `compact` | 上下文压缩 | `ph` |
| `harness` | 记录器自身状态（截断/轮转/内部错误） | `ev` `detail` |

设计约束：

- **append-only**：任何记录都不改写、不删除。`text`/`tool`/`message` 靠 id **upsert**（最后一条胜出），既有 append-only 语义，又能任意 fold 到某个偏移量。
- **增量而非快照**：`text` 只写 delta（前缀差分），一段 10KB 的回答不会写上百份全量快照。累计满 96 字符才落一行，`session.idle` 时兜底 flush 残余。
- **诚实标注缺口**：payload 被截断写 `clipped`，日志滚轮写 `harness:rotate`，绝不假装完整。

---

## 5. 查看器

```bash
node bin/cli.mjs serve --open                  # 本地服务 http://127.0.0.1:7777
node bin/cli.mjs list                          # 终端列会话 + 汇总
node bin/cli.mjs stats --session ses_abc123    # 终端摘要：token / 耗时 / 工具排行 / 错误
node bin/cli.mjs export --session ses_abc123   # 导出单文件 HTML（内联数据，可分享、可离线）
node bin/cli.mjs path                          # 打印解析到的轨迹目录
```

页面有两个投影，读同一份日志：

**轨迹视图（默认）** —— DSH 风格的事件流审计。一行一个事件，固定列宽，从上往下扫：

- 每行带**来源标签**：用户 / 模型 / 思考 / 步 / 工具调用 / 工具返回 / 上下文 / 子代理 / 错误 / 权限 / 文件 / 元信息，各配一种颜色，左侧 3px 色条贯穿整个流；
- 顶部过滤条按来源筛选（带计数），全文搜索覆盖正文、参数、返回、定位 ID；
- 点任意一行，右侧抽屉展开：定位 ID（messageID / partID / callID）、来源事件名、完整载荷（JSON 折叠树）、分叉锚点（复制后在别处定位同一点；真正的分支需要服务端写操作，本工具只读）；
- 底部**回放条**：按真实时间轴推进事件流，1x / 4x / 16x，拖进度条随意跳到任意时刻；
- 工具调用拆成「调用」和「返回」两行 —— 中间的时间差就是工具执行的真实耗时，这也是打开轨迹最常见的动机。

**对话视图** —— 还原成交读的样子：

- **左**：会话树。父子 agent 按 `parentID` 缩进，每项带轮次 / 工具数 / token / 错误 / 重试徽标。
- **中**：时间线。user 气泡 → assistant 正文 → 思考（可折叠）→ 工具卡片（点击展开输入/返回/定位 ID）→ 步骤分隔线（token 与成本）。
- **顶**：工具耗时瀑布，点条目跳到对应调用。
- **筛选**：全部 / 只看工具 / 只看思考 / 只看错误，加全文搜索。

导出模式是**单文件自包含**的：数据内联进 `<script type="application/json">`，`<` 转义为 `\u003c`，双击即开，不需要服务器 —— 用来贴给同事复现问题正好。

---

## 6. 配置

`opencode.json` 里传 options，或用环境变量覆盖（本地插件目录无法传 options，只能用环境变量）。

| 选项 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | `OPENCODE_TRAJECTORY_DISABLE=1` 关闭 | `true` | 总开关 |
| `dir` | `OPENCODE_TRAJECTORY_DIR` | `.opencode/trajectory` | 相对项目根或绝对路径 |
| `captureText` | — | `true` | 关掉则只记结构不记正文 |
| `captureReasoning` | `OPENCODE_TRAJECTORY_REASONING` | `true` | 是否记思维链 |
| `captureToolInput` | — | `true` | 是否记工具入参 |
| `captureToolOutput` | — | `true` | 是否记工具返回 |
| `maxPayloadChars` | `OPENCODE_TRAJECTORY_MAX_CHARS` | `20000` | 单条 payload 上限，超出截头留尾 |
| `maxInputChars` | — | `4000` | 工具入参 JSON 上限 |
| `flushMs` | — | `250` | 写盘间隔 |
| `maxFileBytes` | — | `16MB` | 单会话文件轮转阈值 |
| `redact` | — | `true` | 密钥脱敏 |
| `redactPatterns` | — | `[]` | 额外正则（字符串） |
| `debug` | `OPENCODE_TRAJECTORY_DEBUG=1` | `false` | 往 stderr 输出诊断 |

---

## 7. 隐私

轨迹日志是全仓库最危险的文件之一：工具入参里常有 `curl -H "Authorization: ..."`，工具返回里常有 `.env` 全文，正文里有完整 prompt。

默认行为：

- **脱敏**：`sk-*` / `gh*_` / `xox*` / `AKIA*` / `AIza*` / `Bearer *` / JWT / URL 里的 `user:pass@`，以及任何名为 `apiKey`、`token`、`password`、`authorization`、`cookie` 的字段值，一律替换为 `***REDACTED***`。保留可辨识前缀，便于判断「是哪把钥匙」，但不可复原。
- **截断**：单条 payload 默认 20KB，超出保留头 70% + 尾 30%，中间标注丢弃了多少字符。
- **可关**：`captureText=false` 只留结构（谁调了什么工具、多久、多少 token），不留内容。

建议把轨迹目录加进 `.gitignore`：

```gitignore
.opencode/trajectory/
```

---

## 8. 性能

| 措施 | 效果 |
|---|---|
| 文本按 96 字符增量合并 | 事件数从「每 token 一条」降到「每百字符一条」 |
| `message.updated` 500ms 节流 | 收尾/出错/首见必定落盘，中间抖动丢弃 |
| 工具只记状态变迁，终态封口 | 同一调用最多 3 条 |
| 写缓冲 64KB / 250ms，同步 append | 一轮典型对话 30–60 条、10–30KB |
| 16MB 轮转 | 长会话不会撑爆单文件 |

量级参考：100 轮的会话约 1–3MB。写入是同步 `appendFileSync`（单次 <1ms），代价换的是进程被 kill 时最多丢 250ms。

### 实测（OpenCode 1.18.26 / Windows / kimi-k2.5）

一轮「glob 列文件 + read 读字段 + 总结」的会话：

| 指标 | 实测值 |
|---|---|
| 记录数 | 30 条 / 61KB |
| 折行后 | 1 轮、4 条消息、3 个模型步、2 次工具调用 |
| token | in 7.3k / out 164 / reasoning 178 / cache-read 34.3k |
| 缓存命中率 | 82.5% |
| 墙钟耗时 | 15.3s（其中工具 679ms：glob 669ms、read 10ms） |
| 采集误差 | 工具入参、返回、起止时间与 API 响应逐字段一致 |

这轮验证同时暴露并修掉了三个真实缺陷：`chat.message` 与 `message.updated` 双写用户消息、`session.status` 与 `session.idle` 双写 idle、启动时的 `session.list()` 会把历史会话写成没有消息的会话记录。后者最要命 —— 历史项目一打开，会话树里全是空壳。现在改成：元信息只缓存，等该会话真正产生事件时才连同 parentID 一起落盘。

---

## 9. 走向官方采纳

顺序有讲究，跳步会白做：

1. **自己先用熟**（1–2 周真实项目）。没有真实语料，字段设计一定错。
2. **开源成独立仓库**，README 里有截图、字段表、隐私说明、性能数据。这几样是维护者最先看的东西。
3. **提进 ecosystem 列表**（`opencode.ai/docs/ecosystem#plugins`）。生态收录门槛低于合并，先拿到分发。
4. **开 Discussion 对齐设计**，重点谈四件事：字段语义稳定性、存储格式、性能开销、隐私边界。带上你的真实日志样本。
5. **再提 PR**。可行的合并范围是**采集层**（`packages/opencode` 里本就有 event bus，加一个可选 journal sink），**不是 UI** —— UI 会跟 TUI 重构冲突，维护者不会接。

诚实判断：官方更可能接受「内置一个可选的事件 journal 开关」，而不是「内置一个轨迹查看器」。所以这个项目的架构特意把采集和展示分开：采集层随时可以拆出去单独提 PR，查看器永远留在生态里。

---

## 10. 已知限制

- **不能改 TUI**：插件 API 没有 UI 注入点，任何「侧边栏实时面板」都得另起一个进程/页面（本项目的做法）。
- **多进程写同一会话**：给了 `O_APPEND` 的原子性假设，但没有跨进程锁。opencode 单实例场景下无碍。
- **event 钩子是串行 await**：记录必须快，所以写入走缓冲，不在 hook 里做重活。
- **拿不到 LLM 请求体**：`chat.params` 只能改参数，看不到最终序列化的 request。
- **Windows 路径**：已验证；`_boot.log` 有 pid 便于排查「插件是否加载」。

---

## 11. 开发

```bash
npm test           # 30 个用例：差分、去重、脱敏、截断、轮转、事件流投影、viewer 双视图 DOM 渲染
npm run typecheck  # 严格 TS 检查
npm run build      # 单文件 bundle
```

代码结构：

```
src/types.ts      记录模型（append-only 契约）
src/normalize.ts  事件 → 记录（差分、去重、状态机）
src/store.ts      JSONL 写入（缓冲、节流、轮转）
src/redact.ts     脱敏与截断
src/fold.js       记录 → 轨迹树（CLI 与浏览器共用的唯一实现）
src/index.ts      插件入口
viewer/index.html 查看器（生成 HTML 时注入 fold.js）
bin/cli.mjs       serve / export / list / stats
scripts/build.mjs esbuild 打成单文件（OpenCode 只认插件目录顶层的文件）
scripts/install.mjs  复制到全局或项目级插件目录
scripts/demo.mjs  生成演示轨迹（走真实 Normalizer + Store）
test/viewer.test.mjs  jsdom 里真跑一遍 viewer，防「静默白屏」
```

## License

MIT
