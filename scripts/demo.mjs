#!/usr/bin/env node
/**
 * Generate a realistic demo journal so the viewer can be evaluated before
 * wiring the plugin into a real session.
 *
 *   node scripts/demo.mjs [--dir .opencode/trajectory] [--clean]
 *
 * Goes through the real Normalizer + Store code path (not hand-written JSONL)
 * so the demo can never drift from the actual on-disk format. A virtual clock
 * keeps the timestamps spread out like a real conversation.
 */
import fs from "node:fs"
import path from "node:path"
import { Store } from "../src/store.ts"
import { Normalizer } from "../src/normalize.ts"
import { resolveConfig } from "../src/config.ts"

const args = process.argv.slice(2)
const dirArg = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : ".opencode/trajectory-demo"
const root = path.resolve(process.cwd(), dirArg)

if (args.includes("--clean") && fs.existsSync(root)) {
  fs.rmSync(root, { recursive: true, force: true })
  console.log(`removed ${root}`)
}

const cfg = resolveConfig({}, process.cwd())
const store = new Store(root, cfg)
const n = new Normalizer(cfg)

// ---- virtual clock -------------------------------------------------------
const realNow = Date.now
let vt = realNow() - 14 * 60 * 1000
Date.now = () => vt
const tick = (ms) => {
  vt += ms
}
const T = () => vt

// ---- shorthands ----------------------------------------------------------
const ROOT = "ses_demo_root_7f3a"
const CHILD = "ses_demo_child_c91b"

const session = (id, extra) =>
  n.event({
    type: "session.created",
    properties: {
      info: { id, projectID: "p_demo", directory: process.cwd(), title: "", time: { created: T(), updated: T() }, version: "1.18.26", ...extra },
    },
  })

const userTurn = (sid, mid, text) =>
  n.userTurn({ sessionID: sid, agent: "build" }, { message: { id: mid, sessionID: sid, role: "user", agent: "build", time: { created: T() }, model: { providerID: "packycode", modelID: "gpt-5.4" } }, parts: [{ id: mid + "_p1", type: "text", text }] })

