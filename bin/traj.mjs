#!/usr/bin/env node
/**
 * Friendly entry point: figure out which project you mean, then hand off to cli.mjs.
 *
 *   traj                      # 当前目录的轨迹，起本地查看器并打开浏览器
 *   traj stats                # 当前目录的终端摘要
 *   traj list                 # 当前目录的会话列表
 *   traj D:\work\myproj       # 指定项目
 *   traj D:\work\myproj stats # 指定项目 + 子命令
 *
 * The path argument is forgiving: a project root, a `.opencode` dir, a
 * `.opencode/trajectory` dir, or a sessions dir all resolve to the same place.
 */
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, "cli.mjs")
const SUBS = new Set(["serve", "export", "list", "stats", "path"])

/** Ask a session file for the project directory it was recorded in. */
function projectFromSessions(sessionsDir) {
  try {
    const f = fs.readdirSync(sessionsDir).find((n) => n.endsWith(".jsonl"))
    if (!f) return null
    const line = fs.readFileSync(path.join(sessionsDir, f), "utf8").split("\n")[0]
    const rec = JSON.parse(line)
    return rec.dir || null
  } catch {
    return null
  }
}

/** Normalise any of the plausible path shapes into `<project>/.opencode/trajectory`. */
function resolveTrajectoryDir(input) {
  let p = path.resolve(input)
  // already a trajectory dir
  if (fs.existsSync(path.join(p, "sessions"))) return p
  // .opencode dir
  if (path.basename(p) === ".opencode") {
    const t = path.join(p, "trajectory")
    if (fs.existsSync(t)) return t
  }
  // project root
  const t = path.join(p, ".opencode", "trajectory")
  if (fs.existsSync(t)) return t
  return null
}

/** Walk up from cwd looking for a recorded trajectory. */
function findUp() {
  let dir = process.cwd()
  for (let i = 0; i < 12; i++) {
    const t = path.join(dir, ".opencode", "trajectory")
    if (fs.existsSync(path.join(t, "sessions"))) return t
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const argv = process.argv.slice(2)
let sub = "serve"
let target = null
const passthrough = []

// Flags that swallow the next token — otherwise `--port 7791` would treat
// "7791" as a project path.
const VALUED = new Set(["--port", "--host", "--out", "--session"])

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (VALUED.has(a)) {
    passthrough.push(a)
    if (argv[i + 1] !== undefined) passthrough.push(argv[++i])
    continue
  }
  // `--dir` is ours to control, but honour an explicit one as the target
  if (a === "--dir") {
    if (argv[i + 1] !== undefined) target = argv[++i]
    continue
  }
  if (SUBS.has(a) && target === null) sub = a
  else if (a.startsWith("-")) passthrough.push(a)
  else if (target === null) target = a
  else passthrough.push(a)
}

let dir = target ? resolveTrajectoryDir(target) : findUp()

if (!dir) {
  if (target) {
    console.error(`没有找到轨迹目录：${path.resolve(target)}`)
    console.error("提示：该路径下应存在 .opencode/trajectory/sessions/")
  } else {
    console.error(`当前目录没有轨迹记录：${process.cwd()}`)
    console.error("")
    console.error("先在这个目录里用 opencode 跑一轮对话（插件已全局安装），然后再运行 traj。")
    const cwdTraj = path.join(process.cwd(), ".opencode", "trajectory")
    if (fs.existsSync(cwdTraj)) console.error(`目录已存在但没有会话文件：${cwdTraj}`)
  }
  process.exit(1)
}

// serve 默认要开浏览器，其他子命令不用
const args = [CLI, sub, "--dir", dir, ...passthrough]
if (sub === "serve" && !passthrough.includes("--open") && !passthrough.includes("--no-open")) {
  args.push("--open")
}

const child = spawn(process.execPath, args, { stdio: "inherit" })
child.on("exit", (code) => process.exit(code ?? 0))
