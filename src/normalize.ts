import type { TraceRecord, TrajectoryConfig } from "./types.ts"
import { clip, compileExtra, redactText, redactValue } from "./redact.ts"

/** A record before the store stamps `v` / `seq` / `ts`. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type DraftRecord = DistributiveOmit<TraceRecord, "v" | "seq" | "ts">

/**
 * Text parts arrive as growing full snapshots, one event per token. Writing a
 * record per event would make a 10 KB answer cost thousands of lines. We emit a
 * delta record only once enough characters have accumulated.
 */
const DELTA_THRESHOLD = 96
/** Same ceiling for message.updated, which fires on every token as tokens grow. */
const MSG_THROTTLE_MS = 500

type Tokens = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

function tokens(t: any): Tokens | undefined {
  if (!t || typeof t !== "object") return undefined
  return {
    input: t.input ?? 0,
    output: t.output ?? 0,
    reasoning: t.reasoning ?? 0,
    cacheRead: t.cache?.read ?? 0,
    cacheWrite: t.cache?.write ?? 0,
  }
}

function errInfo(e: any): { name: string; message: string; detail?: unknown } | undefined {
  if (!e) return undefined
  const name = typeof e.name === "string" ? e.name : "Error"
  const data = e.data ?? e
  const message =
    typeof data?.message === "string" ? data.message : typeof e.message === "string" ? e.message : String(name)
  return { name, message, detail: data }
}

interface MsgMeta {
  role: "user" | "assistant"
  agent?: string
  providerID?: string
  modelID?: string
  sig: string
}

/**
 * Event → record normalizer.
 *
 * Holds only the minimum state needed to (a) diff growing text, (b) dedupe tool
 * state transitions, (c) resolve part → message role. Nothing here ever throws
 * outward: a malformed event yields no records, never a broken session.
 */
export class Normalizer {
  private cfg: TrajectoryConfig
  private extra: RegExp[]
  private msg = new Map<string, MsgMeta>()
  private text = new Map<string, { text: string; syn: boolean }>()
  private tool = new Map<string, { st: string }>()
  private lastMsgWrite = new Map<string, number>()
  private lastStatus = new Map<string, string>()
  private sessionSig = new Map<string, string>()
  private userMsgSeen = new Set<string>()
  /** Metadata for sessions discovered at startup; written only if they produce events. */
  private primed = new Map<string, any>()
  private sessionWritten = new Set<string>()
  private pending = new Map<string, { sid: string; mid: string; kind: "text" | "reasoning"; syn: boolean }>()
  private lastSid = ""

  constructor(cfg: TrajectoryConfig) {
    this.cfg = cfg
    this.extra = compileExtra(cfg.redactPatterns)
  }

  get lastSession(): string {
    return this.lastSid
  }

  private scr(s: string): string {
    return this.cfg.redact ? redactText(s, this.extra) : s
  }

  private scrV(v: unknown): unknown {
    return this.cfg.redact ? redactValue(v, this.extra) : v
  }

  /**
   * Called once after startup with `session.list()`.
   *
   * These are cached, NOT written: a project may hold hundreds of historical
   * sessions, and recording them would fill the journal with empty ghosts that
   * make the viewer's session tree useless. The metadata is emitted lazily, the
   * first time that session produces a real event — which also recovers the
   * `parentID` for sessions created before this process started.
   */
  primeSessions(list: any[]): void {
    for (const info of list) if (info?.id) this.primed.set(info.id, info)
  }

  /** Prepend the session record if this session has not been described yet. */
  private withSession(recs: DraftRecord[]): DraftRecord[] {
    if (!recs.length) return recs
    const sid = (recs[0] as any).sid as string | undefined
    if (!sid || this.sessionWritten.has(sid)) return recs
    const info = this.primed.get(sid)
    if (!info) return recs
    this.sessionWritten.add(sid)
    const rec = this.buildSession(info)
    // Not a real event: this metadata was cached at startup. Say so, so the
    // audit view never implies the session was created just now.
    ;(rec as any).ev = "session.prime"
    return [rec, ...recs]
  }

  /** Emit any buffered sub-threshold text deltas. Called on idle / dispose. */
  flushPending(): DraftRecord[] {
    const out: DraftRecord[] = []
    for (const [pid, p] of this.pending) {
      const buf = this.buf.get(pid)
      if (!buf) continue
      this.buf.delete(pid)
      out.push({
        k: p.kind,
        sid: p.sid,
        mid: p.mid,
        pid,
        d: buf,
        syn: p.syn ? 1 : undefined,
        ev: "message.part.updated",
      } as DraftRecord)
    }
    this.pending.clear()
    return out
  }

