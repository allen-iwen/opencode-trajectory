import { test } from "node:test"
import assert from "node:assert/strict"
import { Normalizer } from "../src/normalize.ts"
import { redactText, redactValue, clip } from "../src/redact.ts"
import { resolveConfig } from "../src/config.ts"

const cfg = resolveConfig({}, "/tmp/proj")
const mk = () => new Normalizer(cfg)

const foldText = (recs) => {
  const acc = new Map()
  for (const r of recs) {
    if (r.k !== "text" && r.k !== "reasoning") continue
    if (r.r) acc.set(r.pid, "")
    acc.set(r.pid, (acc.get(r.pid) ?? "") + r.d)
  }
  return acc
}

test("streamed text is deduped and folds back to full content", () => {
  const n = mk()
  const sessionID = "s1"
  const messageID = "m1"
  const pid = "p1"
  const out = []
  const text = "x".repeat(1000)
  for (let i = 0; i < text.length; i += 7) {
    out.push(...n.event({
      type: "message.part.updated",
      properties: { part: { id: pid, sessionID, messageID, type: "text", text: text.slice(0, i) } },
    }))
  }
  out.push(...n.flushPending())

  const folded = foldText(out).get(pid)
  // last emitted snapshot is text.slice(0,994) (loop step is 7)
  assert.equal(folded, text.slice(0, 994))
  // 1000 chars / 96 per record => ~11 records, far below 143 raw events
  assert.ok(out.length < 20, `expected few records, got ${out.length}`)
})

test("a rewritten part emits a reset record and folds correctly", () => {
  const n = mk()
  const p = (t) => ({ type: "message.part.updated", properties: { part: { id: "p", sessionID: "s", messageID: "m", type: "text", text: t } } })
  const out = [...n.event(p("hello world")), ...n.event(p("goodbye world"))]
  const recs = out.filter((r) => r.k === "text")
  assert.equal(recs.at(-1).r, 1)
  assert.equal(foldText(out).get("p"), "goodbye world")
})

test("tool state transitions are deduped and terminal states are final", () => {
  const n = mk()
  const part = (state) => ({
    type: "message.part.updated",
    properties: { part: { id: "tp", sessionID: "s", messageID: "m", type: "tool", callID: "c1", tool: "bash", state } },
  })
  const out = [
    ...n.event(part({ status: "pending", input: { command: "ls" }, raw: "" })),
    ...n.event(part({ status: "running", input: { command: "ls" }, time: { start: 10 } })),
    ...n.event(part({ status: "running", input: { command: "ls" }, time: { start: 10 } })),
    ...n.event(part({ status: "completed", input: { command: "ls" }, output: "a\nb", title: "ls", metadata: {}, time: { start: 10, end: 42 } })),
    ...n.event(part({ status: "completed", input: { command: "ls" }, output: "a\nb", title: "ls", metadata: {}, time: { start: 10, end: 42 } })),
  ].filter((r) => r.k === "tool")

  assert.equal(out.length, 3)
  assert.deepEqual(out.map((r) => r.st), ["pending", "running", "completed"])
  assert.equal(out[2].t1, 42)
  assert.equal(out[2].output, "a\nb")
})

test("user turn from chat.message is captured once and not duplicated by events", () => {
  const n = mk()
  const turn = n.userTurn(
    { sessionID: "s" },
    { message: { id: "u1", role: "user", agent: "build", time: { created: 1 } }, parts: [{ id: "up", type: "text", text: "写个插件" }] },
  )
  assert.equal(turn.length, 2) // message record + one text record
  assert.equal(turn[0].k, "message")
  assert.equal(turn[0].role, "user")
  assert.equal(turn[1].k, "text")
  assert.equal(turn[1].mid, "u1")
  // duplicate hook fire
  assert.equal(n.userTurn({ sessionID: "s" }, { message: { id: "u1" }, parts: [] }).length, 0)
  // stream event for the same user part must be skipped
  const ev = n.event({ type: "message.part.updated", properties: { part: { id: "up", sessionID: "s", messageID: "u1", type: "text", text: "写个插件" } } })
  assert.equal(ev.length, 0)
})

test("assistant message updates coalesce but always keep the final state", () => {
  const n = mk()
  const info = (extra) => ({
    type: "message.updated",
    properties: {
      info: { id: "a1", sessionID: "s", role: "assistant", mode: "build", providerID: "p", modelID: "m", time: { created: 1 }, cost: 0, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, ...extra },
    },
  })
  const out = [
    ...n.event(info({})),
    ...n.event(info({ tokens: { input: 20, output: 9, reasoning: 0, cache: { read: 3, write: 0 } } })),
    ...n.event(info({ tokens: { input: 20, output: 9, reasoning: 0, cache: { read: 3, write: 0 } }, time: { created: 1, completed: 99 }, finish: "stop", cost: 0.01 })),
  ].filter((r) => r.k === "message")
  assert.equal(out.length, 2)
  assert.equal(out.at(-1).finish, "stop")
  assert.equal(out.at(-1).tokens.cacheRead, 3)
  assert.equal(out.at(-1).agent, "build")
})

