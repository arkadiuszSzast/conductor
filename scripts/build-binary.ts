/**
 * Build the single-file `dist/conductor` executable with the web UI
 * embedded. Steps: (1) build the SPA, (2) generate an embed manifest —
 * one `with {type:"file"}` import per dist asset, preserving relative
 * paths — plus a wrapper entrypoint that registers the embedded
 * index.html location before the CLI main runs, (3) compile with
 * `Bun.build`. The daemon resolves the UI from
 * `globalThis.CONDUCTOR_EMBEDDED_UI_INDEX` (see cli main.ts).
 */

import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const webDir = join(repoRoot, "apps/web")
const distDir = join(webDir, "dist")
const buildDir = join(repoRoot, ".build")

console.log("building web ui...")
const spa = Bun.spawnSync(["bun", "run", "--cwd", webDir, "build:vite"], { stdio: ["ignore", "inherit", "inherit"] })
if (spa.exitCode !== 0) {
  console.error("SPA build failed")
  process.exit(1)
}
if (!existsSync(join(distDir, "index.html"))) {
  console.error(`SPA build produced no ${distDir}/index.html`)
  process.exit(1)
}

rmSync(buildDir, { recursive: true, force: true })
mkdirSync(buildDir, { recursive: true })
// Copy the dist INSIDE the build dir: embedded asset names derive from
// the import path relative to the entrypoint, and paths that climb out
// of the build dir escape the binary's virtual filesystem root.
const embeddedDist = join(buildDir, "ui")
cpSync(distDir, embeddedDist, { recursive: true })

const assets: string[] = []
function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.isFile()) assets.push(path)
  }
}
walk(embeddedDist)
assets.sort()

const imports: string[] = []
let indexVar: string | null = null
assets.forEach((asset, i) => {
  const rel = relative(embeddedDist, asset)
  const name = `asset${i}`
  imports.push(`import ${name} from ${JSON.stringify(`./${relative(buildDir, asset)}`)} with { type: "file" }`)
  if (rel === "index.html") indexVar = name
})
if (indexVar === null) {
  console.error("index.html missing from asset scan")
  process.exit(1)
}

writeFileSync(
  join(buildDir, "ui-manifest.ts"),
  `${imports.join("\n")}\n\n;(globalThis as Record<string, unknown>)["CONDUCTOR_EMBEDDED_UI_INDEX"] = ${indexVar}\n;(globalThis as Record<string, unknown>)["CONDUCTOR_EMBEDDED_ASSETS"] = ${JSON.stringify(assets.map(a => `./${relative(embeddedDist, a)}`))}\n`,
)
writeFileSync(
  join(buildDir, "entry.ts"),
  `import "./ui-manifest.ts"\nawait import(${JSON.stringify(`./${relative(buildDir, join(repoRoot, "packages/cli/src/main.ts"))}`)})\n`,
)

console.log(`embedding ${assets.length} ui assets, compiling...`)
const result = await Bun.build({
  entrypoints: [join(buildDir, "entry.ts")],
  compile: { outfile: join(repoRoot, "dist/conductor") },
  naming: { asset: "[dir]/[name].[ext]" },
})
for (const log of result.logs) console.error(String(log))
if (!result.success) process.exit(1)

// Copy the SPA dist alongside the binary so the running daemon can
// serve static files from the real filesystem (Bun's /$bunfs/ virtual
// filesystem is not accessible via statSync or Bun.file().size).
const uiDir = join(repoRoot, "dist", "ui")
rmSync(uiDir, { recursive: true, force: true })
cpSync(embeddedDist, uiDir, { recursive: true })
console.log(`dist/conductor ready (+ dist/ui/ with ${assets.length} assets)`)