const assistantStart = (sid, mid, model) =>
  n.event({
    type: "message.updated",
    properties: {
      info: { id: mid, sessionID: sid, role: "assistant", mode: "build", providerID: model[0], modelID: model[1], parentID: mid + "_parent", time: { created: T() }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    },
  })

const assistantEnd = (sid, mid, model, t) =>
  n.event({
    type: "message.updated",
    properties: {
      info: { id: mid, sessionID: sid, role: "assistant", mode: "build", providerID: model[0], modelID: model[1], parentID: mid + "_parent", time: { created: t, completed: T() }, cost: 0.0142, tokens: { input: 18420, output: 612, reasoning: 1288, cache: { read: 9216, write: 0 } }, finish: "stop" },
    },
  })

/** Stream a text part in chunks so the viewer sees realistic growth. */
const stream = (sid, mid, pid, full, kind) => {
  const out = []
  const step = Math.max(1, Math.floor(full.length / 6))
  for (let i = step; i <= full.length; i += step) {
    tick(90)
    out.push(...n.event({ type: "message.part.updated", properties: { part: { id: pid, sessionID: sid, messageID: mid, type: kind, text: full.slice(0, i), time: { start: T() } } } }))
  }
  tick(120)
  out.push(...n.event({ type: "message.part.updated", properties: { part: { id: pid, sessionID: sid, messageID: mid, type: kind, text: full, time: { start: T(), end: T() } } } }))
  return out
}

const tool = (sid, mid, pid, callID, name, args, output, t0, t1, extra) =>
  n.event({
    type: "message.part.updated",
    properties: {
      part: {
        id: pid,
        sessionID: sid,
        messageID: mid,
        type: "tool",
        callID,
        tool: name,
        state: { status: "completed", input: args, output, title: extra?.title || name, metadata: {}, time: { start: t0, end: t1 } },
      },
    },
  })

const write = (recs) => store.write(recs)

// =========================================================================
// 1. root session — a config investigation with a sub-agent
// =========================================================================
write(session(ROOT, { title: "排查 kimi provider 的 401" }))
tick(120)
write(n.event({ type: "session.status", properties: { sessionID: ROOT, status: { type: "busy" } } }))
tick(60)
write(userTurn(ROOT, "msg_u1", "帮我看下 opencode.json 里 kimi 的 baseURL，一直 401，是不是配错了？"))

tick(380)
const tA1 = T()
write(assistantStart(ROOT, "msg_a1", ["packycode", "gpt-5.4"]))
tick(40)
write(n.event({ type: "message.part.updated", properties: { part: { id: "msg_a1_s1", sessionID: ROOT, messageID: "msg_a1", type: "step-start", snapshot: "snap_001" } } }))

write(
  stream(
    ROOT,
    "msg_a1",
    "msg_a1_r1",
    "用户说 kimi 一直 401。401 是认证失败，不是地址错误——先别急着改 baseURL，得先确认 key 本身有效。\n\n两种可能：\n1. key 过期或被撤销\n2. baseURL 指向了不接受这个 key 的端点\n\n先读配置看当前值，再用最小请求验证。",
    "reasoning",
  ),
)

write(stream(ROOT, "msg_a1", "msg_a1_t1", "先定位配置文件，确认 kimi 这一段实际生效的内容。", "text"))

tick(200)
const g0 = T()
tick(140)
write(tool(ROOT, "msg_a1", "msg_a1_tool1", "call_glob_1", "glob", { pattern: "**/opencode.json", path: process.cwd() }, "/Users/me/.config/opencode/opencode.json", g0, T(), { title: "**/opencode.json (1 match)" }))

tick(180)
const r0 = T()
tick(12)
write(
  tool(
    ROOT,
    "msg_a1",
    "msg_a1_tool2",
    "call_read_1",
    "read",
    { filePath: "~/.config/opencode/opencode.json" },
    JSON.stringify(
      {
        provider: {
          kimi: {
            npm: "@ai-sdk/openai-compatible",
            options: { apiKey: "sk-kimi-DEMOKEY0000000000000000000000000000000000000000", baseURL: "https://api.moonshot.ai/v1" },
            models: { "kimi-k2.5": { name: "Kimi K2.5" } },
          },
        },
        model: "kimi/kimi-k2.5",
      },
      null,
      2,
    ),
    r0,
    T(),
    { title: "opencode.json (14 lines)" },
  ),
)

write(
  stream(
    ROOT,
    "msg_a1",
    "msg_a1_t2",
    "配置本身是合法的：\n\n```json\n\"baseURL\": \"https://api.moonshot.ai/v1\"\n```\n\n这个地址对应的是 Moonshot 开放平台。问题在于你这把 key 是 `sk-kimi-` 前缀的 Coding Plan key，它只认 `api.kimi.com/coding/v1` 这个端点，拿去请求开放平台必然是 401。\n\n我起一个子任务实测一下连通性，避免只靠推断。",
    "text",
  ),
)

tick(150)
write(n.event({ type: "message.part.updated", properties: { part: { id: "msg_a1_s1", sessionID: ROOT, messageID: "msg_a1", type: "step-finish", reason: "tool-calls", cost: 0.0081, tokens: { input: 9210, output: 322, reasoning: 640, cache: { read: 4608, write: 0 } }, snapshot: "snap_002" } } }))

tick(80)
write(n.event({ type: "message.part.updated", properties: { part: { id: "msg_a1_sub", sessionID: ROOT, messageID: "msg_a1", type: "subtask", agent: "general", description: "验证 mooonshot 端点连通性与 key 有效性", prompt: "用 curl 请求 https://api.moonshot.ai/v1/models，带上 opencode.json 里 kimi 的 key，只报告 HTTP 状态码，不要打印 key。" } } }))

// ---- child session ------------------------------------------------------
tick(200)
write(session(CHILD, { parentID: ROOT, title: "验证 kimi 端点连通性" }))
tick(100)
write(userTurn(CHILD, "msg_cu1", "用 curl 请求 https://api.moonshot.ai/v1/models，带上 kimi 的 key，只报告状态码。"))
tick(300)
write(assistantStart(CHILD, "msg_ca1", ["packycode", "gpt-5.4"]))
const c0 = T()
tick(2100)
write(
  tool(
    CHILD,
    "msg_ca1",
    "msg_ca1_tool1",
    "call_bash_child",
    "bash",
    { command: "curl -s -o /dev/null -w '%{http_code}' https://api.moonshot.ai/v1/models -H \"Authorization: Bearer sk-kimi-DEMOKEY0000000000000000000000000000000000000000\"", description: "probe kimi endpoint" },
    "401",
    c0,
    T(),
    { title: "curl → 401" },
  ),
)
write(stream(CHILD, "msg_ca1", "msg_ca1_t1", "返回 `401`。服务可达，但 key 不被开放平台接受——和推断一致：key 与端点不匹配。\n\n结论：把 `baseURL` 改成 `https://api.kimi.com/coding/v1` 即可，key 不用动。", "text"))
tick(120)
write(n.event({ type: "message.part.updated", properties: { part: { id: "msg_ca1_s1", sessionID: CHILD, messageID: "msg_ca1", type: "step-finish", reason: "stop", cost: 0.0021, tokens: { input: 3120, output: 140, reasoning: 0, cache: { read: 0, write: 0 } } } } }))
write(assistantEnd(CHILD, "msg_ca1", ["packycode", "gpt-5.4"], c0))
tick(80)
write(n.event({ type: "session.idle", properties: { sessionID: CHILD } }))

// ---- back to root: permission gate, then the fix ------------------------
tick(400)
write(
  n.event({
    type: "permission.updated",
    properties: { id: "perm_1", sessionID: ROOT, type: "bash", title: "运行 curl 探测 kimi 端点", pattern: ["curl *"], messageID: "msg_a1", time: { created: T() } },
  }),
)
tick(1500)
write(n.event({ type: "permission.replied", properties: { sessionID: ROOT, permissionID: "perm_1", response: "allow" } }))

tick(200)
write(
  stream(
    ROOT,
    "msg_a1",
    "msg_a1_t3",
    "实测确认了：`401`，服务通但 key 不被该端点接受。\n\n我已经把 `baseURL` 改成 Coding Plan 的端点，key 保持不变。",
    "text",
  ),
)
const e0 = T()
tick(30)
write(
  tool(
    ROOT,
    "msg_a1",
    "msg_a1_tool3",
    "call_edit_1",
    "edit",
    { filePath: "~/.config/opencode/opencode.json", oldString: "\"baseURL\": \"https://api.moonshot.ai/v1\"", newString: "\"baseURL\": \"https://api.kimi.com/coding/v1\"" },
    "Edit applied successfully.",
    e0,
    T(),
    { title: "opencode.json +1 −1" },
  ),
)
write(n.event({ type: "file.edited", properties: { sessionID: ROOT, file: "~/.config/opencode/opencode.json" } }))
write(assistantEnd(ROOT, "msg_a1", ["packycode", "gpt-5.4"], tA1))

// =========================================================================
// 2. second turn — a tool failure, a retry, a provider error
// =========================================================================
tick(3000)
write(userTurn(ROOT, "msg_u2", "改完了，再跑一次验证。另外把刚才那把 key 记到 .env 里备份一下"))
tick(400)
const tA2 = T()
write(assistantStart(ROOT, "msg_a2", ["packycode", "gpt-5.4"]))
write(
  stream(
    ROOT,
    "msg_a2",
    "msg_a2_r1",
    "第二个需求有问题：把 key 写进 .env 会增加泄露面，而且这个仓库要提交。先做验证，备份的事最后单独说。",
    "reasoning",
  ),
)
const b0 = T()
tick(2600)
write(
  n.event({
    type: "message.part.updated",
    properties: {
      part: {
        id: "msg_a2_tool1",
        sessionID: ROOT,
        messageID: "msg_a2",
        type: "tool",
        callID: "call_bash_2",
        tool: "bash",
        state: { status: "error", input: { command: "source .env && curl -s https://api.kimi.com/coding/v1/models", description: "verify kimi coding endpoint" }, error: "Command timed out after 30s. The command may be waiting for input — try adding -s or redirecting stdin.", metadata: {}, time: { start: b0, end: T() } },
      },
    },
  }),
)

tick(150)
write(n.event({ type: "session.status", properties: { sessionID: ROOT, status: { type: "retry", attempt: 1, message: "429 Too Many Requests: retrying in 5s", next: 5000 } } }))
tick(5000)
write(n.event({ type: "session.status", properties: { sessionID: ROOT, status: { type: "busy" } } }))

const b1 = T()
tick(700)
write(
  tool(
    ROOT,
    "msg_a2",
    "msg_a2_tool2",
    "call_bash_3",
    "bash",
    { command: "curl -s -o /dev/null -w '%{http_code}' https://api.kimi.com/coding/v1/models -H \"Authorization: Bearer $KIMI_KEY\"", description: "verify kimi coding endpoint" },
    "200",
    b1,
    T(),
    { title: "curl → 200" },
  ),
)
write(
  stream(
    ROOT,
    "msg_a2",
    "msg_a2_t1",
    "`200`。端点换对了。\n\n关于备份 key：不建议写进仓库里的 `.env`。用 `~/.config/opencode/.env` 或者系统的密钥管理，并在 `.gitignore` 里排除。",
    "text",
  ),
)
write(n.event({ type: "message.part.updated", properties: { part: { id: "msg_a2_s1", sessionID: ROOT, messageID: "msg_a2", type: "step-finish", reason: "stop", cost: 0.0061, tokens: { input: 9210, output: 290, reasoning: 648, cache: { read: 4608, write: 0 } } } } }))
write(assistantEnd(ROOT, "msg_a2", ["packycode", "gpt-5.4"], tA2))

// a provider-side auth error on a later turn, then compaction
tick(4000)
write(n.event({ type: "session.error", properties: { sessionID: ROOT, error: { name: "ProviderAuthError", data: { providerID: "kimi", message: "401 Unauthorized: invalid api key for provider kimi" } } } }))
tick(200)
write(n.event({ type: "session.compacted", properties: { sessionID: ROOT } }))
tick(120)
write(n.event({ type: "session.idle", properties: { sessionID: ROOT } }))
write(n.flushPending())
store.close()

Date.now = realNow

console.log(`demo journal written to ${root}`)
console.log(`  sessions: ${ROOT} (parent), ${CHILD} (sub-agent)`)
console.log(`  records : ${fs.readdirSync(path.join(root, "sessions")).map((f) => `${f} ${(fs.statSync(path.join(root, "sessions", f)).size / 1024).toFixed(1)}KB`).join(", ")}`)
console.log("")
console.log("  view it: node bin/cli.mjs serve --open")
