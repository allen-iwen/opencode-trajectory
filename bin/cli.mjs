#!/usr/bin/env node
/**
 * opencode-trajectory CLI
 *
 *   opencode-trajectory                # serve the viewer for this project
 *   opencode-trajectory serve --port 7777 --open
 *   opencode-trajectory export --session <sid> --out trajectory.html
 *   opencode-trajectory list           # terminal listing
 *   opencode-trajectory stats          # terminal summary of the latest session
 *   opencode-trajectory path           # print the resolved journal directory
 *
 * Reads only. Never talks to the OpenCode server, never mutates a journal.
 */
import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import { exec } from "node:child_process"
import { fileURLToPath } from "node:url"
import { fold, parseJournal } from "../src/fold.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HTML = path.join(HERE, "..", "viewer", "index.html")
const FOLDJS = path.join(HERE, "..", "src", "fold.js")
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version

const TTY = process.stdout.isTTY
const C = {
  dim: (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s),
  b: (s) => (TTY ? `\x1b[1m${s}\x1b[0m` : s),
  blue: (s) => (TTY ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s) => (TTY ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s) => (TTY ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (TTY ? `\x1b[33m${s}\x1b[0m` : s),
}

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=")
      if (inline !== undefined) out.flags[k] = inline
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out.flags[k] = argv[++i]
      else out.flags[k] = true
    } else out._.push(a)
  }
  return out
}

/** Walk up from cwd looking for `.opencode/trajectory`. */
function findDir(explicit) {
  if (explicit) return path.resolve(String(explicit))
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, ".opencode", "trajectory")
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(process.cwd(), ".opencode", "trajectory")
}

function sessionsDir(root) {
  return path.join(root, "sessions")
}

/** Session file stems present on disk (sanitized ids), newest first. */
function listStems(root) {
  const dir = sessionsDir(root)
  if (!fs.existsSync(dir)) return []
  const stems = new Set()
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue
    stems.add(f.replace(/\.1\.jsonl$/, ".jsonl").replace(/\.jsonl$/, ""))
  }
  const out = [...stems].map((stem) => {
    const files = [`${stem}.jsonl`, `${stem}.1.jsonl`].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f))
    const mtime = files.reduce((a, f) => Math.max(a, fs.statSync(f).mtimeMs), 0)
    const size = files.reduce((a, f) => a + fs.statSync(f).size, 0)
    return { stem, files, mtime, size }
  })
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** Rotated journals come first so the fold sees them in write order. */
function readStem(root, stem) {
  const dir = sessionsDir(root)
  const order = [`${stem}.1.jsonl`, `${stem}.jsonl`]
  let text = ""
  for (const f of order) {
    const p = path.join(dir, f)
    if (fs.existsSync(p)) text += fs.readFileSync(p, "utf8")
  }
  return text
}

function loadAll(root, onlyStem) {
  const stems = listStems(root).filter((s) => !onlyStem || s.stem === onlyStem)
  let records = []
  let bad = 0
  for (const s of stems) {
    const parsed = parseJournal(readStem(root, s.stem))
    records = records.concat(parsed.records)
    bad += parsed.bad
  }
  return { records, bad, stems }
}

// ------------------------------------------------------------- formatting
const fmtTok = (n) => (n == null ? "0" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n))
const fmtMs = (ms) => (ms == null || ms < 0 ? "—" : ms < 1000 ? Math.round(ms) + "ms" : ms < 60000 ? (ms / 1000).toFixed(1) + "s" : Math.floor(ms / 60000) + "m" + Math.round((ms % 60000) / 1000) + "s")
const fmtCost = (c) => (!c ? "$0" : c < 0.01 ? "$" + c.toFixed(4) : "$" + c.toFixed(2))
const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)
  return String(s) + " ".repeat(Math.max(0, n - w))
}

