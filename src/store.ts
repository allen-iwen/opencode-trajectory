import fs from "node:fs"
import path from "node:path"
import { RECORD_VERSION, type TrajectoryConfig } from "./types.ts"
import type { DraftRecord } from "./normalize.ts"

/**
 * Append-only journal writer.
 *
 * One file per session, one JSON record per line. The `sessions/` split keeps
 * concurrent sub-agent sessions from interleaving and lets a reader load a
 * single conversation without scanning the whole project.
 *
 * Durability trade-off: writes are buffered for `flushMs` and flushed with a
 * synchronous append. A hard kill can lose at most that window, which is the
 * right price — an agent turn that loses 200 ms of trajectory is still useful,
 * while an fsync per token would wreck throughput.
 */

interface Writer {
  buf: string[]
  bytes: number
  size: number
  timer: ReturnType<typeof setTimeout> | null
  file: string
  /** true once a write failure has been reported, to avoid a per-flush log storm */
  warned: boolean
}

const MAX_BUFFER = 64 * 1024

function sanitize(id: string): string {
  const s = id
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[.\-_]+/, "")
    .slice(0, 100)
  return s || "unknown"
}

export class Store {
  readonly root: string
  readonly sessionsDir: string
  private cfg: TrajectoryConfig
  private writers = new Map<string, Writer>()
  private seq = 0
  private closed = false
  private warned = false

  constructor(dir: string, cfg: TrajectoryConfig) {
    this.cfg = cfg
    this.root = dir
    this.sessionsDir = path.join(dir, "sessions")
    fs.mkdirSync(this.sessionsDir, { recursive: true })
    this.writeMeta()
  }

  private writeMeta(): void {
    const meta = {
      tool: "opencode-trajectory",
      version: RECORD_VERSION,
      dir: this.root,
      startedAt: new Date().toISOString(),
      pid: typeof process !== "undefined" ? process.pid : undefined,
    }
    try {
      fs.writeFileSync(path.join(this.root, "_boot.json"), JSON.stringify(meta, null, 2), "utf8")
      fs.appendFileSync(
        path.join(this.root, "_boot.log"),
        `${new Date().toISOString()}\tpid=${meta.pid}\tdir=${this.root}\n`,
        "utf8",
      )
    } catch {
      /* read-only FS: recording silently degrades to a no-op below */
    }
  }

  private fileFor(sid: string): string {
    return path.join(this.sessionsDir, `${sanitize(sid)}.jsonl`)
  }

  private writer(sid: string): Writer {
    let w = this.writers.get(sid)
    if (w) return w
    const file = this.fileFor(sid)
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      size = 0
    }
    w = { buf: [], bytes: 0, size, timer: null, file, warned: false }
    this.writers.set(sid, w)
    return w
  }

  /** Stamp and enqueue records. Never throws. */
  write(recs: DraftRecord[] | undefined): void {
    if (this.closed || !recs || recs.length === 0) return
    for (const d of recs) {
      let line: string
      try {
        line = JSON.stringify({ ...d, v: RECORD_VERSION, seq: ++this.seq, ts: Date.now() }) + "\n"
      } catch {
        continue // unserializable payload (cycle in metadata) — drop, keep going
      }
      try {
        const w = this.writer(d.sid)
        w.buf.push(line)
        w.bytes += line.length
        if (w.bytes >= MAX_BUFFER) this.flush(d.sid)
        else this.schedule(d.sid, w)
      } catch {
        /* ignore: recording must never break the agent loop */
      }
    }
  }

  private schedule(sid: string, w: Writer): void {
    if (w.timer) return
    const t = setTimeout(() => {
      w.timer = null
      this.flush(sid)
    }, this.cfg.flushMs)
    // Never hold the host process open just for a pending flush.
    if (typeof (t as any).unref === "function") (t as any).unref()
    w.timer = t
  }

  flush(sid?: string): void {
    if (sid) {
      const w = this.writers.get(sid)
      if (w) this.flushOne(w)
      return
    }
    for (const w of this.writers.values()) this.flushOne(w)
  }

  private flushOne(w: Writer): void {
    if (w.timer) {
      clearTimeout(w.timer)
      w.timer = null
    }
    if (w.buf.length === 0) return
    const chunk = w.buf.join("")
    w.buf = []
    w.bytes = 0
    try {
      fs.appendFileSync(w.file, chunk, "utf8")
      w.size += chunk.length
      if (w.size > this.cfg.maxFileBytes) this.rotate(w)
    } catch (e) {
      if (!w.warned) {
        w.warned = true
        this.report(`trajectory: cannot write ${w.file}: ${(e as Error).message}`)
      }
    }
  }

  /** Roll the journal so a single session can't grow without bound. */
  private rotate(w: Writer): void {
    const archived = `${w.file.replace(/\.jsonl$/, "")}.1.jsonl`
    try {
      if (fs.existsSync(archived)) fs.rmSync(archived, { force: true })
      fs.renameSync(w.file, archived)
      w.size = 0
      this.write([
        {
          k: "harness",
          sid: path.basename(w.file, ".jsonl"),
          ev: "rotate",
          detail: `previous journal archived to ${path.basename(archived)}`,
        },
      ])
    } catch {
      /* rotation is best effort; keep appending to the original file */
      w.size = 0
    }
  }

  /** Flush everything and stop all timers. Safe to call twice. */
  close(): void {
    if (this.closed) return
    this.flush()
    this.closed = true
    this.writers.clear()
  }

  private report(msg: string): void {
    if (this.cfg.debug) {
      try {
        process.stderr.write(`${msg}\n`)
      } catch {
        /* nothing left to do */
      }
    }
  }
}
