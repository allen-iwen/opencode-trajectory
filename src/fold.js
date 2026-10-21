/**
 * Journal fold: append-only records -> a browsable trajectory.
 *
 * Shared verbatim by the CLI (Node) and the viewer (browser). Keep it
 * dependency-free and free of Node APIs. The CLI strips the `export` keyword
 * when inlining this file into the HTML page.
 *
 * Fold rules (mirror src/types.ts):
 *   session / message / tool / step  -> upsert by id, last write wins
 *   text / reasoning                 -> concatenate deltas, `r` resets
 *   everything else                  -> append to ordered lists
 */

export function fold(records) {
  const sessions = new Map()
  const byId = (sid) => {
    let s = sessions.get(sid)
    if (!s) {
      s = {
        id: sid,
        parentID: undefined,
        title: "",
        directory: "",
        startedAt: 0,
        endedAt: 0,
        messages: [],
        messageIndex: new Map(),
        steps: [],
        tools: [],
        toolIndex: new Map(),
        errors: [],
        retries: [],
        permissions: [],
        files: [],
        harness: [],
        status: "unknown",
        compacted: 0,
        records: 0,
      }
      sessions.set(sid, s)
    }
    return s
  }

  const partIndex = new Map() // pid -> { part, textAcc, at, mid, sid }
  let order = 0

  for (const rec of records) {
    if (!rec || typeof rec !== "object" || !rec.k) continue
    const sid = rec.sid || "unknown"
    const s = byId(sid)
    s.records++
    order++
    const at = rec.ts || 0
    if (at) {
      if (!s.startedAt || at < s.startedAt) s.startedAt = at
      if (at > s.endedAt) s.endedAt = at
    }

    switch (rec.k) {
      case "session": {
        if (rec.id && rec.id !== sid) {
          // a session record may describe another session (bootstrap list)
          const other = byId(rec.id)
          if (rec.parentID) other.parentID = rec.parentID
          if (rec.title) other.title = rec.title
          if (rec.directory) other.directory = rec.directory
          break
        }
        if (rec.parentID) s.parentID = rec.parentID
        if (rec.title) s.title = rec.title
        if (rec.directory) s.directory = rec.directory
        break
      }

      case "message": {
        let m = s.messageIndex.get(rec.mid)
        if (!m) {
          m = {
            id: rec.mid,
            role: rec.role || "assistant",
            agent: rec.agent,
            providerID: rec.providerID,
            modelID: rec.modelID,
            created: rec.time?.created || at,
            completed: rec.time?.completed,
            tokens: rec.tokens,
            cost: rec.cost,
            finish: rec.finish,
            error: rec.error,
            parts: [],
            partIndex: new Map(),
          }
          s.messageIndex.set(rec.mid, m)
          s.messages.push(m)
        }
        m.role = rec.role || m.role
        if (rec.agent) m.agent = rec.agent
        if (rec.providerID) m.providerID = rec.providerID
        if (rec.modelID) m.modelID = rec.modelID
        if (rec.time?.created) m.created = rec.time.created
        if (rec.time?.completed) m.completed = rec.time.completed
        if (rec.tokens) m.tokens = rec.tokens
        if (typeof rec.cost === "number") m.cost = rec.cost
        if (rec.finish) m.finish = rec.finish
        if (rec.error) m.error = rec.error
        break
      }

      case "text":
      case "reasoning": {
        let entry = partIndex.get(rec.pid)
        if (!entry) {
          const m = s.messageIndex.get(rec.mid)
          if (!m) break
          entry = {
            kind: rec.k,
            pid: rec.pid,
            mid: rec.mid,
            sid,
            text: "",
            syn: false,
            t0: rec.t0,
            t1: rec.t1,
            at: rec.t0 || at,
            order,
          }
          partIndex.set(rec.pid, entry)
          let p = m.partIndex.get(rec.pid)
          if (!p) {
            p = { type: rec.k, pid: rec.pid, text: "", syn: false, at: entry.at, seq: order }
            m.partIndex.set(rec.pid, p)
            m.parts.push(p)
          }
        }
        if (rec.r) entry.text = ""
        entry.text += rec.d || ""
        if (rec.syn) entry.syn = true
        if (rec.t0) entry.t0 = rec.t0
        if (rec.t1) entry.t1 = rec.t1
        const m = s.messageIndex.get(rec.mid)
        const p = m && m.partIndex.get(rec.pid)
        if (p) {
          p.text = entry.text
          p.syn = entry.syn
          p.t0 = entry.t0
          p.t1 = entry.t1
        }
        break
      }

      case "tool": {
        let t = s.toolIndex.get(rec.pid)
        if (!t) {
          t = {
            type: "tool",
            pid: rec.pid,
            callID: rec.callID,
            tool: rec.tool,
            st: rec.st,
            agent: rec.agent,
            at: rec.t0 || at,
            seq: order,
          }
          s.toolIndex.set(rec.pid, t)
          s.tools.push(t)
          const m = s.messageIndex.get(rec.mid)
          if (m) {
            m.partIndex.set(rec.pid, t)
            m.parts.push(t)
          }
        }
        t.st = rec.st || t.st
        if (rec.agent) t.agent = rec.agent
        if (rec.input !== undefined) t.input = rec.input
        if (rec.output !== undefined) t.output = rec.output
        if (rec.title !== undefined) t.title = rec.title
        if (rec.error !== undefined) t.error = rec.error
        if (rec.clipped) t.clipped = { ...(t.clipped || {}), ...rec.clipped }
        if (rec.t0 !== undefined) t.t0 = rec.t0
        if (rec.t1 !== undefined) t.t1 = rec.t1
        if (t.t0 !== undefined && t.t1 !== undefined) t.durMs = t.t1 - t.t0
        break
      }

      case "step": {
        const pid = rec.pid
        let step = s.steps.find((x) => x.pid === pid)
        if (!step) {
          step = { pid, mid: rec.mid, at: rec.t0 || at, seq: order }
          s.steps.push(step)
          const m = s.messageIndex.get(rec.mid)
          if (m) {
            const p = { type: "step", pid, ph: rec.ph, at: step.at, seq: order }
            m.partIndex.set(`step:${pid}`, p)
            m.parts.push(p)
          }
        }
        step.ph = rec.ph
        if (rec.reason) step.reason = rec.reason
        if (typeof rec.cost === "number") step.cost = rec.cost
        if (rec.tokens) step.tokens = rec.tokens
        if (rec.snapshot) step.snapshot = rec.snapshot
        const m2 = s.messageIndex.get(rec.mid)
        const p2 = m2 && m2.partIndex.get(`step:${pid}`)
        if (p2) {
          p2.ph = rec.ph
          p2.reason = step.reason
          p2.cost = step.cost
          p2.tokens = step.tokens
          p2.snapshot = step.snapshot
        }
        break
      }

      case "subtask": {
        const m = s.messageIndex.get(rec.mid)
        if (!m) break
        const p = {
          type: "subtask",
          pid: rec.pid,
          agent: rec.agent,
          description: rec.description,
          prompt: rec.prompt,
          clipped: rec.clipped,
          at: at,
          seq: order,
        }
        if (!m.partIndex.has(rec.pid)) {
          m.partIndex.set(rec.pid, p)
          m.parts.push(p)
        }
        break
      }

      case "error":
        s.errors.push({ at, name: rec.name, message: rec.message, mid: rec.mid, detail: rec.detail, seq: order })
        break

      case "status":
        s.status = rec.st
        if (rec.st === "retry") {
          s.retries.push({ at, attempt: rec.attempt, message: rec.message, next: rec.next, seq: order })
        }
        break

      case "permission":
        s.permissions.push({ at, ph: rec.ph, permID: rec.permID, type: rec.type, title: rec.title, response: rec.response, seq: order })
        break

      case "file":
        s.files.push({ at, file: rec.file, op: rec.op, seq: order })
        break

      case "compact":
        if (rec.ph === "finish") s.compacted++
        else s.harness.push({ at, ev: "compact", detail: "compaction started", seq: order })
        break

      case "harness":
        s.harness.push({ at, ev: rec.ev, detail: rec.detail, n: rec.n, seq: order })
        break
    }
  }

  // ---- finalize -----------------------------------------------------------
  for (const s of sessions.values()) {
    s.messages.sort((a, b) => (a.created || 0) - (b.created || 0))
    for (const m of s.messages) m.parts.sort((a, b) => (a.at || 0) - (b.at || 0) || a.seq - b.seq)
    s.steps.sort((a, b) => (a.at || 0) - (b.at || 0) || a.seq - b.seq)
    s.tools.sort((a, b) => (a.at || 0) - (b.at || 0) || a.seq - b.seq)

    const user = s.messages.filter((m) => m.role === "user")
    const assistant = s.messages.filter((m) => m.role === "assistant")
    const tk = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    let cost = 0
    for (const m of assistant) {
      const t = m.tokens
      if (t) {
        tk.input += t.input || 0
        tk.output += t.output || 0
        tk.reasoning += t.reasoning || 0
        tk.cacheRead += t.cacheRead || 0
        tk.cacheWrite += t.cacheWrite || 0
      }
      if (typeof m.cost === "number") cost += m.cost
    }
    const toolMs = s.tools.reduce((a, t) => a + (t.durMs || 0), 0)
    s.stats = {
      turns: user.length,
      messages: s.messages.length,
      steps: s.steps.filter((x) => x.ph === "finish").length,
      tools: s.tools.length,
      toolErrors: s.tools.filter((t) => t.st === "error").length,
      errors: s.errors.length,
      retries: s.retries.length,
      permissions: s.permissions.length,
      tokens: tk,
      cost,
      durationMs: s.endedAt - s.startedAt,
      toolMs,
      cacheHit: tk.input + tk.cacheRead > 0 ? tk.cacheRead / (tk.input + tk.cacheRead) : 0,
      models: [...new Set(assistant.map((m) => [m.providerID, m.modelID].filter(Boolean).join("/")).filter(Boolean))],
      agents: [...new Set(s.messages.map((m) => m.agent).filter(Boolean))],
    }
    if (!s.title) {
      const firstUser = user[0]
      const txt = firstUser && firstUser.parts.find((p) => p.type === "text")
      s.title = txt ? txt.text.slice(0, 80) : s.id
    }
    s.children = []
  }

  const all = [...sessions.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  const roots = []
  for (const s of all) {
    if (s.parentID && sessions.has(s.parentID)) sessions.get(s.parentID).children.push(s)
    else roots.push(s)
  }
  for (const s of all) s.children.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))

  const total = all.reduce(
    (a, s) => {
      a.tokens.input += s.stats.tokens.input
      a.tokens.output += s.stats.tokens.output
      a.tokens.reasoning += s.stats.tokens.reasoning
      a.tokens.cacheRead += s.stats.tokens.cacheRead
      a.tokens.cacheWrite += s.stats.tokens.cacheWrite
      a.cost += s.stats.cost
      a.tools += s.stats.tools
      a.errors += s.stats.errors + s.stats.toolErrors
      return a
    },
    { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, tools: 0, errors: 0 },
  )

  return { sessions: all, roots, total, order: all.map((s) => s.id) }
}

