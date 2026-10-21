/**
 * Viewer regression test.
 *
 * The viewer is the part most likely to break silently: a typo in a render
 * function throws inside a callback and the page just shows an empty main area.
 * Loading the real HTML in jsdom and asserting on the resulting DOM catches
 * both script errors and layout regressions without a browser in CI.
 *
 * The viewer has two projections of the same journal — the trajectory stream
 * (default) and the chat transcript — so both are exercised here.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { JSDOM, VirtualConsole } from "jsdom"
import { fold, trajectory } from "../src/fold.js"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const html = fs.readFileSync(path.join(root, "viewer", "index.html"), "utf8")
const foldSrc = fs.readFileSync(path.join(root, "src", "fold.js"), "utf8").replace(/^export\s+/gm, "")

/** Build the same page export/serve produces, with data inlined. */
function page(records) {
  let out = html.replace("/*__FOLD__*/", () => foldSrc.replace(/<\/script/gi, "<\\/script"))
  const payload = JSON.stringify({ records, project: "/demo", version: "test" }).replace(/</g, "\\u003c")
  return out.replace("/*__DATA__*/", () => payload)
}

const readDemo = () => {
  const dir = path.join(root, ".opencode", "trajectory-demo", "sessions")
  if (!fs.existsSync(dir)) return null
  let out = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue
    out = out.concat(
      fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    )
  }
  return out
}

async function mount(records) {
  const errors = []
  const vc = new VirtualConsole()
  vc.on("jsdomError", (e) => errors.push(e))
  vc.on("error", (...a) => errors.push(new Error(String(a[0]))))

  const dom = new JSDOM(page(records), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    url: "http://localhost/",
  })
  // The viewer never calls fetch for inline data, but keep it from throwing if
  // a future code path does.
  dom.window.fetch = () => Promise.reject(new Error("no network in test"))
  dom.window.HTMLElement.prototype.scrollIntoView = function () {}
  // Give the async load() a few microtask turns to finish.
  await new Promise((r) => setTimeout(r, 60))
  return { dom, doc: dom.window.document, errors }
}

async function switchView(dom, doc, v) {
  const btn = doc.querySelector('#vswitch button[data-v="' + v + '"]')
  assert.ok(btn, "view switch button exists: " + v)
  btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 40))
}

/* ------------------------------- trajectory ------------------------------- */

test("trajectory stream renders one tagged line per event", async (t) => {
  const records = readDemo()
  if (!records) return t.skip("run `node scripts/demo.mjs` first")

  const { dom, doc, errors } = await mount(records)
  assert.deepEqual(errors.map(String), [], "viewer must not throw")

  const rows = doc.querySelectorAll(".ev")
  assert.ok(rows.length >= 10, "event rows rendered, got " + rows.length)

  // Source coverage: the point of the audit view is that origins stay distinct.
  for (const src of ["user", "tool", "result"]) {
    assert.ok(doc.querySelector(".ev.src-" + src), "row with source " + src)
  }
  assert.ok(doc.querySelectorAll(".tag").length >= rows.length, "every row carries a tag")

  // Ordering: seq column must be strictly ascending down the page.
  const seqs = [...clockColumns(doc)]
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b), "rows are in event order")

  // Columns: relative clock, source tag, body text, meta.
  assert.match(doc.querySelector(".ev .tm").textContent, /^\+?\d+\.\d{3}$/)
  assert.ok(doc.getElementById("replaybar").classList.contains("hidden") === false, "replay bar visible")

  dom.window.close()
})

function clockColumns(doc) {
  return [...doc.querySelectorAll(".ev .seq")].map((n) => Number(n.textContent))
}

test("clicking an event opens the payload drawer with a folding tree", async (t) => {
  const records = readDemo()
  if (!records) return t.skip("run `node scripts/demo.mjs` first")
  const { dom, doc, errors } = await mount(records)

  const call = doc.querySelector(".ev.src-tool")
  call.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 40))

  const drawer = doc.getElementById("drawer")
  assert.ok(drawer.classList.contains("open"), "drawer opens")
  assert.match(drawer.textContent, /调用参数/, "tool call shows its arguments")
  assert.ok(drawer.querySelector(".js"), "payload rendered as a json tree")
  assert.match(drawer.textContent, /messageID/, "locating ids exposed")
  assert.match(drawer.textContent, /分叉锚点/, "fork anchor offered")

  // Collapsing a node must not throw and must hide its children.
  const caret = drawer.querySelector(".js .caret")
  caret.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 20))

  assert.ok(!drawer.textContent.includes("mDVNfsbCZfMR0"), "no secret leaked into the drawer")
  assert.deepEqual(errors.map(String), [])
  dom.window.close()
})

