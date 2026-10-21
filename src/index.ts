/**
 * opencode-trajectory — append-only trajectory recorder for OpenCode sessions.
 *
 * Integration is deliberately boring:
 *   - one read-only `event` subscriber plus one `chat.message` observer
 *   - no hook ever mutates `output`, so agent behaviour is unchanged
 *   - every hook is wrapped so a recorder bug can never break a session
 *
 * What it records: session lineage, per-message tokens/cost/timing, streamed
 * text and reasoning, every tool call with input/output/exit timing, step
 * boundaries, retries, permission prompts, file edits and harness errors.
 *
 * What it does not do: it never draws UI. OpenCode's plugin contract has no TUI
 * injection point (`PluginModule.tui` is `never`), so the viewer is a separate
 * static HTML page reading the same journal. That separation is also what makes
 * the journal reusable by Langfuse / Phoenix / a custom web UI.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { resolveConfig, resolveDir } from "./config.ts"
import { Normalizer } from "./normalize.ts"
import { Store } from "./store.ts"

const TAG = "opencode-trajectory"

/**
 * A plugin can be loaded twice for the same directory — once from
 * `.opencode/plugins/` and once from the `plugin` array in config. Two
 * recorders means two writers racing on one journal and every record doubled.
 * One recorder per (process, directory) is the correct number.
 */
const SINGLETON = "__opencode_trajectory_active__"

export const TrajectoryPlugin: Plugin = async (input, options) => {
  let store: Store | undefined
  let norm: Normalizer | undefined
  const g = globalThis as Record<string, unknown>
  const slot = `${SINGLETON}:${input.directory}`

  try {
    if (g[slot]) return {}
    const cfg = resolveConfig(options as Record<string, unknown> | undefined, input.directory)
    if (!cfg.enabled) return {}
    g[slot] = true

    const dir = resolveDir(cfg, input.directory)
    norm = new Normalizer(cfg)
    store = new Store(dir, cfg)

    const n = norm
    const s = store
    if (cfg.debug) process.stderr.write(`${TAG}: recording to ${dir}\n`)

    /** Recorder failures are logged once, never propagated into the agent loop. */
    let reported = false
    const softFail = (where: string, e: unknown) => {
      if (reported) return
      reported = true
      void input.client.app
        .log({
          body: {
            service: TAG,
            level: "warn",
            message: `trajectory hook failed in ${where}`,
            extra: { error: e instanceof Error ? e.message : String(e) },
          },
        })
        .catch(() => {})
    }

    /**
     * Sessions created before this process started have no `session.created`
     * event, which would leave them parentless in the viewer's tree. Cache the
     * metadata once — it is written lazily, only if that session produces a
     * real event, so history never pollutes the journal with empty ghosts.
     */
    void (async () => {
      try {
        const res: any = await input.client.session.list({ query: { directory: input.directory } } as any)
        const list: any[] = res?.data ?? res
        if (Array.isArray(list)) n.primeSessions(list)
      } catch (e) {
        softFail("bootstrap", e)
      }
    })()

    return {
      event: async ({ event }) => {
        try {
          s.write(n.event(event))
          const t = (event as any)?.type ?? (event as any)?.payload?.type
          // Turn boundaries: drain sub-threshold text deltas so the journal is
          // never missing the tail of a message.
          if (t === "session.idle" || t === "session.compacted") s.write(n.flushPending())
        } catch (e) {
          softFail("event", e)
        }
      },

      "chat.message": async (i, o) => {
        try {
          s.write(n.userTurn(i as any, o as any))
        } catch (e) {
          softFail("chat.message", e)
        }
      },

      dispose: async () => {
        try {
          s.write(n.flushPending())
          s.close()
        } catch {
          /* process is going away anyway */
        }
        delete g[slot]
      },
    }
  } catch (e) {
    // Construction failed (read-only dir, bad config): behave as if not installed.
    if (process.env.OPENCODE_TRAJECTORY_DEBUG) {
      process.stderr.write(`${TAG}: disabled (${e instanceof Error ? e.message : String(e)})\n`)
    }
    try {
      store?.close()
    } catch {
      /* ignore */
    }
    delete g[slot]
    return {}
  }
}

export default TrajectoryPlugin
