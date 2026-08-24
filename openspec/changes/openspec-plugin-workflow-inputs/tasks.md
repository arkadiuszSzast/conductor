## 1. Implementation

- [x] 1.1 [server] `plugins/openspec/serve.ts`: in handleStartWork,
  fetch `GET /v1/projects/workflow?dir=<projectDir>` (authed); when the
  projection declares a string input named `change_slug` or `change`,
  add `inputs: { <name>: change }` to the feature-creation body; omit
  otherwise; projection fetch failure → proceed without inputs
- [x] 1.2 [test] serve.test.ts: workflow with change_slug → inputs
  carried; with `change` → that name used; without either → no inputs
  key; projection fetch failure → create still attempted without
  inputs; daemon rejection still relayed

## 2. Verification

- [ ] 2.1 [test] Full suite green; redeploy dogfood plugin and start
  todo-filtering from the panel successfully