  /** Unwritten delta characters, keyed by part id. */
  private buf = new Map<string, string>()

  /** Track text growth and return a delta record when the threshold is met. */
  private textDelta(
    sid: string,
    mid: string,
    part: any,
    kind: "text" | "reasoning",
    syn: boolean,
    start?: number,
    end?: number,
  ): DraftRecord[] {
    const pid: string = part.id
    const full: string = typeof part.text === "string" ? part.text : ""
    const prev = this.text.get(pid)

    let delta: string
    let reset = false
    if (!prev) {
      delta = full
      reset = false
    } else if (full === prev.text) {
      return []
    } else if (full.startsWith(prev.text)) {
      delta = full.slice(prev.text.length)
    } else {
      delta = full
      reset = true
    }
    this.text.set(pid, { text: full, syn })

    if (!delta) return []
    // On a rewrite the buffered prefix belongs to the discarded text.
    if (reset) this.buf.delete(pid)
    const buffered = (this.buf.get(pid) ?? "") + delta
    this.buf.set(pid, buffered)
    this.pending.set(pid, { sid, mid, kind, syn })

    // Reset always flushes: the reader must drop its accumulated state now.
    if (!reset && buffered.length < DELTA_THRESHOLD && end === undefined) return []

    this.buf.delete(pid)
    this.pending.delete(pid)
    const out = this.scr(buffered)
    const c = clip(out, this.cfg.maxPayloadChars)
    const rec: DraftRecord = {
      k: kind,
      sid,
      mid,
      pid,
      d: c.text,
      ...(reset ? { r: 1 as const } : {}),
      ...(syn ? { syn: 1 as const } : {}),
      ...(start !== undefined ? { t0: start } : {}),
      ...(end !== undefined ? { t1: end } : {}),
    }
    return [rec]
  }

  // ---------------------------------------------------------------- user turn

