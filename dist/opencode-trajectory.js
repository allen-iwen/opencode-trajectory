/* opencode-trajectory — generated bundle. Source: src/  Build: npm run build */

// src/config.ts
import path from "node:path";
var DEFAULTS = {
  enabled: true,
  dir: ".opencode/trajectory",
  captureText: true,
  captureReasoning: true,
  captureToolInput: true,
  captureToolOutput: true,
  maxPayloadChars: 2e4,
  maxInputChars: 4e3,
  flushMs: 250,
  maxFileBytes: 16 * 1024 * 1024,
  redact: true,
  redactPatterns: [],
  debug: false
};
function bool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  return void 0;
}
function num(v) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : void 0;
}
function resolveConfig(opts, directory) {
  const cfg = { ...DEFAULTS, redactPatterns: [] };
  const raw = opts ?? {};
  const b = (key, ...aliases) => {
    for (const k of [key, ...aliases]) {
      const v = bool(raw[k]);
      if (v !== void 0) return v;
    }
    return void 0;
  };
  const n = (key, ...aliases) => {
    for (const k of [key, ...aliases]) {
      const v = num(raw[k]);
      if (v !== void 0) return v;
    }
    return void 0;
  };
  cfg.enabled = b("enabled") ?? DEFAULTS.enabled;
  cfg.captureText = b("captureText", "capture_text") ?? DEFAULTS.captureText;
  cfg.captureReasoning = b("captureReasoning", "capture_reasoning") ?? DEFAULTS.captureReasoning;
  cfg.captureToolInput = b("captureToolInput", "capture_tool_input") ?? DEFAULTS.captureToolInput;
  cfg.captureToolOutput = b("captureToolOutput", "capture_tool_output") ?? DEFAULTS.captureToolOutput;
  cfg.redact = b("redact") ?? DEFAULTS.redact;
  cfg.debug = b("debug") ?? DEFAULTS.debug;
  cfg.maxPayloadChars = n("maxPayloadChars", "max_payload_chars") ?? DEFAULTS.maxPayloadChars;
  cfg.maxInputChars = n("maxInputChars", "max_input_chars") ?? DEFAULTS.maxInputChars;
  cfg.flushMs = n("flushMs", "flush_ms") ?? DEFAULTS.flushMs;
  cfg.maxFileBytes = n("maxFileBytes", "max_file_bytes") ?? DEFAULTS.maxFileBytes;
  const dir = typeof raw.dir === "string" && raw.dir.trim() ? raw.dir.trim() : DEFAULTS.dir;
  cfg.dir = dir;
  if (Array.isArray(raw.redactPatterns)) {
    cfg.redactPatterns = raw.redactPatterns.filter((p) => typeof p === "string");
  }
  const env = typeof process !== "undefined" ? process.env : {};
  if (bool(env.OPENCODE_TRAJECTORY_DISABLE) === true) cfg.enabled = false;
  if (env.OPENCODE_TRAJECTORY_DIR) cfg.dir = env.OPENCODE_TRAJECTORY_DIR;
  const envDebug = bool(env.OPENCODE_TRAJECTORY_DEBUG);
  if (envDebug !== void 0) cfg.debug = envDebug;
  const envReasoning = bool(env.OPENCODE_TRAJECTORY_REASONING);
  if (envReasoning !== void 0) cfg.captureReasoning = envReasoning;
  if (env.OPENCODE_TRAJECTORY_MAX_CHARS) {
    const v = Number(env.OPENCODE_TRAJECTORY_MAX_CHARS);
    if (Number.isFinite(v)) cfg.maxPayloadChars = v;
  }
  cfg.flushMs = Math.min(Math.max(cfg.flushMs, 50), 1e4);
  cfg.maxPayloadChars = Math.max(cfg.maxPayloadChars, 0);
  cfg.maxInputChars = Math.max(cfg.maxInputChars, 0);
  cfg.maxFileBytes = Math.max(cfg.maxFileBytes, 256 * 1024);
  return cfg;
}
function resolveDir(cfg, directory) {
  return path.isAbsolute(cfg.dir) ? cfg.dir : path.resolve(directory, cfg.dir);
}

