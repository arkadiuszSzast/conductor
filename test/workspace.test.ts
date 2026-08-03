import { expect, it } from "bun:test"
import { name as core } from "@conductor/core"
import { name as server } from "@conductor/server"
import { name as runner } from "@conductor/runner-opencode"
import { name as cli } from "@conductor/cli"

it("resolves every workspace package", () => {
  expect(core).toBe("@conductor/core")
  expect(server).toBe("@conductor/server")
  expect(runner).toBe("@conductor/runner-opencode")
  expect(cli).toBe("@conductor/cli")
})
