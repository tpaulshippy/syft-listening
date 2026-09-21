import { describe, it, expect } from "vitest"
import {
  proposeGroup,
  promptFor,
  controlFromAnswers,
  valuesFromAnswers,
  validateGroup,
  rowsToDataset,
  rowTableHtml,
  editPromptFor,
  rowIntentFromAnswers,
  editFieldFromAnswers,
} from "../app/javascript/controllers/input_controller.js"

const YES_NO = { id: "a", name: "Subscribe", type: "yes_no", required: false, options: [] }
const GENRE = { id: "b", name: "Genre", type: "choice_single", required: true, options: ["fiction", "scifi"] }
const TAGS = { id: "c", name: "Tags", type: "choice_multiple", required: false, options: ["fiction", "scifi"] }
const EMAIL = { id: "d", name: "Email", type: "email", required: true, options: [] }
const NAME = { id: "e", name: "Name", type: "text", required: true, options: [] }

describe("input grouping", () => {
  it("proposes closed-type pairs, solo otherwise", () => {
    expect(proposeGroup([YES_NO, GENRE])).toEqual([YES_NO, GENRE])
    expect(proposeGroup([EMAIL, NAME])).toEqual([EMAIL])
    expect(proposeGroup([GENRE, EMAIL])).toEqual([GENRE])
    expect(proposeGroup([])).toEqual([])
  })

  it("prompts with the bare field name", () => {
    expect(promptFor([GENRE])).toBe("Genre (fiction, scifi)?")
    expect(promptFor([YES_NO, GENRE])).toBe("Subscribe … Genre (fiction, scifi)?")
  })
})

describe("input control (Jev only)", () => {
  it("trusts confident Jev control, marks unsure for repeat", () => {
    expect(controlFromAnswers({ control: { choice: "skip", confidence: 0.9 } }).control).toBe("skip")
    expect(controlFromAnswers({}).control).toBeNull()
    expect(controlFromAnswers({}).usedFallback).toContain("control")
  })
})

describe("input values", () => {
  it("maps a grouped closed prompt in parallel", () => {
    const { values, usedFallback } = valuesFromAnswers({
      value: { noul: 0.95 },
      value_2: { choice: "scifi", confidence: 0.9 },
      control: { choice: "answer", confidence: 0.9 },
    }, [YES_NO, GENRE], "yes, scifi")
    expect(values).toEqual({ a: "yes", b: "scifi" })
    expect(usedFallback).toEqual([])
  })

  it("rejects hallucinated options and records fallback", () => {
    const { values, usedFallback } = valuesFromAnswers({
      value: { choice: "purple", confidence: 0.9 },
    }, [GENRE], "purple")
    expect(values.b).toBeNull()
    expect(usedFallback).toContain("value")
  })

  it("fans out one noul per option for choice_multiple", () => {
    const { values } = valuesFromAnswers({
      pick_fiction: { noul: 0.95 },
      pick_scifi: { noul: 0.05 },
    }, [TAGS], "fiction")
    expect(values).toEqual({ c: ["fiction"] })
  })

  it("marks unsure values for repeat, keeping the transcript only as carrier", () => {
    const { values, usedFallback } = valuesFromAnswers({}, [EMAIL], "a@b.co")
    expect(values.d).toBeNull()
    expect(usedFallback).toContain("valid")
  })
})

describe("input guards (no word matching)", () => {
  it("blocks empty required fields and non-member options", () => {
    expect(validateGroup([EMAIL], { d: "" }).ok).toBe(false)
    expect(validateGroup([EMAIL], { d: "a@b.co" }).ok).toBe(true)
    expect(validateGroup([GENRE], { b: "purple" }).ok).toBe(false)
    expect(validateGroup([GENRE], { b: "scifi" }).ok).toBe(true)
    expect(validateGroup([YES_NO], { a: "maybe" }).ok).toBe(false)
  })
})

describe("input auto-share", () => {
  it("passes rows through keyed by field name", () => {
    expect(rowsToDataset([{ Genre: "scifi", Email: "a@b.co" }])).toEqual([{ Genre: "scifi", Email: "a@b.co" }])
    expect(rowsToDataset([])).toEqual([])
  })
})

describe("voice row edit", () => {
  const genre = { id: "b", name: "Genre", type: "choice_single", required: true, options: ["fiction", "scifi"] }

  it("highlights selection without touching text colors", () => {
    const html = rowTableHtml([genre], [{ Genre: "scifi" }], 0)
    expect(html).toContain("outline:2px solid #2563eb")
    expect(html).not.toContain("#eff6ff")
    expect(rowTableHtml([genre], [{ Genre: "scifi" }], null)).not.toContain("outline")
  })

  it("prompts with the bare name plus current value", () => {
    expect(editPromptFor(genre, "scifi")).toBe("Genre (fiction, scifi)? Currently scifi. Say a new value, or skip.")
    expect(editPromptFor(genre, "")).toContain("Currently empty.")
  })

  it("routes edit versus delete through Jev first", () => {
    expect(rowIntentFromAnswers({ intent: { choice: "delete", confidence: 0.9 } }).intent).toBe("delete")
    expect(rowIntentFromAnswers({}).intent).toBeNull()
    expect(rowIntentFromAnswers({}).usedFallback).toContain("intent")
  })

  it("maps which-question onto one field id, unsure repeats the picker", () => {
    const fields = [
      { id: "f1", name: "Did you brush your teeth" },
      { id: "f2", name: "What's your name" },
    ]
    expect(editFieldFromAnswers({ field: { choice: "f2", confidence: 0.9 } }, fields).fieldId).toBe("f2")
    expect(editFieldFromAnswers({}, fields).fieldId).toBeNull()
    expect(editFieldFromAnswers({}, fields).usedFallback).toContain("field")
    expect(editFieldFromAnswers({ field: { choice: "nope", confidence: 0.9 } }, fields).fieldId).toBeNull()
    expect(editFieldFromAnswers({ field: { choice: "f1", confidence: 0.2 } }, fields).fieldId).toBeNull()
  })
})
