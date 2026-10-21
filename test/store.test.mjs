import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Store } from "../src/store.ts"
import { Normalizer } from "../src/normalize.ts"
import { resolveConfig } from "../src/config.ts"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "traj-"))

test("records are appended as valid JSONL with monotonic seq", () => {
  const dir = tmp()
  const cfg = resolveConfig({}, dir)
  const store = new Store(path.join(dir, "t"), cfg)
  const n = new Normalizer(cfg)

  store.write(n.event({ type: "session.created", properties: { info: { id: "ses_a", title: "demo", directory: dir } } }))
  store.write(n.event({ type: "session.idle", properties: { sessionID: "ses_a" } }))
  store.close()

  const file = path.join(dir, "t", "sessions", "ses_a.jsonl")
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].k, "session")
  assert.equal(lines[0].v, 1)
  assert.ok(lines[1].seq > lines[0].seq)
  assert.equal(lines[1].st, "idle")
  assert.ok(fs.existsSync(path.join(dir, "t", "_boot.log")))
})

test("session ids are sanitized and never escape the sessions dir", () => {
  const dir = tmp()
  const cfg = resolveConfig({}, dir)
  const store = new Store(path.join(dir, "t"), cfg)
  const n = new Normalizer(cfg)
  store.write(n.event({ type: "session.created", properties: { info: { id: "../../etc/passwd", title: "x" } } }))
  store.close()
  const files = fs.readdirSync(path.join(dir, "t", "sessions"))
  assert.equal(files.length, 1)
  assert.ok(!files[0].includes("/") && !files[0].includes(".."))
})

test("journals rotate past the size ceiling and say so", () => {
  const dir = tmp()
  const cfg = resolveConfig({ maxFileBytes: 256 * 1024 }, dir)
  const store = new Store(path.join(dir, "t"), cfg)
  const n = new Normalizer(cfg)
  const big = "z".repeat(3000)
  for (let i = 0; i < 200; i++) {
    store.write(
      n.event({
        type: "message.part.updated",
        properties: {
          part: { id: `p${i}`, sessionID: "s", messageID: "m", type: "tool", callID: `c${i}`, tool: "bash", state: { status: "completed", input: {}, output: big, title: "t", metadata: {}, time: { start: 1, end: 2 } } },
        },
      }),
    )
  }
  store.close()
  const files = fs.readdirSync(path.join(dir, "t", "sessions"))
  assert.ok(files.includes("s.1.jsonl"), `expected rotation, got ${files.join(",")}`)
  assert.ok(files.includes("s.jsonl"))
})

test("writes after close are ignored instead of throwing", () => {
  const dir = tmp()
  const cfg = resolveConfig({}, dir)
  const store = new Store(path.join(dir, "t"), cfg)
  store.close()
  assert.doesNotThrow(() => store.write([{ k: "status", sid: "s", st: "idle" }]))
})

test("end-to-end: a simulated turn folds into a coherent journal", () => {
  const dir = tmp()
  const cfg = resolveConfig({}, dir)
  const store = new Store(path.join(dir, "t"), cfg)
  const n = new Normalizer(cfg)

  store.write(n.userTurn({ sessionID: "s", agent: "build" }, { message: { id: "u1", role: "user", agent: "build", time: { created: 1 } }, parts: [{ id: "up", type: "text", text: "read the config" }] }))
  store.write(n.event({ type: "message.part.updated", properties: { part: { id: "a1p1", sessionID: "s", messageID: "a1", type: "text", text: "I'll read it." } } }))
  store.write(n.event({ type: "message.part.updated", properties: { part: { id: "a1t1", sessionID: "s", messageID: "a1", type: "tool", callID: "c1", tool: "read", state: { status: "completed", input: { filePath: "opencode.json" }, output: '{"model":"x"}', title: "opencode.json", metadata: {}, time: { start: 10, end: 25 } } } } }))
  store.write(n.event({ type: "message.part.updated", properties: { part: { id: "a1s1", sessionID: "s", messageID: "a1", type: "step-finish", reason: "tool-calls", cost: 0.002, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 50, write: 0 } } } } }))
  store.write(n.event({ type: "message.updated", properties: { info: { id: "a1", sessionID: "s", role: "assistant", mode: "build", providerID: "p", modelID: "m", time: { created: 2, completed: 30 }, cost: 0.002, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 50, write: 0 } }, finish: "stop" } } }))
  store.write(n.event({ type: "session.idle", properties: { sessionID: "s" } }))
  store.write(n.flushPending())
  store.close()

  const lines = fs.readFileSync(path.join(dir, "t", "sessions", "s.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const kinds = lines.map((l) => l.k)
  assert.ok(kinds.includes("text"))
  assert.ok(kinds.includes("tool"))
  assert.ok(kinds.includes("step"))
  assert.ok(kinds.includes("message"))

  const tool = lines.find((l) => l.k === "tool")
  assert.equal(tool.t1 - tool.t0, 15)
  const step = lines.find((l) => l.k === "step")
  assert.equal(step.tokens.cacheRead, 50)
  const msg = lines.find((l) => l.k === "message" && l.role === "assistant")
  assert.equal(msg.finish, "stop")
  assert.equal(msg.agent, "build")
})
