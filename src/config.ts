import path from "node:path"
import type { TrajectoryConfig, PluginOptions } from "./types.ts"

export const DEFAULTS: TrajectoryConfig = {
  enabled: true,
  dir: ".opencode/trajectory",
  captureText: true,
  captureReasoning: true,
  captureToolInput: true,
  captureToolOutput: true,
  maxPayloadChars: 20_000,
  maxInputChars: 4_000,
  flushMs: 250,
  maxFileBytes: 16 * 1024 * 1024,
  redact: true,
  redactPatterns: [],
  debug: false,
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    if (["1", "true", "yes", "on"].includes(s)) return true
    if (["0", "false", "no", "off"].includes(s)) return false
  }
  return undefined
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/**
 * Options arrive from `opencode.json`:
 *   "plugin": [["./plugins/trajectory.ts", { "captureReasoning": false }]]
 * and are additionally overridable by env vars so a one-off run can be muted
 * without editing config (useful in CI).
 */
export function resolveConfig(opts: PluginOptions | undefined, directory: string): TrajectoryConfig {
  const cfg: TrajectoryConfig = { ...DEFAULTS, redactPatterns: [] }
  const raw = (opts ?? {}) as Record<string, unknown>

  const b = (key: keyof TrajectoryConfig, ...aliases: string[]) => {
    for (const k of [key as string, ...aliases]) {
      const v = bool(raw[k])
      if (v !== undefined) return v
    }
    return undefined
  }
  const n = (key: keyof TrajectoryConfig, ...aliases: string[]) => {
    for (const k of [key as string, ...aliases]) {
      const v = num(raw[k])
      if (v !== undefined) return v
    }
    return undefined
  }

  cfg.enabled = b("enabled") ?? DEFAULTS.enabled
  cfg.captureText = b("captureText", "capture_text") ?? DEFAULTS.captureText
  cfg.captureReasoning = b("captureReasoning", "capture_reasoning") ?? DEFAULTS.captureReasoning
  cfg.captureToolInput = b("captureToolInput", "capture_tool_input") ?? DEFAULTS.captureToolInput
  cfg.captureToolOutput = b("captureToolOutput", "capture_tool_output") ?? DEFAULTS.captureToolOutput
  cfg.redact = b("redact") ?? DEFAULTS.redact
  cfg.debug = b("debug") ?? DEFAULTS.debug

  cfg.maxPayloadChars = n("maxPayloadChars", "max_payload_chars") ?? DEFAULTS.maxPayloadChars
  cfg.maxInputChars = n("maxInputChars", "max_input_chars") ?? DEFAULTS.maxInputChars
  cfg.flushMs = n("flushMs", "flush_ms") ?? DEFAULTS.flushMs
  cfg.maxFileBytes = n("maxFileBytes", "max_file_bytes") ?? DEFAULTS.maxFileBytes

  const dir = typeof raw.dir === "string" && raw.dir.trim() ? raw.dir.trim() : DEFAULTS.dir
  cfg.dir = dir

  if (Array.isArray(raw.redactPatterns)) {
    cfg.redactPatterns = raw.redactPatterns.filter((p): p is string => typeof p === "string")
  }

  // env overrides
  const env = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>
  if (bool(env.OPENCODE_TRAJECTORY_DISABLE) === true) cfg.enabled = false
  if (env.OPENCODE_TRAJECTORY_DIR) cfg.dir = env.OPENCODE_TRAJECTORY_DIR
  const envDebug = bool(env.OPENCODE_TRAJECTORY_DEBUG)
  if (envDebug !== undefined) cfg.debug = envDebug
  const envReasoning = bool(env.OPENCODE_TRAJECTORY_REASONING)
  if (envReasoning !== undefined) cfg.captureReasoning = envReasoning
  if (env.OPENCODE_TRAJECTORY_MAX_CHARS) {
    const v = Number(env.OPENCODE_TRAJECTORY_MAX_CHARS)
    if (Number.isFinite(v)) cfg.maxPayloadChars = v
  }

  // hard floors so a misconfiguration can't melt the event loop
  cfg.flushMs = Math.min(Math.max(cfg.flushMs, 50), 10_000)
  cfg.maxPayloadChars = Math.max(cfg.maxPayloadChars, 0)
  cfg.maxInputChars = Math.max(cfg.maxInputChars, 0)
  cfg.maxFileBytes = Math.max(cfg.maxFileBytes, 256 * 1024)

  return cfg
}

export function resolveDir(cfg: TrajectoryConfig, directory: string): string {
  return path.isAbsolute(cfg.dir) ? cfg.dir : path.resolve(directory, cfg.dir)
}
