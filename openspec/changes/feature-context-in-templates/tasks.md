# Tasks — feature context in templates

## 1. Core: expression + render

- [ ] 1.1 [core] `EvalContext.feature?: {title, slug, description, pr}`;
      `evaluatePath`: `feature.title|slug` hard, `feature.description`
      always a string, `feature.pr` soft-null; unknown field → error
- [ ] 1.2 [core] `buildEvalContext` populates `feature` from
      `FeatureState` (`description ?? ""`)
- [ ] 1.3 [test] Expression/template tests: each field renders, `pr ??`
      fallback, unknown field errors at evaluation

## 2. Core: validation

- [ ] 2.1 [core] `"feature"` in every `allowedRoots`; static field-type
      map consulted from each `typeOf*`; unknown field → load error
      naming available fields
- [ ] 2.2 [test] Validate tests: `feature.slug` accepted in agent
      prompt / human prompt / command run / action with / job if / job
      outputs; `feature.nope` rejected with the field list; typecheck
      (`feature.pr` is a number)

## 3. Docs

- [ ] 3.1 [docs] expressions.md: `feature` context table + hard/soft
      semantics; workflow-reference note that `feature.description`
      carries the operator's task text
