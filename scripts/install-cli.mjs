#!/usr/bin/env node
/**
 * Install the tool to a stable location and expose a `traj` command on PATH.
 *
 *   node scripts/install-cli.mjs
 *
 * Why a stable location: the plugin bundle goes into the OpenCode plugin dir,
 * but the viewer CLI must live somewhere that does not move when you switch
 * projects. Keeping it under %LOCALAPPDATA%\opencode-trajectory lets a single
 * `traj` shim in the npm global bin always find it.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const HOME = os.homedir()
const APP_DIR = path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "opencode-trajectory")
const NPM_BIN = path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "npm")

const FILES = [
  "bin/cli.mjs",
  "bin/traj.mjs",
  "src/fold.js",
  "viewer/index.html",
  "package.json",
]

// make sure the bundle exists before we copy anything
execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { stdio: "inherit" })
FILES.push("dist/opencode-trajectory.js")

fs.mkdirSync(APP_DIR, { recursive: true })
for (const f of FILES) {
  const src = path.join(root, f)
  const dst = path.join(APP_DIR, f)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

// ---- the `traj` shim -------------------------------------------------------
// Pure ASCII + CRLF: a .cmd with non-ASCII bytes breaks on some consoles.
const shimLines = [
  "@echo off",
  "setlocal",
  'set "APP=' + APP_DIR + '"',
  'if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE=%ProgramFiles%\\nodejs\\node.exe"',
  'if not defined NODE if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"',
  'if not defined NODE set "NODE=node"',
  'if not exist "%APP%\\bin\\traj.mjs" (',
  "  echo opencode-trajectory is not installed at %APP%",
  "  echo Re-run: node scripts\\install-cli.mjs from the source folder",
  "  exit /b 1",
  ")",
  '"%NODE%" "%APP%\\bin\\traj.mjs" %*',
  "exit /b %errorlevel%",
]
fs.mkdirSync(NPM_BIN, { recursive: true })
fs.writeFileSync(path.join(NPM_BIN, "traj.cmd"), shimLines.join("\r\n") + "\r\n", "ascii")

// bash shim too, for people living in Git Bash
fs.writeFileSync(
  path.join(NPM_BIN, "traj"),
  `#!/usr/bin/env bash\nexec node "${APP_DIR.replace(/\\/g, "/")}/bin/traj.mjs" "$@"\n`,
  "utf8",
)

console.log(`工具安装位置 → ${APP_DIR}`)
console.log(`命令已写入   → ${path.join(NPM_BIN, "traj.cmd")}`)
console.log("")
console.log("新开一个终端，然后：")
console.log("  cd 你的项目")
console.log("  traj            # 看轨迹（自动开浏览器）")
console.log("  traj stats      # 终端摘要")
