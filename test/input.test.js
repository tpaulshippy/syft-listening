import { describe, it, expect } from "vitest"
import {
  proposeGroup,
  promptFor,
  controlFromAnswers,
  valuesFromAnswers,
  offlineCheck,
  rowsToDataset,
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

describe("input control", () => {
  it("trusts confident Jev control, falls back by keyword", () => {
    expect(controlFromAnswers({ control: { choice: "skip", confidence: 0.9 } }, "whatever").control).toBe("skip")
    expect(controlFromAnswers({}, "skip").control).toBe("skip")
    expect(controlFromAnswers({}, "go back").control).toBe("edit_previous")
    expect(controlFromAnswers({}, "scifi").control).toBe("answer")
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

  it("keeps open-type values verbatim", () => {
    const { values } = valuesFromAnswers({ valid: { noul: 0.9 } }, [EMAIL], "a@b.co")
    expect(values).toEqual({ d: "a@b.co" })
  })
})

describe("input offline checks (block + retry)", () => {
  it("validates email / number / yes-no / choice", () => {
    expect(offlineCheck(EMAIL, "a@b.co").ok).toBe(true)
    expect(offlineCheck(EMAIL, "nope").ok).toBe(false)
    expect(offlineCheck({ ...EMAIL, type: "number" }, "12x").ok).toBe(false)
    expect(offlineCheck(YES_NO, "yeah").value).toBe("yes")
    expect(offlineCheck(GENRE, "SCIFI").value).toBe("scifi")
    expect(offlineCheck(GENRE, "purple").ok).toBe(false)
    expect(offlineCheck(NAME, "").ok).toBe(false) // required
  })
})

describe("input auto-share", () => {
  it("passes rows through keyed by field name", () => {
    expect(rowsToDataset([{ Genre: "scifi", Email: "a@b.co" }])).toEqual([{ Genre: "scifi", Email: "a@b.co" }])
    expect(rowsToDataset([])).toEqual([])
  })
})
