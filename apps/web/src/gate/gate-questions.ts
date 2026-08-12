/**
 * The `conductor-questions` convention — pure, unit-testable.
 *
 * A gate prompt may embed a fenced code block tagged `conductor-questions`
 * whose body is a JSON array of `{ question, options? }`. The UI renders
 * an answer form for it; anything malformed degrades to the plain-text
 * prompt (never an error, never a blocked gate). Answers serialise into
 * the decision notes as plain-text Q/A pairs — the API contract stays
 * "notes text out".
 */

export interface GateQuestion {
  readonly question: string
  readonly options: readonly string[]
}

export interface ParsedGatePrompt {
  /** The prompt with the questions block removed (surrounding text kept). */
  readonly text: string
  readonly questions: readonly GateQuestion[]
}

const BLOCK_PATTERN = /```conductor-questions[ \t]*\r?\n([\s\S]*?)```/

/** Extract the questions block from a rendered prompt. Returns null when
 *  there is no block or the block is malformed — callers fall back to
 *  plain-text rendering. */
export function parseGateQuestions(prompt: string): ParsedGatePrompt | null {
  const match = BLOCK_PATTERN.exec(prompt)
  if (match === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1]!)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const questions: GateQuestion[] = []
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return null
    const question = (entry as { question?: unknown }).question
    if (typeof question !== "string" || question.trim() === "") return null
    const rawOptions = (entry as { options?: unknown }).options
    if (rawOptions !== undefined && !Array.isArray(rawOptions)) return null
    const options: string[] = []
    for (const option of rawOptions ?? []) {
      if (typeof option !== "string") return null
      options.push(option)
    }
    questions.push({ question, options })
  }
  const text = prompt.replace(BLOCK_PATTERN, "").trim()
  return { text, questions }
}

export interface GateAnswer {
  /** Index into the question's options, or null when the custom text is used. */
  readonly chosen: number | null
  readonly custom: string
}

/** One answer per question: the chosen option, or the custom text verbatim. */
export function composeAnswerNotes(questions: readonly GateQuestion[], answers: readonly GateAnswer[]): string {
  const parts: string[] = []
  for (const [index, question] of questions.entries()) {
    const answer = answers[index]
    const text = answer === undefined
      ? ""
      : answer.chosen !== null
        ? question.options[answer.chosen] ?? ""
        : answer.custom.trim()
    parts.push(`Q: ${question.question}\nA: ${text}`)
  }
  return parts.join("\n\n")
}

/** An answer set is submittable when every question has either a chosen
 *  option or non-empty custom text. */
export function answersComplete(questions: readonly GateQuestion[], answers: readonly GateAnswer[]): boolean {
  return questions.every((question, index) => {
    const answer = answers[index]
    if (answer === undefined) return false
    if (answer.chosen !== null) return question.options[answer.chosen] !== undefined
    return answer.custom.trim() !== ""
  })
}
