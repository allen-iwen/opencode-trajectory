/**
 * Trajectory record model.
 *
 * Design contract (append-only):
 *  - Every line in a `.jsonl` file is a self-describing record.
 *  - Records are NEVER mutated or deleted. State is derived by folding the log.
 *  - Records that describe a mutable entity (`part`, `tool`, `message`) carry a
 *    stable `id`; the LAST record with a given id wins. This gives us
 *    append-only semantics without rewriting files.
 *  - `text` / `reasoning` use prefix-delta records (`d`) instead of repeated
 *    full snapshots, so a long streamed answer costs O(n) bytes, not O(n^2).
 */

export const RECORD_VERSION = 1 as const

/** Where a step originated. Mirrors DSH's "source" tag concept. */
export type Source =
  | "user" // human input
  | "assistant" // model output
  | "tool" // tool execution
  | "subagent" // nested agent session
  | "system" // compaction / injected context / system level
  | "harness" // recording harness itself (truncation, rotation, errors)

export type ToolStatus = "pending" | "running" | "completed" | "error"

interface Base {
  /** record schema version */
  v: typeof RECORD_VERSION
  /** monotonic sequence, per writer process */
  seq: number
  /** wall clock ms when the record was produced */
  ts: number
  /** session id */
  sid: string
  /**
   * The OpenCode event that produced this record, verbatim
   * (e.g. `message.part.updated`, `session.status`).
   *
   * Records are normalized — they lose the shape of their origin. The audit
   * view needs to answer "which event is this line?", so the name is kept.
   * Costs ~24 bytes per record and doubles as a debugging aid.
   */
  ev?: string
}

/** Session lifecycle + lineage. Parent link is what builds the agent tree. */
export interface SessionRecord extends Base {
  k: "session"
  id: string
  parentID?: string
  title?: string
  directory?: string
  /** marks the first record of a writer for this session in this process */
  resumed?: boolean
}

/** Assistant / user message level facts: model, tokens, cost, timing. */
export interface MessageRecord extends Base {
  k: "message"
  mid: string
  role: "user" | "assistant"
  agent?: string
  providerID?: string
  modelID?: string
  parentID?: string
  time: { created: number; completed?: number }
  tokens?: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
  cost?: number
  finish?: string
  error?: { name: string; message: string }
}

/**
 * Streamed text. `d` is the appended delta. `r: 1` means "reset" — the part
 * was rewritten (edit / revert / regenerate), discard previous accumulation.
 */
export interface TextRecord extends Base {
  k: "text" | "reasoning"
  pid: string
  mid: string
  d: string
  r?: 1
  /** 1 = injected/synthetic content (system reminders, file context), not model output */
  syn?: 1
  t0?: number
  t1?: number
}

/** Tool call. Repeated records for the same pid describe state transitions. */
export interface ToolRecord extends Base {
  k: "tool"
  pid: string
  mid: string
  callID: string
  tool: string
  st: ToolStatus
  /** owning agent name, filled from the message that spawned the call */
  agent?: string
  input?: unknown
  output?: string
  title?: string
  error?: string
  /** truncated marker flags, so a reader never confuses clipping with data loss */
  clipped?: { input?: boolean; output?: boolean }
  t0?: number
  t1?: number
}

/** One LLM round-trip boundary inside an assistant message. */
export interface StepRecord extends Base {
  k: "step"
  pid: string
  mid: string
  ph: "start" | "finish"
  reason?: string
  cost?: number
  tokens?: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
  snapshot?: string
}

/** Errors raised by provider, tool permissions, aborts, output-length. */
export interface ErrorRecord extends Base {
  k: "error"
  mid?: string
  name: string
  message: string
  /** detail blob (provider data, stack) — already redacted */
  detail?: unknown
}

/** Session status transitions: busy / retry(attempt,next) / idle. */
export interface StatusRecord extends Base {
  k: "status"
  st: "busy" | "idle" | "retry"
  attempt?: number
  message?: string
  next?: number
}

export interface CompactRecord extends Base {
  k: "compact"
  ph: "start" | "finish"
}

/** Permission prompts are a first-class trajectory event: they gate tool use. */
export interface PermissionRecord extends Base {
  k: "permission"
  ph: "asked" | "replied"
  permID: string
  type?: string
  title?: string
  pattern?: unknown
  response?: string
  mid?: string
}

/** File mutation produced by a tool, when the harness reports it. */
export interface FileEditRecord extends Base {
  k: "file"
  file: string
  op: "add" | "change" | "unlink"
}

/** Sub-agent spawn request embedded in an assistant message. */
export interface SubtaskRecord extends Base {
  k: "subtask"
  pid: string
  mid: string
  agent: string
  description: string
  prompt: string
  clipped?: { prompt?: boolean }
}

/**
 * Harness self-report. Written when a payload was clipped, a file rotated, or
 * the recorder itself failed — keeps the log honest about its own gaps.
 */
export interface HarnessRecord extends Base {
  k: "harness"
  ev: "clip" | "rotate" | "error" | "drop"
  detail: string
  n?: number
}

export type TraceRecord =
  | SessionRecord
  | MessageRecord
  | TextRecord
  | ToolRecord
  | StepRecord
  | ErrorRecord
  | StatusRecord
  | CompactRecord
  | PermissionRecord
  | FileEditRecord
  | SubtaskRecord
  | HarnessRecord

export type RecordKind = TraceRecord["k"]

export interface TrajectoryConfig {
  /** master switch */
  enabled: boolean
  /** output directory, absolute or relative to the session directory */
  dir: string
  /** record model/user text content at all (off = metadata only) */
  captureText: boolean
  /** record reasoning / chain-of-thought parts */
  captureReasoning: boolean
  /** record tool input args */
  captureToolInput: boolean
  /** record tool output text */
  captureToolOutput: boolean
  /** max chars kept for any single text/output/prompt payload */
  maxPayloadChars: number
  /** max chars for tool input JSON */
  maxInputChars: number
  /** flush interval for the write buffer, ms */
  flushMs: number
  /** max journal size per session file before rotation, bytes */
  maxFileBytes: number
  /** rewrite secrets (sk-*, bearer, api keys) before writing */
  redact: boolean
  /** extra regex sources treated as secrets */
  redactPatterns: string[]
  /** also mirror every record to stderr (debug only) */
  debug: boolean
}

export type PluginOptions = Partial<TrajectoryConfig> & Record<string, unknown>