/**
 * Source taxonomy for the audit view. Mirrors how DSH labels trajectory lines:
 * one tag per origin, stable colours, filterable.
 */
export const SOURCES = {
  user: { tag: "USER", zh: "用户", order: 10 },
  assistant: { tag: "LLM", zh: "模型", order: 20 },
  reasoning: { tag: "THINK", zh: "思考", order: 30 },
  llm: { tag: "STEP", zh: "步", order: 40 },
  tool: { tag: "TOOL", zh: "工具调用", order: 50 },
  result: { tag: "RESULT", zh: "工具返回", order: 60 },
  system: { tag: "CTX", zh: "上下文", order: 70 },
  subagent: { tag: "AGENT", zh: "子代理", order: 80 },
  error: { tag: "ERR", zh: "错误", order: 90 },
  perm: { tag: "PERM", zh: "权限", order: 100 },
  file: { tag: "FILE", zh: "文件", order: 110 },
  harness: { tag: "META", zh: "元信息", order: 120 },
}

/** Collapse whitespace so one event always occupies exactly one line. */
function oneLine(s, max) {
  const flat = String(s == null ? "" : s).replace(/\s+/g, " ").trim()
  if (max && flat.length > max) return flat.slice(0, max) + "…"
  return flat
}

function fmtBytes(n) {
  if (!n) return "0B"
  if (n < 1024) return n + "B"
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + "KB"
  return (n / 1048576).toFixed(1) + "MB"
}