// ---------------------------------------------------------------- commands
function cmdList(root) {
  const { records, stems } = loadAll(root)
  if (!stems.length) {
    console.log(C.dim(`没有轨迹记录：${sessionsDir(root)}`))
    console.log(C.dim("先在项目里用 opencode 跑一轮对话。"))
    return
  }
  const model = fold(records)
  const byId = new Map(model.sessions.map((s) => [s.id, s]))
  console.log(C.b("会话") + C.dim(`  ${root}`))
  console.log("")
  console.log(C.dim(pad("开始时间", 18) + pad("轮次", 6) + pad("工具", 6) + pad("输入", 9) + pad("输出", 9) + pad("耗时", 9) + pad("错误", 6) + "标题"))
  for (const s of model.sessions) {
    const d = new Date(s.startedAt || Date.now())
    const ts = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    const errs = s.stats.errors + s.stats.toolErrors
    const line =
      pad(ts, 18) +
      pad(s.stats.turns, 6) +
      pad(s.stats.tools, 6) +
      pad(fmtTok(s.stats.tokens.input), 9) +
      pad(fmtTok(s.stats.tokens.output), 9) +
      pad(fmtMs(s.stats.durationMs), 9) +
      pad(errs ? C.red(errs) : C.dim("0"), 6) +
      (s.title || s.id).slice(0, 60)
    console.log(line)
  }
  const t = model.total
  console.log("")
  console.log(C.dim(`共 ${model.sessions.length} 个会话 · in ${fmtTok(t.tokens.input)} / out ${fmtTok(t.tokens.output)} / cache ${fmtTok(t.tokens.cacheRead)} · ${t.tools} 次工具调用 · ${fmtCost(t.cost)} · ${t.errors} 个错误`))
}

function cmdStats(root, flags) {
  const { records } = loadAll(root, flags.session ? String(flags.session).replace(/\.jsonl$/, "") : null)
  const model = fold(records)
  // Default to the newest root session — a sub-agent session has no user turn
  // of its own and makes for a confusing summary.
  const s = flags.session ? model.sessions[0] : model.roots.find((x) => x.stats.messages > 0) || model.roots[0] || model.sessions[0]
  if (!s) return console.log(C.dim("没有会话"))
  console.log(C.b(s.title || s.id))
  console.log(C.dim(`session  ${s.id}`))
  console.log(C.dim(`agent    ${s.stats.agents.join(", ") || "—"}    model ${s.stats.models.join(", ") || "—"}`))
  console.log("")
  const rows = [
    ["轮次 / 消息", `${s.stats.turns} / ${s.stats.messages}`],
    ["模型调用步数", s.stats.steps],
    ["墙钟耗时", fmtMs(s.stats.durationMs)],
    ["工具耗时合计", fmtMs(s.stats.toolMs)],
    ["工具调用", s.stats.tools + (s.stats.toolErrors ? C.red(` (${s.stats.toolErrors} 失败)`) : "")],
    ["token 输入", fmtTok(s.stats.tokens.input)],
    ["token 输出", fmtTok(s.stats.tokens.output)],
    ["reasoning", fmtTok(s.stats.tokens.reasoning)],
    ["cache 读/写", `${fmtTok(s.stats.tokens.cacheRead)} / ${fmtTok(s.stats.tokens.cacheWrite)}`],
    ["缓存命中率", (s.stats.cacheHit * 100).toFixed(1) + "%"],
    ["成本", fmtCost(s.stats.cost)],
    ["错误 / 重试", `${s.stats.errors} / ${s.stats.retries}`],
    ["权限询问", s.stats.permissions],
    ["压缩次数", s.compacted],
  ]
  for (const [k, v] of rows) console.log(`${pad(C.dim(k), 22)} ${v}`)

  if (s.tools.length) {
    const agg = new Map()
    for (const t of s.tools) {
      const a = agg.get(t.tool) || { n: 0, ms: 0, err: 0 }
      a.n++
      a.ms += t.durMs || 0
      if (t.st === "error") a.err++
      agg.set(t.tool, a)
    }
    console.log("")
    console.log(C.dim(pad("工具", 16) + pad("次数", 6) + pad("总耗时", 10) + pad("均耗时", 10) + "失败"))
    for (const [name, a] of [...agg.entries()].sort((x, y) => y.ms - x.ms)) {
      console.log(pad(name, 16) + pad(a.n, 6) + pad(fmtMs(a.ms), 10) + pad(fmtMs(a.ms / a.n), 10) + (a.err ? C.red(a.err) : "0"))
    }
  }
  if (s.errors.length) {
    console.log("")
    console.log(C.red("错误"))
    for (const e of s.errors.slice(0, 10)) console.log(C.dim("  " + new Date(e.at).toLocaleTimeString()) + `  ${e.name}: ${String(e.message).slice(0, 140)}`)
  }
}

