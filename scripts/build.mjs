#!/usr/bin/env node
/**
 * Bundle the plugin into a single JS file.
 *
 * Why bundle: OpenCode loads every `.ts` / `.js` file sitting directly in
 * `.opencode/plugins/`. If the plugin were installed as a folder of modules,
 * `store.ts` and `normalize.ts` would be picked up as plugins themselves and
 * fail (they export no plugin function). One file, one plugin, zero ambiguity.
 */
import * as esbuild from "esbuild"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, "dist", "opencode-trajectory.js")

fs.mkdirSync(path.join(root, "dist"), { recursive: true })

// `@opencode-ai/plugin` supplies types only; keep it external so the bundle has
// no runtime dependency the host must resolve.
const result = await esbuild.build({
  entryPoints: [path.join(root, "src", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["@opencode-ai/plugin", "node:*"],
  outfile: out,
  banner: {
    js: "/* opencode-trajectory — generated bundle. Source: src/  Build: npm run build */",
  },
  logLevel: "warning",
  metafile: true,
})

const size = fs.statSync(out).size
const inputs = Object.keys(result.metafile.inputs).length
console.log(`built ${path.relative(root, out)}  ${(size / 1024).toFixed(1)} KB  (${inputs} modules)`)
