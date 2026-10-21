# 集成指南

把 opencode-trajectory 接进你自己的系统（尤其是内嵌 opencode 的 AI Coding 平台）。

本文只讲"怎么接"，不重复插件的设计原理 —— 那部分见 [README.md](./README.md)。

---

## 0. 先明确一件事：它由两部分组成，可以分开用

| 层 | 产物 | 是否必须 |
|---|---|---|
| **采集层** | `dist/opencode-trajectory.js`（单文件插件） | 必须。装进 opencode 才会产生轨迹 |
| **展示层** | `bin/cli.mjs` + `viewer/index.html` | 可选。你也可以不装它，直接读 JSONL 自己画 |

这个拆分是刻意的：采集层可以单独提 PR 进 OpenCode 核心，展示层留给你自由替换。**如果你的系统已有自己的前端，只用采集层就够了** —— 数据格式见第 5 节。

---

## 1. 内嵌 opencode 的接入位置

内嵌 opencode 本质还是那个进程，插件加载规则和 CLI 版完全一样。关键判断它跑在哪：

### 1.1 跑在用户机器上（桌面客户端形态）

装到那台机器的全局插件目录，覆盖该机器上所有 opencode 实例，包括你内嵌的那个：

```
Windows:  %USERPROFILE%\.config\opencode\plugins\
macOS/Linux:  ~/.config/opencode/plugins/
```

```bash
node opencode-trajectory/scripts/install.mjs
```

轨迹落在"该实例的工作目录"下：`<项目>/.opencode/trajectory/sessions/<sessionID>.jsonl`。

### 1.2 跑在服务器/容器里（SaaS 形态）

放到**服务端**的插件目录。两种写法：

```bash
# 全局：该容器内所有 opencode 进程生效
node opencode-trajectory/scripts/install.mjs --dir /opt/opencode-plugins

# 项目级：单个工作目录生效
mkdir -p /srv/workspace/.opencode/plugins
cp dist/opencode-trajectory.js /srv/workspace/.opencode/plugins/
```

注意 `--dir` 是**插件目录**（放 .js 的地方），不是轨迹目录。轨迹目录由插件配置决定，见第 2 节。

### 1.3 通过 opencode.json 声明（推荐给容器化部署）

不想往镜像里 cp 文件，可以在 `opencode.json` 里声明并传配置：

```json
{
  "plugin": [
    ["opencode-trajectory", { "dir": "/data/trajectory" }]
  ]
}
```

配合 `npm i opencode-trajectory`（发布到 npm 后）或把插件目录挂载进容器。

> **别双载**：同一个目录既被自动扫描到、又在 `plugin` 数组里声明，会导致两个实例同时写。插件有进程内单例兜底，但配置上仍建议只选一种。

---

## 2. 配置项（全部可选）

传给插件对象的 options，或写到 `opencode.json` 的 `plugin` 数组第二项：

| 键 | 默认 | 说明 |
|---|---|---|
| `dir` | `.opencode/trajectory` | 轨迹输出目录。**支持绝对路径** —— 多实例写同一个中心目录就靠它 |
| `enabled` | `true` | 总开关。CI 里想静音就设 `false` |
| `captureText` | `true` | 记录正文 |
| `captureReasoning` | `true` | 记录思考过程 |
| `captureToolInput` | `true` | 记录工具入参 |
| `captureToolOutput` | `true` | 记录工具返回 |
| `maxPayloadChars` | `20000` | 单条 payload 截断长度（留头 70% + 尾 30%） |
| `maxInputChars` | `4000` | 工具入参截断长度 |
| `flushMs` | `250` | 落盘节流间隔 |
| `maxFileBytes` | `16777216` | 单文件轮转阈值（16MB） |
| `redact` | `true` | 密钥脱敏。**生产环境不要关** |
| `redactPatterns` | `[]` | 额外脱敏正则（字符串数组，用于业务自定义敏感词） |
| `debug` | `false` | 打印内部诊断 |

### 中心化存储（多项目/多租户）

```json
{ "plugin": [["opencode-trajectory", { "dir": "/data/trajectory" }]] }
```

