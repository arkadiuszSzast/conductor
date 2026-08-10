#!/usr/bin/env bun
/**
 * Process entry point — the ONLY file that touches the real
 * environment. Everything else takes injected dependencies so the CLI
 * is testable without a process, a socket or a filesystem.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { runCli } from "./cli.ts"

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: line => console.log(line),
  stderr: line => console.error(line),
  readFile: path => readFileSync(path, "utf8"),
  writeFile: (path, content) => writeFileSync(path, content),
  exists: path => existsSync(path),
  mkdir: path => mkdirSync(path, { recursive: true }),
  cwd: () => process.cwd(),
})
process.exit(code)
