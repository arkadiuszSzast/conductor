/**
 * The conductor-questions convention: parsing is strict (anything off-shape
 * degrades to null → plain text), composition produces readable Q/A pairs.
 */
import { describe, expect, it } from "bun:test"
import {
  answersComplete,
  composeAnswerNotes,
  parseGateQuestions,
  type GateAnswer,
} from "../src/gate/gate-questions.ts"

const block = (body: string): string => "Intro text.\n\n```conductor-questions\n" + body + "\n```\n\nOutro."

describe("parseGateQuestions", () => {
  it("parses questions with options and strips the block from the text", () => {
    const prompt = block('[{"question": "Which storage?", "options": ["SQLite", "Postgres"]}]')
    const parsed = parseGateQuestions(prompt)!
    expect(parsed.questions).toEqual([{ question: "Which storage?", options: ["SQLite", "Postgres"] }])
    expect(parsed.text).toContain("Intro text.")
    expect(parsed.text).toContain("Outro.")
    expect(parsed.text).not.toContain("conductor-questions")
  })

  it("accepts a question without options", () => {
    const parsed = parseGateQuestions(block('[{"question": "Anything else?"}]'))!
    expect(parsed.questions).toEqual([{ question: "Anything else?", options: [] }])
  })

  it("returns null when there is no block", () => {
    expect(parseGateQuestions("Just a plain prompt.")).toBeNull()
  })

  it.each([
    ["invalid JSON", "not json"],
    ["not an array", '{"question": "q"}'],
    ["empty array", "[]"],
    ["missing question", '[{"options": ["a"]}]'],
    ["blank question", '[{"question": "  "}]'],
    ["non-string option", '[{"question": "q", "options": [1]}]'],
    ["options not an array", '[{"question": "q", "options": "a"}]'],
  ])("degrades to null for %s", (_name, body) => {
    expect(parseGateQuestions(block(body))).toBeNull()
  })
})

describe("composeAnswerNotes", () => {
  const questions = [
    { question: "Which storage?", options: ["SQLite", "Postgres"] },
    { question: "Archive or delete?", options: ["Archive", "Delete"] },
  ]

  it("serialises chosen options and custom answers as Q/A pairs", () => {
    const answers: GateAnswer[] = [
      { chosen: 0, custom: "" },
      { chosen: null, custom: "Soft-delete with a TTL" },
    ]
    expect(composeAnswerNotes(questions, answers)).toBe(
      "Q: Which storage?\nA: SQLite\n\nQ: Archive or delete?\nA: Soft-delete with a TTL",
    )
  })

  it("missing answers serialise as empty", () => {
    expect(composeAnswerNotes(questions, [{ chosen: 1, custom: "" }])).toBe(
      "Q: Which storage?\nA: Postgres\n\nQ: Archive or delete?\nA: ",
    )
  })
})

describe("answersComplete", () => {
  const questions = [{ question: "Q1", options: ["a"] }, { question: "Q2", options: [] }]

  it("requires every question answered", () => {
    expect(answersComplete(questions, [{ chosen: 0, custom: "" }])).toBe(false)
    expect(answersComplete(questions, [
      { chosen: 0, custom: "" },
      { chosen: null, custom: "my answer" },
    ])).toBe(true)
  })

  it("rejects blank custom answers and out-of-range choices", () => {
    expect(answersComplete(questions, [
      { chosen: 5, custom: "" },
      { chosen: null, custom: "x" },
    ])).toBe(false)
    expect(answersComplete(questions, [
      { chosen: 0, custom: "" },
      { chosen: null, custom: "   " },
    ])).toBe(false)
  })
})