  /**
   * From the `chat.message` hook. This is the authoritative moment a user turn
   * starts — it already carries a stable messageID, so the event stream's later
   * `message.part.updated` for the same parts can be skipped.
   */
  userTurn(input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } }, output: any): DraftRecord[] {
    const msg = output?.message
    if (!msg?.id) return []
    const mid: string = msg.id
    if (this.userMsgSeen.has(mid)) return []
    this.userMsgSeen.add(mid)
    this.lastSid = input.sessionID

    const recs: DraftRecord[] = []
    const agent = msg.agent ?? input.agent
    const providerID = msg.model?.providerID ?? input.model?.providerID
    const modelID = msg.model?.modelID ?? input.model?.modelID
    this.msg.set(mid, { role: "user", agent, providerID, modelID, sig: "user" })

    // The message record must exist before its parts, otherwise a reader has
    // nothing to attach the text to (see fold: parts resolve through messageID).
    recs.push({
      k: "message",
      sid: input.sessionID,
      mid,
      role: "user",
      agent,
      providerID,
      modelID,
      time: { created: msg.time?.created ?? Date.now() },
    })

    for (const p of output.parts ?? []) {
      if (p?.type !== "text" || typeof p.text !== "string" || !p.text) continue
      // Streaming text is meaningless for a user turn; write it whole, once.
      const c = clip(this.scr(p.text), this.cfg.maxPayloadChars)
      recs.push({
        k: "text",
        sid: input.sessionID,
        mid,
        pid: p.id,
        d: c.text,
        ...(p.synthetic ? { syn: 1 as const } : {}),
      })
      this.text.set(p.id, { text: p.text, syn: !!p.synthetic })
    }
    for (const r of recs) (r as any).ev = "chat.message"
    return this.withSession(recs)
  }

  // ------------------------------------------------------------------- events

  /** Accepts either a bare `Event` or the `{directory, payload}` wrapper. */
  event(raw: any): DraftRecord[] {
    const e = raw && typeof raw === "object" && "payload" in raw && "directory" in raw ? raw.payload : raw
    if (!e || typeof e.type !== "string") return []
    try {
      const recs = this.dispatch(e)
      // Provenance is stamped before `withSession`, so the lazily prepended
      // metadata record is not misattributed to whatever event woke it up.
      for (const r of recs) (r as any).ev = e.type
      return this.withSession(recs)
    } catch {
      return []
    }
  }

  private dispatch(e: any): DraftRecord[] {
    const p = e.properties ?? {}
    switch (e.type as string) {
      case "session.created":
      case "session.updated":
        return this.session(p.info)
      case "session.idle":
        this.lastSid = p.sessionID
        return this.statusRecord(p.sessionID, "idle")
      case "session.status": {
        this.lastSid = p.sessionID
        const s = p.status ?? {}
        if (s.type === "retry") {
          // Every retry attempt is a distinct fact, never dedupe these.
          return [{ k: "status", sid: p.sessionID, st: "retry", attempt: s.attempt, message: s.message, next: s.next }]
        }
        return this.statusRecord(p.sessionID, s.type === "busy" ? "busy" : "idle")
      }
      case "session.error": {
        const info = errInfo(p.error)
        if (!info) return []
        const sid = p.sessionID ?? this.lastSid
        return [{ k: "error", sid, name: info.name, message: this.scr(info.message), detail: this.scrV(info.detail) }]
      }
      case "session.compacted":
        return [{ k: "compact", sid: p.sessionID, ph: "finish" }]
      case "message.updated":
        return this.message(p.info)
      case "message.part.updated":
        return this.part(p.part)
      case "permission.updated":
      case "permission.asked":
        return this.permission(p)
      case "permission.replied":
        return [
          {
            k: "permission",
            sid: p.sessionID,
            ph: "replied",
            permID: p.permissionID,
            response: p.response,
          },
        ]
      case "file.edited":
        return [{ k: "file", sid: p.sessionID ?? this.lastSid, file: p.file, op: "change" }]
      default:
        return []
    }
  }

  private buildSession(info: any): DraftRecord {
    return {
      k: "session",
      sid: info.id,
      id: info.id,
      parentID: info.parentID,
      title: info.title,
      directory: info.directory,
    }
  }

  private session(info: any): DraftRecord[] {
    if (!info?.id) return []
    this.lastSid = info.id
    this.sessionWritten.add(info.id)
    const sig = `${info.title ?? ""}|${info.parentID ?? ""}|${info.directory ?? ""}`
    if (this.sessionSig.get(info.id) === sig) return []
    this.sessionSig.set(info.id, sig)
    return [this.buildSession(info)]
  }

  /** Emit a status record only when the session actually changes state. */
  private statusRecord(sid: string, st: "busy" | "idle"): DraftRecord[] {
    if (!sid || this.lastStatus.get(sid) === st) return []
    this.lastStatus.set(sid, st)
    return [{ k: "status", sid, st }]
  }

  private message(info: any): DraftRecord[] {
    if (!info?.id || !info.sessionID) return []
    const mid: string = info.id
    const role: "user" | "assistant" = info.role === "user" ? "user" : "assistant"
    this.lastSid = info.sessionID

    // The user turn was already written authoritatively by `chat.message`;
    // the event stream replays the same message and would double it.
    if (role === "user" && this.userMsgSeen.has(mid)) return []

    const tk = tokens(info.tokens)
    const err = errInfo(info.error)
    const sig = [role, info.time?.completed ?? 0, info.finish ?? "", tk ? `${tk.input}/${tk.output}/${tk.reasoning}/${tk.cacheRead}/${tk.cacheWrite}` : "", info.cost ?? 0, err?.name ?? ""].join("|")

    const prev = this.msg.get(mid)
    if (prev && prev.sig === sig) return []

    // A finished turn, an error, or the first sighting is always worth a record.
    const final = !prev || !!info.time?.completed || !!info.finish || !!err
    const now = Date.now()
    if (!final && now - (this.lastMsgWrite.get(mid) ?? 0) < MSG_THROTTLE_MS) return []

    this.msg.set(mid, {
      role,
      agent: info.mode ?? info.agent,
      providerID: info.providerID ?? info.model?.providerID,
      modelID: info.modelID ?? info.model?.modelID,
      sig,
    })
    this.lastMsgWrite.set(mid, now)

    return [
      {
        k: "message",
        sid: info.sessionID,
        mid,
        role,
        agent: info.mode ?? info.agent,
        providerID: info.providerID ?? info.model?.providerID,
        modelID: info.modelID ?? info.model?.modelID,
        parentID: role === "assistant" ? info.parentID : undefined,
        time: { created: info.time?.created ?? now, completed: info.time?.completed },
        tokens: tk,
        cost: typeof info.cost === "number" ? info.cost : undefined,
        finish: info.finish,
        ...(err ? { error: { name: err.name, message: this.scr(err.message) } } : {}),
      },
    ]
  }

  private part(part: any): DraftRecord[] {
    if (!part?.id || !part.sessionID || part.type === undefined) return []
    const sid: string = part.sessionID
    const mid: string = part.messageID
    this.lastSid = sid

    switch (part.type as string) {
      case "text": {
        if (!this.cfg.captureText) return []
        // User turns are already captured verbatim by chat.message.
        if (this.msg.get(mid)?.role === "user") return []
        return this.textDelta(sid, mid, part, "text", !!part.synthetic, part.time?.start, part.time?.end)
      }
      case "reasoning": {
        if (!this.cfg.captureReasoning || !this.cfg.captureText) return []
        return this.textDelta(sid, mid, part, "reasoning", false, part.time?.start, part.time?.end)
      }
      case "tool":
        return this.toolPart(part, sid, mid)
      case "step-start":
        return [{ k: "step", sid, mid, pid: part.id, ph: "start", snapshot: part.snapshot }]
      case "step-finish":
        return [
          {
            k: "step",
            sid,
            mid,
            pid: part.id,
            ph: "finish",
            reason: part.reason,
            cost: part.cost,
            tokens: tokens(part.tokens),
            snapshot: part.snapshot,
          },
        ]
      case "subtask": {
        const pr = clip(this.scr(part.prompt ?? ""), this.cfg.maxPayloadChars)
        return [
          {
            k: "subtask",
            sid,
            mid,
            pid: part.id,
            agent: part.agent ?? "?",
            description: this.scr(part.description ?? ""),
            prompt: pr.text,
            ...(pr.clipped ? { clipped: { prompt: true } } : {}),
          },
        ]
      }
      case "retry": {
        const info = errInfo(part.error)
        const out: DraftRecord[] = []
        if (info) out.push({ k: "error", sid, mid, name: info.name, message: this.scr(info.message) })
        return out
      }
      case "compaction":
        return [{ k: "compact", sid, ph: "start" }]
      case "patch": {
        const files: any[] = Array.isArray(part.files) ? part.files : []
        return files
          .filter((f) => typeof f?.file === "string")
          .slice(0, 100)
          .map((f) => ({ k: "file" as const, sid, file: f.file, op: "change" as const }))
      }
      default:
        return []
    }
  }

  private toolPart(part: any, sid: string, mid: string): DraftRecord[] {
    const st = part.state ?? {}
    const status: string = st.status ?? "pending"
    const prev = this.tool.get(part.id)
    if (prev) {
      if (prev.st === status) return []
      if (prev.st === "completed" || prev.st === "error") return []
    }
    this.tool.set(part.id, { st: status })

    const meta = this.msg.get(mid)
    const rec: DraftRecord = {
      k: "tool",
      sid,
      mid,
      pid: part.id,
      callID: part.callID,
      tool: part.tool,
      st: status as any,
      agent: meta?.agent,
      t0: st.time?.start,
      t1: st.time?.end,
    }

    if (this.cfg.captureToolInput && st.input !== undefined) {
      const redacted = this.scrV(st.input)
      const probe = JSON.stringify(redacted)
      if (probe && probe.length > this.cfg.maxInputChars) {
        const c = clip(probe, this.cfg.maxInputChars)
        ;(rec as any).input = c.text
        ;(rec as any).clipped = { ...(rec as any).clipped, input: true }
      } else {
        ;(rec as any).input = redacted
      }
    }

    if (typeof st.title === "string" && st.title) (rec as any).title = this.scr(st.title)

    if (status === "completed" && this.cfg.captureToolOutput && typeof st.output === "string") {
      const c = clip(this.scr(st.output), this.cfg.maxPayloadChars)
      ;(rec as any).output = c.text
      if (c.clipped) (rec as any).clipped = { ...(rec as any).clipped, output: true }
    }
    if (status === "error") {
      ;(rec as any).error = this.scr(typeof st.error === "string" ? st.error : JSON.stringify(st.error))
    }
    return [rec]
  }

  private permission(p: any): DraftRecord[] {
    if (!p?.id) return []
    return [
      {
        k: "permission",
        sid: p.sessionID ?? this.lastSid,
        ph: "asked",
        permID: p.id,
        type: p.type,
        title: p.title,
        pattern: this.scrV(p.pattern),
        mid: p.messageID,
      },
    ]
  }
}
