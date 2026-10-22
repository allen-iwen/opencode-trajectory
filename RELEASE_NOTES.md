# opencode-trajectory v0.1.0

An **append-only trajectory recorder** for [OpenCode](https://opencode.ai) — every message, tool call, payload, token and millisecond written to disk — plus a zero-dependency offline viewer that replays the run as a single event stream.

No external service, no telemetry, no account. Two files in, one HTML out.

```bash
node scripts/install.mjs     # → ~/.config/opencode/plugins/
traj                         # → http://127.0.0.1:7777
```

![trajectory view](https://raw.githubusercontent.com/allen-iwen/opencode-trajectory/main/docs/screenshot.png)

## What you get

**A trajectory view, not a chat view.** One row per event — sequence number, relative timestamp (`+4.236s`), origin rail, tag, content, duration, status. Twelve origins: user, assistant, reasoning, step, tool call, tool result, context, sub-agent, error, permission, file, meta. Click any row for a drawer with `messageID` / `partID` / `callID`, the originating event name, collapsible JSON payload, and fork anchors. The conventional chat projection is still there as a second tab.

**Tool call and tool result are separate rows.** The gap between them is the tool's real latency — usually the reason you opened the log in the first place.

**It is a journal, not a database.** UTF-8 JSONL, append-only, one record per line, diffed text (`d` / `r`) instead of repeated snapshots. Buffered at 64KB / 250ms, rotated at 16MB, crash-safe (`kill -9` costs you at most the last 250ms).

**It cannot break your session.** Only two hooks are used — `event` (read-only subscription, `output` never mutated) and `chat.message` (authoritative user-turn timing). Every hook is wrapped in try/catch and reports at most once via `client.app.log`. `tool.execute.before/after` is deliberately unused: it has no `messageID`/`partID` and cannot align to the message tree.

**Redaction is on by default.** `sk-*`, `gh*_`, AWS, Google, `Bearer`, JWTs and URL credentials become `***REDACTED***` (short prefix kept so you can still tell the type). Payloads truncate at 20KB, head 70% / tail 30%.

## Install

Requires Node 22.18+ and OpenCode 1.18+.

```bash
# from a clone or from the release zip
node scripts/install.mjs             # global — every opencode instance on this machine
node scripts/install.mjs --project   # current project only
node scripts/install.mjs --dir PATH  # explicit plugin dir (containers, custom layouts)
```

Restart `opencode` afterwards — plugins load once at startup. First proof it worked is `.opencode/trajectory/_boot.json`.

## Inspect

```bash
traj                                                  # serve + open browser
traj stats                                            # turns, tokens, cost, slowest tools
traj list                                             # sessions
traj export --session ses_xxx --out trace.html        # self-contained single file
traj path                                             # which directory is it reading?
```

`traj export` inlines the data **and** the folding logic, so the HTML opens from `file://` with no server, no CDN, no build step — attach it to a bug report, drop it in a wiki, hand it to a reviewer.

## Embedding it in your own product

If you ship a product with OpenCode inside it (an AI-coding panel, an internal agent platform), [INTEGRATION.md](https://github.com/allen-iwen/opencode-trajectory/blob/main/INTEGRATION.md) covers three shapes:

1. **iframe** — serve the viewer on any port you already own; same-origin relative paths mean no CORS work, and the page sets no `X-Frame-Options`.
2. **Single-file export** — generate a `trace.html` per session and store it wherever you store artifacts.
3. **Read the JSONL yourself** — `src/fold.js` is the reference folding implementation (`fold()` → message tree, `trajectory()` → event stream), shared verbatim by the CLI and the browser. Roughly 300 lines, no dependencies.

## Verified

- 30 tests green (`node --test`), `tsc --noEmit` clean in strict mode.
- Real session, real model: `kimi-k2.5` fixed a shopping-cart bug — 10 tool calls, 38.4s wall clock, 78 records on disk, agent repaired both the code and its own test script.
- Verified against OpenCode **1.18.26** on Windows; TUI, `serve` + SDK, and iframe embedding all exercised.

## Honest limits

| | Status |
|---|---|
| fork / replay from an arbitrary node | **no** — read-only recorder; records only carry `snapshot` / `messageID` anchors |
| raw LLM request body, full context snapshot | **no** — not reachable from the plugin layer |
| panel inside the TUI | **no** — `PluginModule.tui` is `never`, there is no injection point |
| sub-agents, retries, permissions, compaction, file diffs | **yes**, all captured |

If you need true interactive forking inside the framework, that is DeepSeek Harness's territory, not this plugin's. This is post-mortem replay and external visualization.

## Performance

A 100-turn session lands around 1–3MB. Append is `appendFileSync` per flush (sub-millisecond), so the recorder does not show up in your tool latencies.

---

# 中文版 v0.1.0

给 OpenCode 用的**只增不改的轨迹记录器** + 零依赖离线查看器。每一次消息、工具调用、请求载荷、token 与耗时全部落盘，可以按真实时间轴逐帧回放。

**它解决什么：** OpenCode 自带 session、`opencode debug`、share link 和父子 agent 导航，但没有一条把「载荷 + 耗时 + token + 来源」放在一起的时间线。想回答"第 7 步那个 bash 到底收到了什么、返回了什么、为什么花了 4 秒"，得手工在几个视图之间来回拼。这个插件把这件事变成一行一事件。

**安装（三行）：**

```bash
node scripts/install.mjs   # 装到全局插件目录
# 重启 opencode
traj                       # 打开 http://127.0.0.1:7777
```

**特点：**

- 轨迹视图（默认）——序号 / 相对时间 / 来源轨 / 标签 / 内容 / 耗时 / 状态，工具「调用」和「结果」拆成两行，中间的空档就是真实延迟。
- 只挂 `event` + `chat.message` 两个只读钩子，不改 `output`、不抛错，插件挂了你的会话也不受影响。
- 默认脱敏（`sk-*`、`Bearer`、JWT、`apiKey` 字段），payload 截断 20KB。
- 全程不出网：没有遥测、没有 OTLP、没有外部账号，纯本地文件。
- `traj export` 导出的单文件 HTML 把数据和折叠逻辑一起内联，`file://` 直接打开，可以直接丢给别人。

**集成到自有系统：** 见 [INTEGRATION.md](https://github.com/allen-iwen/opencode-trajectory/blob/main/INTEGRATION.md)，三种形态（iframe / 单文件导出 / 直接读 JSONL），含内嵌 opencode 部署与多租户存储。

**已知边界：** 不支持 fork 与节点级重放（只读记录器）；拿不到原始 LLM 请求体与完整上下文快照；不能往 TUI 里插面板（`PluginModule.tui: never`）。需要真正的分叉重跑，请用 DeepSeek Harness。

**MIT License.** 有问题直接开 issue，附上 `traj export` 出来的 HTML 最快。