// src/redact.ts
var REDACTED = "***REDACTED***";
var SECRET_PATTERNS = [
  // OpenAI / Anthropic / Moonshot / OpenRouter style keys
  { re: /\bsk-[A-Za-z0-9_-]{6,}/g, repl: `sk-${REDACTED}` },
  // GitHub
  { re: /\bgh[pousr]_[A-Za-z0-9]{10,}/g, repl: `gh_${REDACTED}` },
  { re: /\bgithub_pat_[A-Za-z0-9_]{10,}/g, repl: `github_pat_${REDACTED}` },
  // Slack / AWS / Google
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, repl: `xox-${REDACTED}` },
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16,}/g, repl: `AWS-${REDACTED}` },
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g, repl: `AIza${REDACTED}` },
  // Bearer / basic auth headers
  { re: /\bBearer\s+[A-Za-z0-9._-]{12,}/gi, repl: `Bearer ${REDACTED}` },
  // URL credentials: scheme://user:pass@host  ->  scheme://user:***@host
  { re: /(\/\/[^\s:/@]{1,64}:)[^\s@/]{4,}(@)/g, repl: `$1${REDACTED}$2` },
  // JWT
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, repl: `eyJ${REDACTED}` }
];
var SECRET_KEYS = /^(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|client[-_]?secret|password|passwd|authorization|cookie|set-cookie|private[-_]?key|session[-_]?key|bearer)$/i;
function redactText(input, extra = []) {
  if (input.length > 8 && !/[A-Za-z0-9]{8,}/.test(input)) return input;
  let out = input;
  for (const { re, repl } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = out.replace(re, repl);
  }
  for (const re of extra) {
    re.lastIndex = 0;
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  return out;
}
function redactValue(value, extra = [], depth = 0, seen = /* @__PURE__ */ new WeakSet()) {
  if (value == null) return value;
  const t = typeof value;
  if (t === "string") return redactText(value, extra);
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "function" || t === "symbol") return void 0;
  if (depth > 12) return "[depth-limit]";
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.slice(0, 2e3).map((v) => redactValue(v, extra, depth + 1, seen));
  }
  const obj = value;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);
  const out = {};
  for (const [key, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(key)) {
      out[key] = typeof v === "string" && v.length > 0 ? `${v.slice(0, 4)}${REDACTED}` : REDACTED;
      continue;
    }
    out[key] = redactValue(v, extra, depth + 1, seen);
  }
  return out;
}
function clip(text, max) {
  if (max <= 0 || text.length <= max) return { text, clipped: false };
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return {
    text: `${text.slice(0, head)}
\u2026[trajectory: ${text.length - max} chars clipped]\u2026
${text.slice(-tail)}`,
    clipped: true
  };
}
function compileExtra(patterns) {
  const out = [];
  for (const p of patterns) {
    if (!p) continue;
    try {
      out.push(new RegExp(p, "g"));
    } catch {
    }
  }
  return out;
}