所有会话写到同一目录。文件名是 `sessionID.jsonl`，sessionID 全局唯一，不会冲突。

**注意**：目前的查看器按 `parentID` 构建会话树，不按项目目录分组。多项目混在一个目录里，会话列表会平铺在一起。如果要做多租户，建议：
- 目录按租户分：`dir: "/data/trajectory/<tenant>"`（每个实例/容器一个租户）
- 或直接读 JSONL 自己按 `session.directory` 字段分组，见第 5 节

---

## 3. 展示层集成（三种形态，按侵入度排序）

### 3.1 iframe 嵌入（最省事，已实测）

```bash
# 服务端起一个只读查看器
node opencode-trajectory/bin/cli.mjs serve --dir /data/trajectory --port 7788
```

你系统的会话详情页加一个 tab：

```html
<iframe src="http://your-host:7788/" style="width:100%;height:100%;border:0"></iframe>
```

**已实测确认**：
- 服务端不发 `X-Frame-Options`，任何域名都能嵌
- viewer 内数据请求走相对路径（`api/index`），对 iframe 自身源是同源，**不需要额外配 CORS**
- 宿主页必须是 `http(s)`，用 `file://` 打开时 iframe 内数据加载会失败

如果需要嵌多个项目的轨迹，一个进程只能指一个 `dir`。多项目就起多个进程（不同端口），或改造 CLI 支持多 root。

### 3.2 单文件导出（零服务）

```bash
node opencode-trajectory/bin/cli.mjs export --session <sessionID> --out trace.html
```

产出一份**完全自包含**的 HTML（数据 + fold 逻辑都内联），双击能开、可交互、可发给别人。

适合：会话跑完时由后端生成，挂到详情页的"轨迹"标签；或作为产物归档。

### 3.3 直读 JSONL 自己画（最深集成）

不用装 viewer，你的后端直接读 `sessions/*.jsonl`，按自己的 UI 规范渲染。数据格式见第 5 节，折叠逻辑可参考 `src/fold.js`（MIT，随便改）。

---

## 4. 会话 ↔ 你的业务对象怎么关联

opencode 的 `sessionID` 就是文件名，也是 `session.id`。你的流程：

1. 你系统创建一个会话 → 调 opencode 的 `POST /session` → 拿到 `sessionID`
2. 把这个 ID 存到你的业务表（task_id ↔ session_id）
3. 查轨迹时用 `sessionID` 直接定位 `sessions/<sessionID>.jsonl`

子 agent 会话通过 `parentID` 挂到父会话下（`session` 记录的 `parentID` 字段），你的 UI 可以据此画树。

---

## 5. 数据格式契约

**格式**：UTF-8 JSONL，一行一条记录，append-only（只追加、不修改）。

**文件位置**：`<dir>/sessions/<sessionID>.jsonl`，超过 `maxFileBytes` 会轮转成 `<sessionID>.1.jsonl` 等。

### 公共字段（每条记录都有）

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | number | schema 版本 |
| `seq` | number | 写入进程内单调序号 |
| `ts` | number | 写入时刻（epoch ms） |
| `sid` | string | sessionID |
| `k` | string | 记录类型，见下表 |
| `ev` | string? | 产生该记录的原始 OpenCode 事件名（审计用） |

### 记录类型

| `k` | 关键字段 | 说明 |
|---|---|---|
| `session` | `id` `parentID?` `title?` `directory?` | 会话元信息，`parentID` 构成 agent 树 |
| `message` | `mid` `role` `agent?` `providerID?` `modelID?` `time` `tokens?` `cost?` `finish?` `error?` | 消息级事实：模型、token、成本、耗时 |
| `text` | `pid` `mid` `d` `r?` `syn?` | **流式文本增量**。`d` 是增量片段；`r:1` 表示重置（丢弃之前累积）；`syn:1` 表示注入内容（非模型输出） |
| `reasoning` | 同上 | 思考过程，结构同 `text` |
| `tool` | `pid` `mid` `callID` `tool` `st` `input?` `output?` `t0?` `t1?` `error?` | 工具调用。**同一 `pid` 的多条记录表示状态变迁**，最后一条胜出 |
| `step` | `ph`（start/finish）`tokens?` `cost?` `reason?` `snapshot?` | 模型步边界 |
| `error` | `name` `message` | 错误 |
| `status` | `st`（busy/idle/retry）`attempt?` `next?` | 会话状态与重试 |
| `compact` | — | 上下文压缩 |
| `permission` | `id` `title` `type` | 权限请求/结果 |
| `file` | `path` `diff?` | 文件变更 |
| `subtask` | `agent` `prompt` `sessionID?` | 子任务（子 agent） |
| `harness` | — | 记录器自身事件（启动等） |