test("secrets are scrubbed from text, tool input and tool output", () => {
  assert.match(redactText('curl -H "Authorization: Bearer sk-MNdMIW0wakxPYRERiJ2Ovr2azsciL5ktTx8bWujesQmCPeDe"'), /\*\*\*REDACTED\*\*\*/)
  assert.ok(!redactText("key sk-abcdef1234567890").includes("abcdef1234567890"))
  assert.equal((redactValue({ apiKey: "sk-live-999999999999" })).apiKey.includes("999999999999"), false)
  assert.match(redactText("postgres://admin:hunter2@db.local/x"), /admin:\*\*\*REDACTED\*\*\*@/)

  const n = mk()
  const out = n.event({
    type: "message.part.updated",
    properties: { part: { id: "t", sessionID: "s", messageID: "m", type: "tool", callID: "c", tool: "bash", state: { status: "completed", input: { command: "export KEY=sk-abcdef1234567890" }, output: "sk-abcdef1234567890", title: "x", metadata: {}, time: { start: 1, end: 2 } } } },
  })
  const line = JSON.stringify(out)
  assert.ok(!line.includes("abcdef1234567890"), "secret leaked into record")
})

test("huge tool output is clipped with an explicit marker", () => {
  const n = mk()
  const big = "L".repeat(50_000)
  const out = n.event({
    type: "message.part.updated",
    properties: { part: { id: "t2", sessionID: "s", messageID: "m", type: "tool", callID: "c", tool: "bash", state: { status: "completed", input: {}, output: big, title: "x", metadata: {}, time: { start: 1, end: 2 } } } },
  })
  assert.equal(out[0].clipped.output, true)
  assert.ok(out[0].output.length <= cfg.maxPayloadChars + 200)
  assert.match(out[0].output, /clipped/)
})

test("relationship events: parent session, subtask, permission, retry, error", () => {
  const n = mk()
  const session = n.event({ type: "session.created", properties: { info: { id: "child", parentID: "root", title: "sub", directory: "/p" } } })
  assert.equal(session[0].parentID, "root")

  const retry = n.event({ type: "session.status", properties: { sessionID: "s", status: { type: "retry", attempt: 2, message: "429", next: 5 } } })
  assert.equal(retry[0].st, "retry")
  assert.equal(retry[0].attempt, 2)

  const perm = n.event({ type: "permission.updated", properties: { id: "perm1", sessionID: "s", type: "bash", title: "run rm", pattern: ["rm"] } })
  assert.equal(perm[0].ph, "asked")

  const err = n.event({ type: "session.error", properties: { sessionID: "s", error: { name: "ProviderAuthError", data: { message: "bad key" } } } })
  assert.equal(err[0].name, "ProviderAuthError")
  assert.equal(err[0].message, "bad key")
})

test("malformed events never throw", () => {
  const n = mk()
  for (const bad of [null, undefined, 1, "x", {}, { type: 5 }, { type: "message.part.updated" }, { type: "message.part.updated", properties: { part: { type: "text" } } }]) {
    assert.doesNotThrow(() => n.event(bad))
  }
})

test("GlobalEvent wrapper is unwrapped", () => {
  const n = mk()
  const out = n.event({ directory: "/p", payload: { type: "session.idle", properties: { sessionID: "s" } } })
  assert.equal(out[0].k, "status")
})

test("status records collapse consecutive duplicates", () => {
  const n = mk()
  const out = [
    ...n.event({ type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } }),
    ...n.event({ type: "session.status", properties: { sessionID: "s", status: { type: "busy" } } }),
    // session.status{idle} and session.idle describe the same transition
    ...n.event({ type: "session.status", properties: { sessionID: "s", status: { type: "idle" } } }),
    ...n.event({ type: "session.idle", properties: { sessionID: "s" } }),
    ...n.event({ type: "session.status", properties: { sessionID: "s", status: { type: "retry", attempt: 1, message: "429", next: 1 } } }),
    ...n.event({ type: "session.status", properties: { sessionID: "s", status: { type: "retry", attempt: 2, message: "429", next: 1 } } }),
  ].filter((r) => r.k === "status")
  assert.deepEqual(out.map((r) => r.st), ["busy", "idle", "retry", "retry"])
})

test("a user message replayed by the event stream is not duplicated", () => {
  const n = mk()
  n.userTurn({ sessionID: "s" }, { message: { id: "u1", role: "user", time: { created: 5 } }, parts: [{ id: "p1", type: "text", text: "hi" }] })
  const replay = n.event({
    type: "message.updated",
    properties: { info: { id: "u1", sessionID: "s", role: "user", time: { created: 5 }, agent: "build" } },
  })
  const msgs = replay.filter((r) => r.k === "message")
  assert.equal(msgs.length, 0, "user message must be recorded exactly once")
})

test("primed session metadata is written lazily, never for idle history", () => {
  const n = mk()
  n.primeSessions([
    { id: "ghost", title: "months-old session", parentID: "p" },
    { id: "live", title: "current", parentID: "root" },
  ])
  assert.equal(n.flushPending().length, 0, "priming alone must not emit anything")

  const out = n.event({ type: "session.status", properties: { sessionID: "live", status: { type: "busy" } } })
  assert.equal(out[0].k, "session", "metadata emitted before the first real record")
  assert.equal(out[0].id, "live")
  assert.equal(out[0].parentID, "root")
  assert.equal(out[1].k, "status")

  const more = n.event({ type: "session.status", properties: { sessionID: "live", status: { type: "idle" } } })
  assert.equal(more.filter((r) => r.k === "session").length, 0, "metadata is written once")

  // a session that never produces events leaves no trace
  const ghost = n.event({ type: "session.status", properties: { sessionID: "unknown-ghost", status: { type: "busy" } } })
  assert.equal(ghost.filter((r) => r.k === "session").length, 0)
})