// src/normalize.ts
var DELTA_THRESHOLD = 96;
var MSG_THROTTLE_MS = 500;
function tokens(t) {
  if (!t || typeof t !== "object") return void 0;
  return {
    input: t.input ?? 0,
    output: t.output ?? 0,
    reasoning: t.reasoning ?? 0,
    cacheRead: t.cache?.read ?? 0,
    cacheWrite: t.cache?.write ?? 0
  };
}
function errInfo(e) {
  if (!e) return void 0;
  const name = typeof e.name === "string" ? e.name : "Error";
  const data = e.data ?? e;
  const message = typeof data?.message === "string" ? data.message : typeof e.message === "string" ? e.message : String(name);
  return { name, message, detail: data };
}
var Normalizer = class {
  cfg;
  extra;
  msg = /* @__PURE__ */ new Map();
  text = /* @__PURE__ */ new Map();
  tool = /* @__PURE__ */ new Map();
  lastMsgWrite = /* @__PURE__ */ new Map();
  lastStatus = /* @__PURE__ */ new Map();
  sessionSig = /* @__PURE__ */ new Map();
  userMsgSeen = /* @__PURE__ */ new Set();
  /** Metadata for sessions discovered at startup; written only if they produce events. */
  primed = /* @__PURE__ */ new Map();
  sessionWritten = /* @__PURE__ */ new Set();
  pending = /* @__PURE__ */ new Map();
  lastSid = "";
  constructor(cfg) {
    this.cfg = cfg;
    this.extra = compileExtra(cfg.redactPatterns);
  }
  get lastSession() {
    return this.lastSid;
  }
  scr(s) {
    return this.cfg.redact ? redactText(s, this.extra) : s;
  }
  scrV(v) {
    return this.cfg.redact ? redactValue(v, this.extra) : v;
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
  primeSessions(list) {
    for (const info of list) if (info?.id) this.primed.set(info.id, info);
  }
  /** Prepend the session record if this session has not been described yet. */
  withSession(recs) {
    if (!recs.length) return recs;
    const sid = recs[0].sid;
    if (!sid || this.sessionWritten.has(sid)) return recs;
    const info = this.primed.get(sid);
    if (!info) return recs;
    this.sessionWritten.add(sid);
    const rec = this.buildSession(info);
    rec.ev = "session.prime";
    return [rec, ...recs];
  }
  /** Emit any buffered sub-threshold text deltas. Called on idle / dispose. */
  flushPending() {
    const out = [];
    for (const [pid, p] of this.pending) {
      const buf = this.buf.get(pid);
      if (!buf) continue;
      this.buf.delete(pid);
      out.push({
        k: p.kind,
        sid: p.sid,
        mid: p.mid,
        pid,
        d: buf,
        syn: p.syn ? 1 : void 0,
        ev: "message.part.updated"
      });
    }
    this.pending.clear();
    return out;
  }
  /** Unwritten delta characters, keyed by part id. */
  buf = /* @__PURE__ */ new Map();
  /** Track text growth and return a delta record when the threshold is met. */
  textDelta(sid, mid, part, kind, syn, start, end) {
    const pid = part.id;
    const full = typeof part.text === "string" ? part.text : "";
    const prev = this.text.get(pid);
    let delta;
    let reset = false;
    if (!prev) {
      delta = full;
      reset = false;
    } else if (full === prev.text) {
      return [];
    } else if (full.startsWith(prev.text)) {
      delta = full.slice(prev.text.length);
    } else {
      delta = full;
      reset = true;
    }
    this.text.set(pid, { text: full, syn });
    if (!delta) return [];
    if (reset) this.buf.delete(pid);
    const buffered = (this.buf.get(pid) ?? "") + delta;
    this.buf.set(pid, buffered);
    this.pending.set(pid, { sid, mid, kind, syn });
    if (!reset && buffered.length < DELTA_THRESHOLD && end === void 0) return [];
    this.buf.delete(pid);
    this.pending.delete(pid);
    const out = this.scr(buffered);
    const c = clip(out, this.cfg.maxPayloadChars);
    const rec = {
      k: kind,
      sid,
      mid,
      pid,
      d: c.text,
      ...reset ? { r: 1 } : {},
      ...syn ? { syn: 1 } : {},
      ...start !== void 0 ? { t0: start } : {},
      ...end !== void 0 ? { t1: end } : {}
    };
    return [rec];
  }
  // ---------------------------------------------------------------- user turn
  /**
   * From the `chat.message` hook. This is the authoritative moment a user turn
   * starts — it already carries a stable messageID, so the event stream's later
   * `message.part.updated` for the same parts can be skipped.
   */
  userTurn(input, output) {
    const msg = output?.message;
    if (!msg?.id) return [];
    const mid = msg.id;
    if (this.userMsgSeen.has(mid)) return [];
    this.userMsgSeen.add(mid);
    this.lastSid = input.sessionID;
    const recs = [];
    const agent = msg.agent ?? input.agent;
    const providerID = msg.model?.providerID ?? input.model?.providerID;
    const modelID = msg.model?.modelID ?? input.model?.modelID;
    this.msg.set(mid, { role: "user", agent, providerID, modelID, sig: "user" });
    recs.push({
      k: "message",
      sid: input.sessionID,
      mid,
      role: "user",
      agent,
      providerID,
      modelID,
      time: { created: msg.time?.created ?? Date.now() }
    });
    for (const p of output.parts ?? []) {
      if (p?.type !== "text" || typeof p.text !== "string" || !p.text) continue;
      const c = clip(this.scr(p.text), this.cfg.maxPayloadChars);
      recs.push({
        k: "text",
        sid: input.sessionID,
        mid,
        pid: p.id,
        d: c.text,
        ...p.synthetic ? { syn: 1 } : {}
      });
      this.text.set(p.id, { text: p.text, syn: !!p.synthetic });
    }
    for (const r of recs) r.ev = "chat.message";
    return this.withSession(recs);
  }
  // ------------------------------------------------------------------- events
  /** Accepts either a bare `Event` or the `{directory, payload}` wrapper. */
  event(raw) {
    const e = raw && typeof raw === "object" && "payload" in raw && "directory" in raw ? raw.payload : raw;
    if (!e || typeof e.type !== "string") return [];
    try {
      const recs = this.dispatch(e);
      for (const r of recs) r.ev = e.type;
      return this.withSession(recs);
    } catch {
      return [];
    }
  }
  dispatch(e) {
    const p = e.properties ?? {};
    switch (e.type) {
      case "session.created":
      case "session.updated":
        return this.session(p.info);
      case "session.idle":
        this.lastSid = p.sessionID;
        return this.statusRecord(p.sessionID, "idle");
      case "session.status": {
        this.lastSid = p.sessionID;
        const s = p.status ?? {};
        if (s.type === "retry") {
          return [{ k: "status", sid: p.sessionID, st: "retry", attempt: s.attempt, message: s.message, next: s.next }];
        }
        return this.statusRecord(p.sessionID, s.type === "busy" ? "busy" : "idle");
      }
      case "session.error": {
        const info = errInfo(p.error);
        if (!info) return [];
        const sid = p.sessionID ?? this.lastSid;
        return [{ k: "error", sid, name: info.name, message: this.scr(info.message), detail: this.scrV(info.detail) }];
      }
      case "session.compacted":
        return [{ k: "compact", sid: p.sessionID, ph: "finish" }];
      case "message.updated":
        return this.message(p.info);
      case "message.part.updated":
        return this.part(p.part);
      case "permission.updated":
      case "permission.asked":
        return this.permission(p);
      case "permission.replied":
        return [
          {
            k: "permission",
            sid: p.sessionID,
            ph: "replied",
            permID: p.permissionID,
            response: p.response
          }
        ];
      case "file.edited":
        return [{ k: "file", sid: p.sessionID ?? this.lastSid, file: p.file, op: "change" }];
      default:
        return [];
    }
  }
  buildSession(info) {
    return {
      k: "session",
      sid: info.id,
      id: info.id,
      parentID: info.parentID,
      title: info.title,
      directory: info.directory
    };
  }
  session(info) {
    if (!info?.id) return [];
    this.lastSid = info.id;
    this.sessionWritten.add(info.id);
    const sig = `${info.title ?? ""}|${info.parentID ?? ""}|${info.directory ?? ""}`;
    if (this.sessionSig.get(info.id) === sig) return [];
    this.sessionSig.set(info.id, sig);
    return [this.buildSession(info)];
  }
  /** Emit a status record only when the session actually changes state. */
  statusRecord(sid, st) {
    if (!sid || this.lastStatus.get(sid) === st) return [];
    this.lastStatus.set(sid, st);
    return [{ k: "status", sid, st }];
  }
  message(info) {
    if (!info?.id || !info.sessionID) return [];
    const mid = info.id;
    const role = info.role === "user" ? "user" : "assistant";
    this.lastSid = info.sessionID;
    if (role === "user" && this.userMsgSeen.has(mid)) return [];
    const tk = tokens(info.tokens);
    const err = errInfo(info.error);
    const sig = [role, info.time?.completed ?? 0, info.finish ?? "", tk ? `${tk.input}/${tk.output}/${tk.reasoning}/${tk.cacheRead}/${tk.cacheWrite}` : "", info.cost ?? 0, err?.name ?? ""].join("|");
    const prev = this.msg.get(mid);
    if (prev && prev.sig === sig) return [];
    const final = !prev || !!info.time?.completed || !!info.finish || !!err;
    const now = Date.now();
    if (!final && now - (this.lastMsgWrite.get(mid) ?? 0) < MSG_THROTTLE_MS) return [];
    this.msg.set(mid, {
      role,
      agent: info.mode ?? info.agent,
      providerID: info.providerID ?? info.model?.providerID,
      modelID: info.modelID ?? info.model?.modelID,
      sig
    });
    this.lastMsgWrite.set(mid, now);
    return [
      {
        k: "message",
        sid: info.sessionID,
        mid,
        role,
        agent: info.mode ?? info.agent,
        providerID: info.providerID ?? info.model?.providerID,
        modelID: info.modelID ?? info.model?.modelID,
        parentID: role === "assistant" ? info.parentID : void 0,
        time: { created: info.time?.created ?? now, completed: info.time?.completed },
        tokens: tk,
        cost: typeof info.cost === "number" ? info.cost : void 0,
        finish: info.finish,
        ...err ? { error: { name: err.name, message: this.scr(err.message) } } : {}
      }
    ];
  }
  part(part) {
    if (!part?.id || !part.sessionID || part.type === void 0) return [];
    const sid = part.sessionID;
    const mid = part.messageID;
    this.lastSid = sid;
    switch (part.type) {
      case "text": {
        if (!this.cfg.captureText) return [];
        if (this.msg.get(mid)?.role === "user") return [];
        return this.textDelta(sid, mid, part, "text", !!part.synthetic, part.time?.start, part.time?.end);
      }
      case "reasoning": {
        if (!this.cfg.captureReasoning || !this.cfg.captureText) return [];
        return this.textDelta(sid, mid, part, "reasoning", false, part.time?.start, part.time?.end);
      }
      case "tool":
        return this.toolPart(part, sid, mid);
      case "step-start":
        return [{ k: "step", sid, mid, pid: part.id, ph: "start", snapshot: part.snapshot }];
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
            snapshot: part.snapshot
          }
        ];
      case "subtask": {
        const pr = clip(this.scr(part.prompt ?? ""), this.cfg.maxPayloadChars);
        return [
          {
            k: "subtask",
            sid,
            mid,
            pid: part.id,
            agent: part.agent ?? "?",
            description: this.scr(part.description ?? ""),
            prompt: pr.text,
            ...pr.clipped ? { clipped: { prompt: true } } : {}
          }
        ];
      }
      case "retry": {
        const info = errInfo(part.error);
        const out = [];
        if (info) out.push({ k: "error", sid, mid, name: info.name, message: this.scr(info.message) });
        return out;
      }
      case "compaction":
        return [{ k: "compact", sid, ph: "start" }];
      case "patch": {
        const files = Array.isArray(part.files) ? part.files : [];
        return files.filter((f) => typeof f?.file === "string").slice(0, 100).map((f) => ({ k: "file", sid, file: f.file, op: "change" }));
      }
      default:
        return [];
    }
  }
  toolPart(part, sid, mid) {
    const st = part.state ?? {};
    const status = st.status ?? "pending";
    const prev = this.tool.get(part.id);
    if (prev) {
      if (prev.st === status) return [];
      if (prev.st === "completed" || prev.st === "error") return [];
    }
    this.tool.set(part.id, { st: status });
    const meta = this.msg.get(mid);
    const rec = {
      k: "tool",
      sid,
      mid,
      pid: part.id,
      callID: part.callID,
      tool: part.tool,
      st: status,
      agent: meta?.agent,
      t0: st.time?.start,
      t1: st.time?.end
    };
    if (this.cfg.captureToolInput && st.input !== void 0) {
      const redacted = this.scrV(st.input);
      const probe = JSON.stringify(redacted);
      if (probe && probe.length > this.cfg.maxInputChars) {
        const c = clip(probe, this.cfg.maxInputChars);
        rec.input = c.text;
        rec.clipped = { ...rec.clipped, input: true };
      } else {
        ;
        rec.input = redacted;
      }
    }
    if (typeof st.title === "string" && st.title) rec.title = this.scr(st.title);
    if (status === "completed" && this.cfg.captureToolOutput && typeof st.output === "string") {
      const c = clip(this.scr(st.output), this.cfg.maxPayloadChars);
      rec.output = c.text;
      if (c.clipped) rec.clipped = { ...rec.clipped, output: true };
    }
    if (status === "error") {
      ;
      rec.error = this.scr(typeof st.error === "string" ? st.error : JSON.stringify(st.error));
    }
    return [rec];
  }
  permission(p) {
    if (!p?.id) return [];
    return [
      {
        k: "permission",
        sid: p.sessionID ?? this.lastSid,
        ph: "asked",
        permID: p.id,
        type: p.type,
        title: p.title,
        pattern: this.scrV(p.pattern),
        mid: p.messageID
      }
    ];
  }
};

