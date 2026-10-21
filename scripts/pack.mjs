#!/usr/bin/env node
/**
 * Build the distributable zip package.
 *
 *   node scripts/pack.mjs
 *
 * Output: out/opencode-trajectory-<version>.zip
 * The zip keeps the repo layout so install.mjs / cli.mjs work in place:
 *   opencode-trajectory/
 *     dist/opencode-trajectory.js   <- the plugin bundle
 *     bin/cli.mjs                   <- viewer CLI (serve/export/list/stats)
 *     src/fold.js                   <- shared projection (used by cli)
 *     viewer/index.html             <- viewer shell
 *     scripts/install.mjs           <- one-command install
 *     README.md  package.json
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const version = pkg.version

// build first so the bundle is fresh
execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { stdio: "inherit" })

const outDir = path.join(root, "out")
fs.mkdirSync(outDir, { recursive: true })
const zipPath = path.join(outDir, `opencode-trajectory-${version}.zip`)

const stage = path.join(root, ".pack-staging")
const pkgDir = path.join(stage, "opencode-trajectory")

// clean staging
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(pkgDir, { recursive: true })

const files = [
  // runtime artifacts
  "dist/opencode-trajectory.js",
  "bin/cli.mjs",
  "bin/traj.mjs",
  "viewer/index.html",
  // full source (for review / secondary development)
  "src/types.ts",
  "src/config.ts",
  "src/normalize.ts",
  "src/store.ts",
  "src/redact.ts",
  "src/fold.js",
  "src/index.ts",
  // tooling
  "scripts/install.mjs",
  "scripts/install-cli.mjs",
  "scripts/build.mjs",
  "scripts/demo.mjs",
  // tests
  "test/normalize.test.mjs",
  "test/store.test.mjs",
  "test/viewer.test.mjs",
  // docs
  "README.md",
  "README.zh-CN.md",
  "INTEGRATION.md",
  "LICENSE",
  "docs/screenshot.png",
  "docs/embed.png",
  // project meta
  "install.cmd",
  "traj.cmd",
  "package.json",
  "tsconfig.json",
]
for (const f of files) {
  const src = path.join(root, f)
  const dst = path.join(pkgDir, f)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
}

// zip via Windows built-in bsdtar (C:\Windows\System32\tar.exe, available on Win10+).
// Use the absolute path: Git Bash's GNU tar shadows it and cannot write zip.
try {
  execFileSync("C:\\Windows\\System32\\tar.exe", ["-a", "-c", "-f", zipPath, "-C", stage, "opencode-trajectory"], { stdio: "inherit" })
} catch {
  execFileSync("powershell", [
    "-NoProfile", "-Command",
    `Compress-Archive -Path '${pkgDir}' -DestinationPath '${zipPath}' -Force`,
  ], { stdio: "inherit" })
}

fs.rmSync(stage, { recursive: true, force: true })

const kb = (fs.statSync(zipPath).size / 1024).toFixed(1)
console.log(`\n打包完成 → ${zipPath} (${kb} KB)`)
console.log("对方电脑解压后：")
console.log("  install.cmd                                    # 双击安装（或用下面两条命令）")
console.log("  node opencode-trajectory/scripts/install.mjs   # 装到全局插件目录")
console.log("  node opencode-trajectory/bin/cli.mjs serve     # 看轨迹")
console.log("集成到自有系统 → 见 opencode-trajectory/INTEGRATION.md")
