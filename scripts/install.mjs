#!/usr/bin/env node
/**
 * Install the built plugin into an OpenCode plugin directory.
 *
 *   node scripts/install.mjs            # global: ~/.config/opencode/plugins/
 *   node scripts/install.mjs --project  # project: ./.opencode/plugins/
 *   node scripts/install.mjs --dir <path>  # explicit plugin directory
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1] || true
}

let target
if (flag("--dir")) target = path.resolve(String(flag("--dir")))
else if (flag("--project")) target = path.resolve(process.cwd(), ".opencode", "plugins")
else target = path.join(os.homedir(), ".config", "opencode", "plugins")

const bundle = path.join(root, "dist", "opencode-trajectory.js")
if (!fs.existsSync(bundle)) {
  console.log("dist 不存在，先构建…")
  execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { stdio: "inherit" })
}

fs.mkdirSync(target, { recursive: true })
const dest = path.join(target, "opencode-trajectory.js")
fs.copyFileSync(bundle, dest)

console.log(`已安装 → ${dest}`)
console.log("")
console.log("重启 opencode 生效。触发一轮对话后，轨迹会写到：")
console.log(`  <项目根>/.opencode/trajectory/sessions/<session>.jsonl`)
console.log("")
console.log("查看：")
console.log(`  node ${path.relative(process.cwd(), path.join(root, "bin", "cli.mjs"))} serve --open`)