// src/store.ts
import fs from "node:fs";
import path2 from "node:path";

// src/types.ts
var RECORD_VERSION = 1;

// src/store.ts
var MAX_BUFFER = 64 * 1024;
function sanitize(id) {
  const s = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_").replace(/^[.\-_]+/, "").slice(0, 100);
  return s || "unknown";
}
var Store = class {
  root;
  sessionsDir;
  cfg;
  writers = /* @__PURE__ */ new Map();
  seq = 0;
  closed = false;
  warned = false;
  constructor(dir, cfg) {
    this.cfg = cfg;
    this.root = dir;
    this.sessionsDir = path2.join(dir, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.writeMeta();
  }
  writeMeta() {
    const meta = {
      tool: "opencode-trajectory",
      version: RECORD_VERSION,
      dir: this.root,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      pid: typeof process !== "undefined" ? process.pid : void 0
    };
    try {
      fs.writeFileSync(path2.join(this.root, "_boot.json"), JSON.stringify(meta, null, 2), "utf8");
      fs.appendFileSync(
        path2.join(this.root, "_boot.log"),
        `${(/* @__PURE__ */ new Date()).toISOString()}	pid=${meta.pid}	dir=${this.root}
`,
        "utf8"
      );
    } catch {
    }
  }
  fileFor(sid) {
    return path2.join(this.sessionsDir, `${sanitize(sid)}.jsonl`);
  }
  writer(sid) {
    let w = this.writers.get(sid);
    if (w) return w;
    const file = this.fileFor(sid);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    w = { buf: [], bytes: 0, size, timer: null, file, warned: false };
    this.writers.set(sid, w);
    return w;
  }
  /** Stamp and enqueue records. Never throws. */
  write(recs) {
    if (this.closed || !recs || recs.length === 0) return;
    for (const d of recs) {
      let line;
      try {
        line = JSON.stringify({ ...d, v: RECORD_VERSION, seq: ++this.seq, ts: Date.now() }) + "\n";
      } catch {
        continue;
      }
      try {
        const w = this.writer(d.sid);
        w.buf.push(line);
        w.bytes += line.length;
        if (w.bytes >= MAX_BUFFER) this.flush(d.sid);
        else this.schedule(d.sid, w);
      } catch {
      }
    }
  }
  schedule(sid, w) {
    if (w.timer) return;
    const t = setTimeout(() => {
      w.timer = null;
      this.flush(sid);
    }, this.cfg.flushMs);
    if (typeof t.unref === "function") t.unref();
    w.timer = t;
  }
  flush(sid) {
    if (sid) {
      const w = this.writers.get(sid);
      if (w) this.flushOne(w);
      return;
    }
    for (const w of this.writers.values()) this.flushOne(w);
  }
  flushOne(w) {
    if (w.timer) {
      clearTimeout(w.timer);
      w.timer = null;
    }
    if (w.buf.length === 0) return;
    const chunk = w.buf.join("");
    w.buf = [];
    w.bytes = 0;
    try {
      fs.appendFileSync(w.file, chunk, "utf8");
      w.size += chunk.length;
      if (w.size > this.cfg.maxFileBytes) this.rotate(w);
    } catch (e) {
      if (!w.warned) {
        w.warned = true;
        this.report(`trajectory: cannot write ${w.file}: ${e.message}`);
      }
    }
  }
  /** Roll the journal so a single session can't grow without bound. */
  rotate(w) {
    const archived = `${w.file.replace(/\.jsonl$/, "")}.1.jsonl`;
    try {
      if (fs.existsSync(archived)) fs.rmSync(archived, { force: true });
      fs.renameSync(w.file, archived);
      w.size = 0;
      this.write([
        {
          k: "harness",
          sid: path2.basename(w.file, ".jsonl"),
          ev: "rotate",
          detail: `previous journal archived to ${path2.basename(archived)}`
        }
      ]);
    } catch {
      w.size = 0;
    }
  }
  /** Flush everything and stop all timers. Safe to call twice. */
  close() {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.writers.clear();
  }
  report(msg) {
    if (this.cfg.debug) {
      try {
        process.stderr.write(`${msg}
`);
      } catch {
      }
    }
  }
};

// src/index.ts
var TAG = "opencode-trajectory";
var SINGLETON = "__opencode_trajectory_active__";
var TrajectoryPlugin = async (input, options) => {
  let store;
  let norm;
  const g = globalThis;
  const slot = `${SINGLETON}:${input.directory}`;
  try {
    if (g[slot]) return {};
    const cfg = resolveConfig(options, input.directory);
    if (!cfg.enabled) return {};
    g[slot] = true;
    const dir = resolveDir(cfg, input.directory);
    norm = new Normalizer(cfg);
    store = new Store(dir, cfg);
    const n = norm;
    const s = store;
    if (cfg.debug) process.stderr.write(`${TAG}: recording to ${dir}
`);
    let reported = false;
    const softFail = (where, e) => {
      if (reported) return;
      reported = true;
      void input.client.app.log({
        body: {
          service: TAG,
          level: "warn",
          message: `trajectory hook failed in ${where}`,
          extra: { error: e instanceof Error ? e.message : String(e) }
        }
      }).catch(() => {
      });
    };
    void (async () => {
      try {
        const res = await input.client.session.list({ query: { directory: input.directory } });
        const list = res?.data ?? res;
        if (Array.isArray(list)) n.primeSessions(list);
      } catch (e) {
        softFail("bootstrap", e);
      }
    })();
    return {
      event: async ({ event }) => {
        try {
          s.write(n.event(event));
          const t = event?.type ?? event?.payload?.type;
          if (t === "session.idle" || t === "session.compacted") s.write(n.flushPending());
        } catch (e) {
          softFail("event", e);
        }
      },
      "chat.message": async (i, o) => {
        try {
          s.write(n.userTurn(i, o));
        } catch (e) {
          softFail("chat.message", e);
        }
      },
      dispose: async () => {
        try {
          s.write(n.flushPending());
          s.close();
        } catch {
        }
        delete g[slot];
      }
    };
  } catch (e) {
    if (process.env.OPENCODE_TRAJECTORY_DEBUG) {
      process.stderr.write(`${TAG}: disabled (${e instanceof Error ? e.message : String(e)})
`);
    }
    try {
      store?.close();
    } catch {
    }
    delete g[slot];
    return {};
  }
};
var index_default = TrajectoryPlugin;
export {
  TrajectoryPlugin,
  index_default as default
};