function buildHtml(data) {
  let html = fs.readFileSync(HTML, "utf8")
  const foldSrc = fs.readFileSync(FOLDJS, "utf8").replace(/^export\s+/gm, "")
  html = html.replace("/*__FOLD__*/", () => foldSrc.replace(/<\/script/gi, "<\\/script"))
  const payload = data ? JSON.stringify(data).replace(/</g, "\\u003c") : "/*__DATA__*/"
  html = html.replace("/*__DATA__*/", () => payload)
  return html
}

function cmdExport(root, flags) {
  const only = flags.session ? String(flags.session).replace(/\.jsonl$/, "") : null
  const { records, stems } = loadAll(root, only)
  if (!records.length) return console.error(C.red("没有可导出的记录"))
  const model = fold(records)
  const target = flags.session ? model.sessions[0] : null
  const keep = target ? records.filter((r) => r.sid === target.id) : records
  const out = path.resolve(String(flags.out || `trajectory-${target ? target.id.slice(-8) : "all"}.html`))
  const html = buildHtml({ records: keep, project: root, version: VERSION, generatedAt: Date.now() })
  fs.writeFileSync(out, html, "utf8")
  console.log(C.green("已导出 ") + out)
  console.log(C.dim(`  ${keep.length} 条记录 · ${(fs.statSync(out).size / 1024).toFixed(0)} KB · 单文件，可直接分享或离线打开`))
  if (flags.open) open(out)
}

function open(target) {
  const url = target.startsWith("http") ? target : "file://" + target.replace(/\\/g, "/")
  const cmd =
    process.platform === "win32" ? `cmd /c start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`
  exec(cmd, () => {})
}

function cmdServe(root, flags) {
  const port = Number(flags.port || 7777)
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost")
    try {
      if (u.pathname === "/" || u.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return res.end(buildHtml(null))
      }
      if (u.pathname === "/api/index") {
        const { records, stems } = loadAll(root)
        const model = fold(records)
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
        return res.end(
          JSON.stringify({
            version: VERSION,
            paths: [root],
            sessions: stems.map((s) => s.stem),
            count: model.sessions.length,
          }),
        )
      }
      if (u.pathname === "/api/journal") {
        const stem = u.searchParams.get("sid") || ""
        if (!/^[A-Za-z0-9._-]+$/.test(stem)) {
          res.writeHead(400)
          return res.end("bad sid")
        }
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" })
        return res.end(readStem(root, stem))
      }
      res.writeHead(404)
      res.end("not found")
    } catch (e) {
      res.writeHead(500)
      res.end(String(e && e.message))
    }
  })

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(C.red(`端口 ${port} 被占用，换一个：--port ${port + 1}`))
      process.exit(1)
    }
    throw e
  })

  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`
    console.log(C.green("Trajectory viewer ") + url)
    console.log(C.dim(`  数据目录 ${root}`))
    console.log(C.dim("  Ctrl+C 退出"))
    if (flags.open) open(url)
  })
}

function cmdPath(root) {
  console.log(root)
  console.log(C.dim(`exists: ${fs.existsSync(sessionsDir(root))}`))
}

// ------------------------------------------------------------------- main
const argv = parseArgs(process.argv.slice(2))
const cmd = argv._[0] || "serve"
const root = findDir(argv.flags.dir)

if (!fs.existsSync(sessionsDir(root)) && cmd !== "serve") {
  console.error(C.yellow(`提示：轨迹目录还不存在 → ${sessionsDir(root)}`))
  console.error(C.dim("先在项目里用 opencode 跑一轮对话，或检查 --dir 是否指对了项目根。"))
}

switch (cmd) {
  case "serve":
    cmdServe(root, argv.flags)
    break
  case "export":
    cmdExport(root, argv.flags)
    break
  case "list":
    cmdList(root)
    break
  case "stats":
    cmdStats(root, argv.flags)
    break
  case "path":
    cmdPath(root)
    break
  case "help":
  case "--help":
  case "-h":
    console.log(`opencode-trajectory v${VERSION}

  serve   [--dir <project>] [--port 7777] [--open]   启动轨迹查看器
  export  [--session <sid>] [--out <file.html>]       导出单文件 HTML（可分享）
  list                                                终端列出会话
  stats   [--session <sid>]                           终端摘要（token/耗时/工具）
  path                                                打印轨迹目录）
`)
    break
  default:
    console.error(C.red(`未知命令: ${cmd}`))
    console.error(C.dim("试试 opencode-trajectory help"))
    process.exit(1)
}
