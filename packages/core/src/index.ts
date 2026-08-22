export const name = "@conductor/core" as const

export { interpret, isTerminal } from "./interpret.ts"
export {
  buildEvalContext,
  extractExpressions,
  renderTemplate,
  resolveJobOutputs,
} from "./template.ts"
export {
  evaluate,
  parseExpression,
  collectCalls,
  collectPaths,
  formatPath,
  typecheckExpression,
  STATUS_FUNCTIONS,
  MissingValueError,
  ExpressionError,
} from "./expression.ts"
export type {
  BinaryOp,
  EvalContext,
  Expr,
  ExprType,
  FeatureContext,
  ParseResult,
  StepOutputsContext,
  TypeOfPath,
  Value,
} from "./expression.ts"
export { DEFAULT_OUTCOME } from "./types.ts"
export { parseWorkflow, parseYamlObject, stringifyYamlObject } from "./parse.ts"
export type { ParseError, ParseWorkflowResult, ParseYamlObjectResult, YamlObjectParseError } from "./parse.ts"
export { validateWorkflow } from "./validate.ts"
export { resolveWorkflowInputs } from "./workflow-input.ts"
export type { ResolveWorkflowInputsResult, WorkflowInputDiagnostic } from "./workflow-input.ts"
export {
  ACTION_CAPABILITIES,
  ACTION_INPUT_TYPES,
  buildActionRegistry,
  computeActionDigest,
  matchesInputType,
  parseActionRef,
  resolveAction,
  validateActionInputs,
  validateActionManifest,
} from "./action.ts"
export type {
  ActionCapability,
  ActionExecution,
  ActionInputDef,
  ActionInputType,
  ActionInputValue,
  ActionManifest,
  ActionOutputs,
  ActionRef,
  ActionRegistry,
  ActionRegistryEntry,
  ActionResult,
  ActionRunContext,
  ParseActionRefResult,
  ResolveActionResult,
} from "./action.ts"
export { parseActionManifest } from "./action-manifest.ts"
export type { ParseActionManifestError, ParseActionManifestResult } from "./action-manifest.ts"
export type * from "./types.ts"
export type { RenderResult } from "./template.ts"
export type { ValidationResult } from "./validate.ts"
export {
  FAILURE_CLASSES,
  RESOURCE_REASONS,
  boundDiagnostic,
  makeFailureEnvelope,
  normalizeFailureClass,
} from "./failure.ts"
export type { FailureClass, FailureEnvelope, MakeFailureEnvelopeInput, ResourceReason } from "./failure.ts"
export {
  DEFAULT_RESOURCE_WAIT_MAX_MS,
  DEFAULT_RESOURCE_WAIT_OBSERVATION,
  DEFAULT_RETRY_BACKOFF,
  DEFAULT_RETRY_BUDGET,
  behaviourForClass,
  normalizeResourceWaitPolicy,
  normalizeRetryPolicy,
  validateBackoffDef,
  validateResourceWaitPolicyConfig,
  validateRetryBudget,
  validateRetryPolicyConfig,
} from "./retry-policy.ts"
export type {
  NormalizedResourceWaitPolicy,
  NormalizedRetryPolicy,
  ResourceWaitPolicyConfig,
  RetryBudget,
  RetryClassBehaviour,
  RetryPolicyConfig,
  RetryPolicyOverride,
} from "./retry-policy.ts"
export {
  applyJitter,
  accumulatePausedMs,
  baseDelayMs,
  checkRetryBudget,
  clampRetryHintMs,
  computeDelayMs,
  computeScheduledDelayMs,
  elapsedBudgetMs,
  nextAttemptAt,
  systemRandom,
} from "./scheduling.ts"
export type { BudgetCheckInput, BudgetCheckResult, ElapsedBudgetState, Random } from "./scheduling.ts"
export { decideFailureRoute, decidePauseAwareResume, decideRecover, decideResourceWaitRoute } from "./lifecycle.ts"
export type {
  DueSchedule,
  DueScheduleKind,
  FailureRouteDecision,
  RecoverDecision,
  RecoverRequest,
  RecoverTarget,
  RecoverableStatus,
  ResourceWaitRouteDecision,
  ResourceWaitState,
  ResumeScheduleDecision,
  RetryEpisodeState,
} from "./lifecycle.ts"
export {
  NO_EXTERNAL_ANCHORS,
  allJobsTerminalStatus,
  anyJobFailed,
  checkActiveStateInvariant,
  isTerminalJobStatus,
  progressAnchors,
} from "./invariant.ts"
export type { AnchorState, InvariantCheckResult, ProgressAnchor } from "./invariant.ts"
