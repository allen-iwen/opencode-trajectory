/**
 * Secret scrubbing.
 *
 * Trajectory logs are the most dangerous artifact an agent harness can produce:
 * they contain full tool inputs (often `curl -H "Authorization: ..."`), full
 * tool outputs (often `.env` reads), and full model prompts. A log that leaks
 * one key is worse than no log at all.
 *
 * Strategy: keep shape, drop entropy. `sk-MNdMIW0w...` becomes
 * `sk-MNdM***REDACTED***` so a human can still tell *which* key was used while
 * the secret itself is unrecoverable.
 */

const REDACTED = "***REDACTED***"

/** Each pattern keeps a short recognizable prefix so logs stay diagnosable. */
const SECRET_PATTERNS: Array<{ re: RegExp; repl: string }> = [
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
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, repl: `eyJ${REDACTED}` },
]

/** Object keys whose values are secrets regardless of shape. */
const SECRET_KEYS =
  /^(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|secret|client[-_]?secret|password|passwd|authorization|cookie|set-cookie|private[-_]?key|session[-_]?key|bearer)$/i

export function redactText(input: string, extra: RegExp[] = []): string {
  // Cheap early-out: no plausible secret marker, no regex work.
  if (input.length > 8 && !/[A-Za-z0-9]{8,}/.test(input)) return input
  let out = input
  for (const { re, repl } of SECRET_PATTERNS) {
    re.lastIndex = 0
    if (!re.test(out)) continue
    re.lastIndex = 0
    out = out.replace(re, repl)
  }
  for (const re of extra) {
    re.lastIndex = 0
    if (!re.test(out)) continue
    re.lastIndex = 0
    out = out.replace(re, REDACTED)
  }
  return out
}

/** Deep-clone + scrub. Cycles are cut, depth/size are bounded. */
export function redactValue(
  value: unknown,
  extra: RegExp[] = [],
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value == null) return value
  const t = typeof value
  if (t === "string") return redactText(value as string, extra)
  if (t === "number" || t === "boolean") return value
  if (t === "bigint") return String(value)
  if (t === "function" || t === "symbol") return undefined
  if (depth > 12) return "[depth-limit]"

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]"
    seen.add(value)
    return value.slice(0, 2000).map((v) => redactValue(v, extra, depth + 1, seen))
  }

  const obj = value as Record<string, unknown>
  if (seen.has(obj)) return "[circular]"
  seen.add(obj)
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(key)) {
      out[key] = typeof v === "string" && v.length > 0 ? `${v.slice(0, 4)}${REDACTED}` : REDACTED
      continue
    }
    out[key] = redactValue(v, extra, depth + 1, seen)
  }
  return out
}

export interface ClipResult {
  text: string
  clipped: boolean
}

/**
 * Truncate keeping head and tail — the middle of a 5 MB tool output is usually
 * noise, while the head (what ran) and tail (how it failed) are the signal.
 */
export function clip(text: string, max: number): ClipResult {
  if (max <= 0 || text.length <= max) return { text, clipped: false }
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return {
    text: `${text.slice(0, head)}\n…[trajectory: ${text.length - max} chars clipped]…\n${text.slice(-tail)}`,
    clipped: true,
  }
}

/** Compile user-supplied extra patterns once, ignoring invalid ones. */
export function compileExtra(patterns: string[]): RegExp[] {
  const out: RegExp[] = []
  for (const p of patterns) {
    if (!p) continue
    try {
      out.push(new RegExp(p, "g"))
    } catch {
      /* invalid user pattern: skip rather than break recording */
    }
  }
  return out
}