test("source filter and search narrow the stream", async (t) => {
  const records = readDemo()
  if (!records) return t.skip("run `node scripts/demo.mjs` first")
  const { dom, doc, errors } = await mount(records)

  const total = doc.querySelectorAll(".ev").length
  const chip = [...doc.querySelectorAll(".chip")].find((c) => /工具调用/.test(c.textContent))
  assert.ok(chip, "tool source chip present")
  chip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 40))

  const after = doc.querySelectorAll(".ev").length
  assert.ok(after > 0 && after < total, `filter narrows the stream (${total} -> ${after})`)

  const input = doc.querySelector(".search")
  input.value = "zzz-definitely-absent"
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 260))
  assert.equal(doc.querySelectorAll(".ev").length, 0, "no rows match a nonsense query")
  assert.deepEqual(errors.map(String), [])
  dom.window.close()
})

test("replay scrubs the stream to a point in time", async (t) => {
  const records = readDemo()
  if (!records) return t.skip("run `node scripts/demo.mjs` first")
  const { dom, doc, errors } = await mount(records)

  const range = doc.querySelector('#replaybar input[type="range"]')
  assert.ok(range, "scrubber present")

  const visible = () => [...doc.querySelectorAll(".ev")].filter((e) => e.style.display !== "none").length
  const all = visible()
  assert.ok(all > 2)

  range.value = "0"
  range.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 30))

  const few = visible()
  assert.ok(few >= 1 && few < all, `scrubbing back hides rows (${all} -> ${few})`)
  assert.match(doc.getElementById("replaycount").textContent, /\/ \d+/)

  range.value = "1000"
  range.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(visible(), all, "scrubbing forward restores every row")
  assert.deepEqual(errors.map(String), [])
  dom.window.close()
})

/* --------------------------------- chat ---------------------------------- */

test("chat view still renders messages, tools and stats", async (t) => {
  const records = readDemo()
  if (!records) return t.skip("run `node scripts/demo.mjs` first")

  const { dom, doc, errors } = await mount(records)
  await switchView(dom, doc, "chat")

  assert.equal(doc.querySelectorAll("#sesslist .sess").length, 2, "two sessions in sidebar")
  assert.ok(doc.querySelectorAll(".tool").length >= 5, "tool cards rendered")
  assert.ok(doc.querySelectorAll(".reason").length >= 2, "reasoning blocks rendered")
  assert.ok(doc.querySelector(".msg.user"), "user bubble rendered")
  assert.ok(doc.querySelector(".step-line"), "step separator rendered")
  assert.ok(doc.querySelector(".waterfall"), "waterfall rendered")
  assert.ok(doc.querySelector(".note.err, .tool.err"), "error surfaced")
  assert.match(doc.getElementById("topstats").textContent, /会话/)
  assert.ok(doc.getElementById("replaybar").classList.contains("hidden"), "replay bar hidden in chat view")
  dom.window.close()
})

test("tool card expands to show input, output and locating ids", async (t) => {
  const records = readDemo()
  if (!records) return t.skip("run `node scripts/demo.mjs` first")
  const { dom, doc, errors } = await mount(records)
  await switchView(dom, doc, "chat")

  const head = doc.querySelector(".tool-head")
  head.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 30))

  const body = doc.querySelector(".tool-body")
  assert.ok(body, "body appears after click")
  assert.match(body.textContent, /输入参数/)
  assert.match(body.textContent, /定位/)
  assert.ok(!body.textContent.includes("mDVNfsbCZfMR0"), "no secret in rendered payload")
  assert.deepEqual(errors.map(String), [])
  dom.window.close()
})

test("chat filter chips narrow the timeline", async (t) => {
  const records = readDemo()
  if (!records) return t.skip("run `node scripts/demo.mjs` first")
  const { dom, doc, errors } = await mount(records)
  await switchView(dom, doc, "chat")

  const before = doc.querySelectorAll(".part").length
  const toolChip = [...doc.querySelectorAll(".chip")].find((c) => c.textContent.trim() === "工具")
  assert.ok(toolChip)
  toolChip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 30))
  const after = doc.querySelectorAll(".part").length
  assert.ok(after > 0, "tools still visible")
  assert.ok(after < before, `filter should reduce parts (${before} -> ${after})`)
  assert.deepEqual(errors.map(String), [])
  dom.window.close()
})