### 折叠规则（重要）

记录是 append-only 的，同一对象会有多条。要还原最终状态：

- **`text` / `reasoning`**：按 `pid` 拼接所有 `d`；遇到 `r:1` 先清空再拼
- **`tool`**：按 `pid` 取最后一条（状态机，最后状态是终态）
- **`message`**：按 `mid` 取最后一条（token/成本会陆续补全）
- **`session`**：按 `id` 取最后一条

`src/fold.js` 里有完整实现（`fold()` 出消息树，`trajectory()` 出事件流），浏览器和 CLI 共用同一份，可以直接拿去用。

### 容错

写入是逐行 append，进程被 kill 时最后一行可能不完整。**读取时按行 `JSON.parse`，解析失败就跳过该行**，不要整体失败（`parseJournal()` 就是这样做的）。

---

## 6. 安全与合规

| 事项 | 现状 |
|---|---|
| 数据出口 | **没有任何外发**。不联网、不上报、不发 OTel，纯本地文件 |
| 密钥脱敏 | 默认开启。`sk-*`、`gh*_`、AWS、Google、Bearer、JWT、URL 里的密码一律替换为 `***REDACTED***`（保留短前缀便于识别类型） |
| payload 截断 | 默认 20KB，超出留头尾 |
| 文件权限 | 继承进程 umask。需要更严格就自己 `chmod 700` 目录 |
| 会话内容 | 包含用户 prompt、模型输出、工具返回 —— **可能含业务数据**。落盘位置和保留策略需要你按合规要求定 |

生产环境建议：`redact` 保持 `true`；把 `dir` 指到你自己的受控目录（不要放在用户可写位置）；按你的留存要求做定期清理（插件不做删除，append-only）。

---

## 7. 已验证 / 未验证清单

诚实标注，避免你踩坑。

### 已验证

- OpenCode **1.18.26**：插件加载、事件采集、落盘、viewer 渲染全链路（真实模型会话，78 条记录）
- 全局安装 + 项目级安装两种方式
- iframe 嵌入宿主页（HTTP 宿主，完整渲染）
- 单文件导出在 `file://` 下打开
- 30 个自动化测试（含 jsdom 渲染回归）

### 未验证（你集成前需要自己确认）

- **OpenCode 1.19.x 及以上**：钩子签名在 1.4.7 → 1.18.26 之间一致，但更高版本未实测
- **Windows 以外的路径处理**：路径逻辑用 `path.join`，理论上跨平台，但只在 Windows 实测过
- **多实例并发写同一 `dir`**：文件名不冲突，但未做高并发压测
- **TUI 内嵌/Web 端内嵌的进程模型差异**：如果内嵌方式不是标准 `opencode serve`/`opencode run`，插件加载时机可能不同

---

## 8. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 没有生成 `.opencode/trajectory/` | 插件没加载 | 确认插件在 `plugins/`（复数）目录；**opencode 已运行的话必须重启**（只在启动时加载一次） |
| 目录存在但没有新会话 | opencode 跑在别的目录 | 轨迹落在实例的**工作目录**下，不是插件目录 |
| 每条记录写了两遍 | 自动扫描 + `plugin` 数组双载 | 二选一 |
| viewer 打开是空白 | 数据目录指错 | `cli.mjs path` 看实际解析的目录；`--dir` 要精确指向 `trajectory` 目录本身 |
| iframe 里一直"载入中" | 宿主页是 `file://` | 用 http/https 宿主，或直接打开 viewer 地址 |
| 会话树里有空壳会话 | 旧版本 bootstrap 缺陷 | v0.1.0 已修（元信息懒写入） |