/**
 * Event-stream projection of one session.
 *
 * `fold()` answers "what did the agent say" — a message tree, good for reading.
 * This answers "what happened, in what order, from which source" — a flat audit
 * trail, which is the shape a DSH-style trajectory viewer is built on.
 *
 * Both projections read the same append-only records. Nothing is invented: each
 * event carries `seqs`, the record sequence numbers it was derived from, and
 * `ev`, the OpenCode event that produced them.
 *
 * A tool call becomes TWO events (call, then result) on purpose. Collapsing them
 * hides the gap between "the model decided to run this" and "the result came
 * back", which is exactly the interval people open a trajectory to inspect.
 */
export function trajectory(records) {
  const list = Array.isArray(records) ? records : []
  const accs = new Map()

  const acc = (sid) => {
    let a = accs.get(sid)
    if (!a) {
      a = {
        sid,
        title: "",
        parentID: undefined,
        directory: "",
        records: 0,
        texts: new Map(),
        tools: new Map(),
        msgs: new Map(),
        steps: new Map(),
        plain: [],
      }
      accs.set(sid, a)
    }
    return a
  }

  // Records are appended in seq order, but rotation can interleave two files.
  // Sorting here keeps the reconstruction faithful regardless of read order.
  const ordered = list
    .filter((r) => r && typeof r === "object" && r.k)
    .slice()
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))

  for (const rec of ordered) {
    const a = acc(rec.sid || "unknown")
    a.records++

    switch (rec.k) {
      case "session": {
        if (!rec.id || rec.id === rec.sid) {
          if (rec.title) a.title = rec.title
          if (rec.parentID) a.parentID = rec.parentID
          if (rec.directory) a.directory = rec.directory
          a.plain.push({
            t: rec.ts,
            ord: rec.seq,
            src: "harness",
            ev: rec.ev || "session.created",
            kind: "session.start",
            text: rec.title || rec.id || rec.sid,
            note: rec.directory || (rec.parentID ? "子会话" : ""),
            mid: undefined,
            pid: undefined,
            callID: undefined,
            seqs: [rec.seq],
            data: {
              sessionID: rec.id || rec.sid,
              parentID: rec.parentID,
              directory: rec.directory,
              title: rec.title,
            },
          })
        }
        break
      }

      case "message": {
        let m = a.msgs.get(rec.mid)
        if (!m) {
          m = {
            mid: rec.mid,
            role: rec.role || "assistant",
            created: 0,
            completed: 0,
            tokens: null,
            cost: 0,
            finish: "",
            agent: "",
            providerID: "",
            modelID: "",
            error: null,
            seq: rec.seq,
          }
          a.msgs.set(rec.mid, m)
        }
        m.role = rec.role || m.role
        if (rec.time && rec.time.created) m.created = rec.time.created
        if (rec.time && rec.time.completed) m.completed = rec.time.completed
        if (rec.tokens) m.tokens = rec.tokens
        if (typeof rec.cost === "number") m.cost = rec.cost
        if (rec.finish) m.finish = rec.finish
        if (rec.agent) m.agent = rec.agent
        if (rec.providerID) m.providerID = rec.providerID
        if (rec.modelID) m.modelID = rec.modelID
        if (rec.error) m.error = rec.error
        m.seq = rec.seq
        break
      }

      case "text":
      case "reasoning": {
        let x = a.texts.get(rec.pid)
        if (!x) {
          x = {
            pid: rec.pid,
            mid: rec.mid,
            kind: rec.k,
            text: "",
            syn: false,
            t0: rec.t0,
            t1: rec.t1,
            seq0: rec.seq,
            seq1: rec.seq,
            ev: rec.ev,
            seqs: [],
          }
          a.texts.set(rec.pid, x)
        }
        if (rec.r) x.text = ""
        x.text += rec.d || ""
        if (rec.syn) x.syn = true
        if (rec.t0) x.t0 = rec.t0
        if (rec.t1) x.t1 = rec.t1
        if (rec.ev) x.ev = rec.ev
        x.seq1 = rec.seq
        x.seqs.push(rec.seq)
        break
      }

      case "tool": {
        let x = a.tools.get(rec.pid)
        if (!x) {
          x = {
            pid: rec.pid,
            mid: rec.mid,
            callID: rec.callID,
            tool: rec.tool,
            st: rec.st,
            agent: rec.agent,
            seq0: rec.seq,
            seq1: rec.seq,
            ev: rec.ev,
            seqs: [],
          }
          a.tools.set(rec.pid, x)
        }
        x.st = rec.st || x.st
        if (rec.tool) x.tool = rec.tool
        if (rec.agent) x.agent = rec.agent
        if (rec.input !== undefined) x.input = rec.input
        if (rec.output !== undefined) x.output = rec.output
        if (rec.title !== undefined) x.title = rec.title
        if (rec.error !== undefined) x.error = rec.error
        if (rec.clipped) x.clipped = Object.assign({}, x.clipped, rec.clipped)
        if (rec.t0 !== undefined) x.t0 = rec.t0
        if (rec.t1 !== undefined) x.t1 = rec.t1
        if (rec.ev) x.ev = rec.ev
        x.seq1 = rec.seq
        x.seqs.push(rec.seq)
        break
      }

      case "step": {
        let x = a.steps.get(rec.pid)
        if (!x) {
          x = { pid: rec.pid, mid: rec.mid, seq0: rec.seq, seq1: rec.seq, seqs: [], t: rec.ts, ev: rec.ev }
          a.steps.set(rec.pid, x)
        }
        x.ph = rec.ph
        if (rec.reason) x.reason = rec.reason
        if (typeof rec.cost === "number") x.cost = rec.cost
        if (rec.tokens) x.tokens = rec.tokens
        if (rec.snapshot) x.snapshot = rec.snapshot
        if (rec.ev) x.ev = rec.ev
        x.t = rec.ts
        x.seq1 = rec.seq
        x.seqs.push(rec.seq)
        break
      }

      case "error":
        a.plain.push({
          t: rec.ts,
          ord: rec.seq,
          src: "error",
          ev: rec.ev || "session.error",
          kind: "error",
          text: (rec.name || "Error") + ": " + (rec.message || ""),
          mid: rec.mid,
          seqs: [rec.seq],
          data: { name: rec.name, message: rec.message, detail: rec.detail },
        })
        break

      case "status":
        // busy/idle transitions are not trajectory-worthy on their own: they
        // would add two empty lines per turn. Retries are, so they survive.
        if (rec.st === "retry") {
          a.plain.push({
            t: rec.ts,
            ord: rec.seq,
            src: "harness",
            ev: rec.ev || "session.status",
            kind: "retry",
            text: "provider 重试 #" + (rec.attempt == null ? "?" : rec.attempt),
            note: oneLine(rec.message, 90),
            seqs: [rec.seq],
            data: { attempt: rec.attempt, message: rec.message, next: rec.next },
          })
        }
        break

      case "permission":
        a.plain.push({
          t: rec.ts,
          ord: rec.seq,
          src: "perm",
          ev: rec.ev || (rec.ph === "asked" ? "permission.asked" : "permission.replied"),
          kind: "perm." + rec.ph,
          text: [rec.type, rec.title].filter(Boolean).join(" · ") || rec.permID,
          note: rec.response || "",
          status: rec.response && rec.response !== "once" && rec.response !== "always" ? "err" : "",
          mid: rec.mid,
          seqs: [rec.seq],
          data: { permissionID: rec.permID, type: rec.type, title: rec.title, pattern: rec.pattern, response: rec.response },
        })
        break

      case "file":
        a.plain.push({
          t: rec.ts,
          ord: rec.seq,
          src: "file",
          ev: rec.ev || "file.edited",
          kind: "file." + rec.op,
          text: rec.file,
          seqs: [rec.seq],
          data: { file: rec.file, op: rec.op },
        })
        break

      case "compact":
        a.plain.push({
          t: rec.ts,
          ord: rec.seq,
          src: "system",
          ev: rec.ev || "session.compacted",
          kind: "context.compact." + rec.ph,
          text: rec.ph === "finish" ? "上下文压缩完成" : "开始压缩上下文",
          seqs: [rec.seq],
          data: { phase: rec.ph },
        })
        break

      case "subtask":
        a.plain.push({
          t: rec.ts,
          ord: rec.seq,
          src: "subagent",
          ev: rec.ev || "message.part.updated",
          kind: "agent.spawn",
          text: (rec.agent || "?") + (rec.description ? " · " + rec.description : ""),
          mid: rec.mid,
          pid: rec.pid,
          seqs: [rec.seq],
          data: { agent: rec.agent, description: rec.description, prompt: rec.prompt },
        })
        break

      case "harness":
        a.plain.push({
          t: rec.ts,
          ord: rec.seq,
          src: "harness",
          ev: "harness",
          kind: "harness." + rec.ev,
          text: rec.detail,
          note: rec.n != null ? "×" + rec.n : "",
          status: rec.ev === "error" ? "err" : "",
          seqs: [rec.seq],
          data: { event: rec.ev, detail: rec.detail, count: rec.n },
        })
        break
    }
  }

  // ---- event generation ---------------------------------------------------
  const sessions = []
  const bySid = new Map()

  for (const a of accs.values()) {
    const evs = []

    for (const p of a.plain) evs.push(p)

    // User text belongs to its turn, not to a separate line: a turn reads as
    // one "what the human asked" event, which is how a trajectory should start.
    const userText = new Map()
    for (const x of a.texts.values()) {
      const m = a.msgs.get(x.mid)
      if (m && m.role === "user" && !x.syn) userText.set(x.mid, (userText.get(x.mid) || "") + x.text)
    }

    for (const m of a.msgs.values()) {
      const t = m.created || 0
      if (m.role === "user") {
        const body = userText.get(m.mid) || ""
        evs.push({
          t,
          ord: m.seq,
          src: "user",
          ev: "chat.message",
          kind: "user.turn",
          text: oneLine(body, 400),
          note: body.length > 400 ? body.length + " 字" : "",
          mid: m.mid,
          seqs: [m.seq],
          data: { messageID: m.mid, agent: m.agent, model: [m.providerID, m.modelID].filter(Boolean).join("/"), text: body },
        })
      } else {
        evs.push({
          t,
          ord: m.seq,
          src: "assistant",
          ev: "message.updated",
          kind: "llm.response",
          text: [m.providerID, m.modelID].filter(Boolean).join("/") || "assistant",
          note: [
            m.finish || "",
            m.tokens ? "in " + m.tokens.input + " · out " + m.tokens.output : "",
            m.tokens && m.tokens.reasoning ? "think " + m.tokens.reasoning : "",
          ]
            .filter(Boolean)
            .join(" · "),
          status: m.error ? "err" : "",
          dur: m.created && m.completed ? m.completed - m.created : undefined,
          mid: m.mid,
          seqs: [m.seq],
          data: {
            messageID: m.mid,
            agent: m.agent,
            model: [m.providerID, m.modelID].filter(Boolean).join("/"),
            tokens: m.tokens,
            cost: m.cost,
            finish: m.finish,
            error: m.error,
            created: m.created,
            completed: m.completed,
          },
        })
      }
    }

    for (const x of a.texts.values()) {
      const m = a.msgs.get(x.mid)
      // Already folded into the user turn above.
      if (m && m.role === "user" && !x.syn) continue
      const isReason = x.kind === "reasoning"
      evs.push({
        t: x.t0 || (m && m.created) || 0,
        ord: x.seq0,
        src: x.syn ? "system" : isReason ? "reasoning" : "assistant",
        ev: x.ev || "message.part.updated",
        kind: x.syn ? "context.inject" : isReason ? "llm.reasoning" : "assistant.text",
        text: oneLine(x.text, 400),
        note: (x.text ? x.text.length + " 字" : "") + (x.t1 && x.t0 ? " · " + (x.t1 - x.t0) + "ms" : ""),
        dur: x.t1 && x.t0 ? x.t1 - x.t0 : undefined,
        mid: x.mid,
        pid: x.pid,
        seqs: x.seqs.length ? x.seqs : [x.seq0],
        data: { partID: x.pid, messageID: x.mid, synthetic: x.syn || undefined, chars: x.text.length, text: x.text },
      })
    }

    for (const x of a.tools.values()) {
      const status = x.st === "error" ? "err" : x.st === "running" ? "run" : x.st === "completed" ? "ok" : ""
      evs.push({
        t: x.t0 || (a.msgs.get(x.mid) || {}).created || 0,
        ord: x.seq0,
        src: "tool",
        ev: x.ev || "message.part.updated",
        kind: "tool.call",
        text: x.tool,
        note: oneLine(x.title || "", 90),
        status,
        mid: x.mid,
        pid: x.pid,
        callID: x.callID,
        seqs: x.seqs.length ? x.seqs : [x.seq0],
        data: { tool: x.tool, input: x.input, title: x.title, agent: x.agent, callID: x.callID, status: x.st, clipped: x.clipped },
      })

      const hasResult = x.output !== undefined || x.error !== undefined || x.st === "completed" || x.st === "error"
      if (hasResult) {
        evs.push({
          t: x.t1 || x.t0 || 0,
          ord: x.seq1,
          src: "result",
          ev: x.ev || "message.part.updated",
          kind: "tool.result",
          text: oneLine(x.error || x.output || "(空返回)", 400),
          note: x.error ? "失败" : x.output ? fmtBytes(x.output.length) : "",
          status: x.st === "error" ? "err" : "ok",
          dur: x.t0 && x.t1 ? x.t1 - x.t0 : undefined,
          mid: x.mid,
          pid: x.pid,
          callID: x.callID,
          seqs: [x.seq1],
          data: { output: x.output, error: x.error, status: x.st, callID: x.callID, clipped: x.clipped },
        })
      }
    }

    for (const x of a.steps.values()) {
      const finished = x.ph === "finish"
      evs.push({
        t: x.t || 0,
        ord: finished ? x.seq1 : x.seq0,
        src: "llm",
        ev: x.ev || "message.part.updated",
        kind: finished ? "llm.step.end" : "llm.step.start",
        text: finished ? "step 结束" + (x.reason ? " · " + x.reason : "") : "step 开始",
        note: finished
          ? [
              x.tokens ? "in " + x.tokens.input + " / out " + x.tokens.output : "",
              x.tokens && x.tokens.reasoning ? "think " + x.tokens.reasoning : "",
              x.cost ? "$" + x.cost : "",
            ]
              .filter(Boolean)
              .join(" · ")
          : x.snapshot
            ? "snapshot " + String(x.snapshot).slice(0, 10)
            : "",
        mid: x.mid,
        pid: x.pid,
        seqs: x.seqs.length ? x.seqs : [x.seq0],
        data: { partID: x.pid, phase: x.ph, reason: x.reason, tokens: x.tokens, cost: x.cost, snapshot: x.snapshot },
      })
    }

    evs.sort((p, q) => (p.t || 0) - (q.t || 0) || (p.ord || 0) - (q.ord || 0))
    evs.forEach((e, i) => {
      e.i = i + 1
    })

    const bySrc = {}
    let toolMs = 0
    for (const e of evs) {
      bySrc[e.src] = (bySrc[e.src] || 0) + 1
      if (e.kind === "tool.result" && e.dur) toolMs += e.dur
    }
    const startedAt = evs.length ? evs[0].t || 0 : 0
    const endedAt = evs.length ? evs[evs.length - 1].t || 0 : 0

    const entry = {
      sid: a.sid,
      title: a.title,
      parentID: a.parentID,
      directory: a.directory,
      events: evs,
      records: a.records,
      startedAt,
      endedAt,
      stats: {
        events: evs.length,
        bySrc,
        toolMs,
        durationMs: endedAt - startedAt,
        sources: Object.keys(bySrc).sort((p, q) => (SOURCES[p] ? SOURCES[p].order : 999) - (SOURCES[q] ? SOURCES[q].order : 999)),
      },
    }
    sessions.push(entry)
    bySid.set(a.sid, entry)
  }

  sessions.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return { sessions, bySid }
}

/** Parse JSONL text into records, skipping damaged lines. */
export function parseJournal(text) {
  const out = []
  let bad = 0
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      bad++
    }
  }
  return { records: out, bad }
}

/**
 * The viewer inlines this file with the `export` keywords stripped, so the
 * functions above are plain script-scope declarations there. Publish them on
 * one namespace both environments can use. Harmless under Node.
 */
if (typeof globalThis !== "undefined") {
  globalThis.TrajFold = { fold, parseJournal, trajectory, SOURCES }
}