test("sub-agent session is reachable from the parent", async (t) => {
  const records = readDemo()
  if (!records) return t.skip("run `node scripts/demo.mjs` first")
  const { dom, doc, errors } = await mount(records)
  await switchView(dom, doc, "chat")

  // root session shows a subtask part with a jump link
  const link = [...doc.querySelectorAll(".subtask .more")].find((b) => /子会话/.test(b.textContent))
  assert.ok(link, "subtask jump link present")
  link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(doc.querySelector(".sess.active .t").textContent.includes("连通性"), "switched to child session")
  assert.deepEqual(errors.map(String), [])
  dom.window.close()
})

/* --------------------------------- fold ---------------------------------- */

test("fold itself is stable on partial/rotated journals", () => {
  const recs = [
    { v: 1, seq: 1, ts: 100, sid: "s", k: "session", id: "s", title: "t" },
    { v: 1, seq: 2, ts: 110, sid: "s", k: "message", mid: "m", role: "user", time: { created: 110 } },
    { v: 1, seq: 3, ts: 120, sid: "s", k: "text", mid: "m", pid: "p", d: "hel" },
    { v: 1, seq: 4, ts: 130, sid: "s", k: "text", mid: "m", pid: "p", d: "lo" },
    { v: 1, seq: 5, ts: 140, sid: "s", k: "status", st: "idle" },
  ]
  const m = fold(recs)
  assert.equal(m.sessions.length, 1)
  assert.equal(m.sessions[0].messages[0].parts[0].text, "hello")
  assert.equal(m.sessions[0].stats.turns, 1)
  // unknown kind / missing message must not throw
  assert.doesNotThrow(() => fold([{ k: "text", sid: "x", mid: "nope", pid: "y", d: "z" }, { k: "???" }]))
})

/* ------------------------------ trajectory ------------------------------- */

test("trajectory splits a tool call into call and result events", () => {
  const recs = [
    { v: 1, seq: 1, ts: 100, sid: "s", k: "message", mid: "a", role: "assistant", time: { created: 100 } },
    { v: 1, seq: 2, ts: 101, sid: "s", k: "tool", mid: "a", pid: "t1", callID: "c1", tool: "bash", st: "running", input: { command: "ls" }, t0: 101 },
    {
      v: 1, seq: 3, ts: 160, sid: "s", k: "tool", mid: "a", pid: "t1", callID: "c1", tool: "bash", st: "completed",
      input: { command: "ls" }, output: "a.txt", t0: 101, t1: 160,
    },
  ]
  const T = trajectory(recs).bySid.get("s")
  const call = T.events.find((e) => e.kind === "tool.call")
  const result = T.events.find((e) => e.kind === "tool.result")

  assert.ok(call && result, "both halves exist")
  assert.equal(call.t, 101)
  assert.equal(result.t, 160)
  assert.equal(result.dur, 59, "duration lands on the result, not the call")
  assert.ok(call.i < result.i, "call precedes result")
  assert.equal(call.callID, "c1")
  assert.deepEqual(result.seqs, [3])
})

test("trajectory folds user text into the turn and keeps injected context separate", () => {
  const recs = [
    { v: 1, seq: 1, ts: 100, sid: "s", k: "message", mid: "u", role: "user", time: { created: 100 } },
    { v: 1, seq: 2, ts: 100, sid: "s", k: "text", mid: "u", pid: "p1", d: "hello " },
    { v: 1, seq: 3, ts: 100, sid: "s", k: "text", mid: "u", pid: "p1", d: "world" },
    { v: 1, seq: 4, ts: 101, sid: "s", k: "text", mid: "u", pid: "p2", d: "INJECTED", syn: 1 },
    { v: 1, seq: 5, ts: 102, sid: "s", k: "message", mid: "a", role: "assistant", time: { created: 102 } },
    { v: 1, seq: 6, ts: 103, sid: "s", k: "reasoning", mid: "a", pid: "r1", d: "thinking" },
  ]
  const T = trajectory(recs).bySid.get("s")

  const turn = T.events.find((e) => e.kind === "user.turn")
  assert.equal(turn.text, "hello world", "delta records are stitched into one turn")
  assert.equal(T.events.filter((e) => e.kind === "assistant.text").length, 0, "user text is not repeated as its own line")

  const injected = T.events.find((e) => e.kind === "context.inject")
  assert.ok(injected, "synthetic part surfaces as context.inject")
  assert.equal(injected.src, "system")

  assert.ok(T.events.find((e) => e.kind === "llm.reasoning"), "reasoning is its own event")
  assert.deepEqual(T.stats.sources, ["user", "assistant", "reasoning", "system"])
})

test("trajectory tolerates junk and empty input", () => {
  assert.deepEqual(trajectory([]).sessions, [])
  assert.doesNotThrow(() => trajectory([null, {}, { k: "text" }, { k: "???" }]))
})
