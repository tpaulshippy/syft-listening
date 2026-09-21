import { describe, it, expect } from "vitest"
import {
  proposeGroup,
  promptFor,
  spokenPromptFor,
  controlFromAnswers,
  effectiveControl,
  valuesFromAnswers,
  validateGroup,
  rowsToDataset,
  rowTableHtml,
  editPromptFor,
  spokenEditPromptFor,
  rowIntentFromAnswers,
  editFieldFromAnswers,
  dateFromAnswers,
  numberFromTranscript,
  wordsToNumber,
  DATE_MIN_YEAR,
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

  it("speaks bare names, leaving option lists on screen", () => {
    expect(spokenPromptFor([GENRE])).toBe("Genre?")
    expect(spokenPromptFor([YES_NO, GENRE])).toBe("Subscribe … Genre?")
    expect(spokenPromptFor([])).toBe("")
    expect(spokenEditPromptFor(GENRE)).toBe("Genre?")
  })
})

describe("input control (Jev only)", () => {
  it("trusts confident Jev control, marks unsure for repeat", () => {
    expect(controlFromAnswers({ control: { choice: "skip", confidence: 0.9 } }).control).toBe("skip")
    expect(controlFromAnswers({}).control).toBeNull()
    expect(controlFromAnswers({}).usedFallback).toContain("control")
  })

  it("assumes answer when values are confident but control hedges (live replay)", () => {
    // Inspector showed: control=null values={"…":"2026-09-13"} · unsure(control)
    const DATE = { id: "f", name: "Date", type: "date", required: true, options: [] }
    const answers = {
      control: { choice: "answer", confidence: 0.3 },
      month: { choice: "september", confidence: 1.0 },
      day: { choice: "13", confidence: 1.0 },
      year: { choice: "2026", confidence: 1.0 },
    }
    const { control: raw, usedFallback: cfb } = controlFromAnswers(answers)
    const { values, usedFallback: vfb } = valuesFromAnswers(answers, [DATE], "September 13, 2026")
    expect(raw).toBeNull()
    expect(values).toEqual({ f: "2026-09-13" })
    const eff = effectiveControl(raw, cfb, vfb)
    expect(eff.control).toBe("answer")
    expect(eff.assumed).toBe(true)
    expect([...eff.usedFallback, ...vfb]).toEqual([])
  })

  it("never assumes: confident intents pass through, unsure values still repeat", () => {
    expect(effectiveControl("skip", [], []).control).toBe("skip")
    expect(effectiveControl("finish_row", [], []).control).toBe("finish_row")
    expect(effectiveControl(null, ["control"], ["month", "day", "year"]).control).toBeNull()
    expect(effectiveControl(null, ["control"], ["month", "day", "year"]).usedFallback).toContain("control")
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

  it("composes Jev's month/day/year choices into an ISO date", () => {
    const BIRTHDAY = { id: "f", name: "Birthday", type: "date", required: true, options: [] }
    const { values, usedFallback } = valuesFromAnswers({
      month: { choice: "september", confidence: 1.0 },
      day: { choice: "13", confidence: 1.0 },
      year: { choice: "2026", confidence: 1.0 },
      control: { choice: "answer", confidence: 0.7 },
    }, [BIRTHDAY], "September 13, 2026")
    expect(values).toEqual({ f: "2026-09-13" })
    expect(usedFallback).toEqual([])
  })

  it("repeats the date question when any part is unsure", () => {
    const BIRTHDAY = { id: "f", name: "Birthday", type: "date", required: true, options: [] }
    const { values, usedFallback } = valuesFromAnswers({
      month: { choice: "september", confidence: 1.0 },
      day: { choice: "13", confidence: 0.2 },
      year: { choice: "2026", confidence: 1.0 },
    }, [BIRTHDAY], "September 2026")
    expect(values.f).toBeNull()
    expect(usedFallback).toEqual(["month", "day", "year"])
  })

  it("stores verbatim text even when Jev hedges on validity", () => {
    const hedged = valuesFromAnswers({
      control: { choice: "answer", confidence: 0.9 },
      valid: { noul: 0.6 },
    }, [NAME], "Roman")
    expect(hedged.values).toEqual({ e: "Roman" })
    expect(hedged.usedFallback).toEqual([])
  })

  it("still repeats text when Jev never responded or nothing was heard", () => {
    const offline = valuesFromAnswers({}, [NAME], "Roman")
    expect(offline.values.e).toBeNull()
    expect(offline.usedFallback).toContain("valid")
    const empty = valuesFromAnswers({ control: { choice: "answer", confidence: 0.9 } }, [NAME], "   ")
    expect(empty.values.e).toBeNull()
    expect(empty.usedFallback).toContain("valid")
  })

  it("lets control route skip even when Jev vetoes text validity", () => {
    const skipped = valuesFromAnswers({
      control: { choice: "skip", confidence: 0.9 },
      valid: { noul: 0.05 },
    }, [NAME], "skip")
    expect(skipped.values.e).toBeNull()
    expect(skipped.usedFallback).toEqual([])
  })

  it("coerces Jev-validated numbers: digits via Number(), words via tables", () => {
    const AGE = { id: "g", name: "Age", type: "number", required: true, options: [] }
    const ok = valuesFromAnswers({ valid: { noul: 0.95 } }, [AGE], "42")
    expect(ok.values).toEqual({ g: 42 })
    expect(ok.usedFallback).toEqual([])
    const words = valuesFromAnswers({ valid: { noul: 0.95 } }, [AGE], "forty two")
    expect(words.values).toEqual({ g: 42 })
    expect(words.usedFallback).toEqual([])
    const garbage = valuesFromAnswers({ valid: { noul: 0.95 } }, [AGE], "forty-two-ish")
    expect(garbage.values.g).toBeNull()
    expect(garbage.usedFallback).toContain("valid")
  })
})

describe("date parse (Jev choices in, ISO out)", () => {
  const confident = {
    month: { choice: "september", confidence: 1.0 },
    day: { choice: "13", confidence: 1.0 },
    year: { choice: "2026", confidence: 1.0 },
  }

  it("parses September 13, 2026 to 2026-09-13 (live Jev replay)", () => {
    expect(dateFromAnswers(confident)).toBe("2026-09-13")
  })

  it("rejects non-real calendar dates like February 30", () => {
    expect(dateFromAnswers({
      month: { choice: "february", confidence: 1.0 },
      day: { choice: "30", confidence: 1.0 },
      year: { choice: "2026", confidence: 1.0 },
    })).toBeNull()
  })

  it("rejects unsure parts and out-of-range years", () => {
    expect(dateFromAnswers({ ...confident, day: { choice: "13", confidence: 0.2 } })).toBeNull()
    expect(dateFromAnswers({})).toBeNull()
    expect(dateFromAnswers({
      ...confident,
      year: { choice: String(DATE_MIN_YEAR - 1), confidence: 1.0 },
    })).toBeNull()
  })

  it("coerces digit strings, never words or empties", () => {
    expect(numberFromTranscript("42")).toBe(42)
    expect(numberFromTranscript(" -3.5 ")).toBe(-3.5)
    expect(numberFromTranscript("forty-two")).toBe(42)
    expect(numberFromTranscript("")).toBeNull()
    expect(numberFromTranscript("   ")).toBeNull()
  })

  it("parses spoken cardinals behind Jev's validity gate", () => {
    expect(wordsToNumber("five")).toBe(5)
    expect(wordsToNumber("forty two")).toBe(42)
    expect(wordsToNumber("forty-two")).toBe(42)
    expect(wordsToNumber("twenty five")).toBe(25)
    expect(wordsToNumber("one hundred and five")).toBe(105)
    expect(wordsToNumber("one hundred twenty five")).toBe(125)
    expect(wordsToNumber("four thousand and thirty")).toBe(4030)
    expect(wordsToNumber("six million five thousand and two")).toBe(6005002)
    expect(wordsToNumber("negative three point five")).toBe(-3.5)
    expect(wordsToNumber("minus oh point five")).toBe(-0.5)
    expect(wordsToNumber("three point one four")).toBeCloseTo(3.14, 10)
    expect(wordsToNumber("zero")).toBe(0)
  })

  it("repeats instead of guessing on non-cardinals", () => {
    expect(wordsToNumber("")).toBeNull()
    expect(wordsToNumber("banana")).toBeNull()
    expect(wordsToNumber("point")).toBeNull()
    expect(wordsToNumber("hundred")).toBeNull()
    expect(wordsToNumber("negative")).toBeNull()
    expect(wordsToNumber("five six")).toBeNull()
    expect(wordsToNumber("five twenty")).toBeNull()
    expect(wordsToNumber("twenty thirty")).toBeNull()
    expect(wordsToNumber("forty-two-ish")).toBeNull()
    expect(numberFromTranscript("forty-two-ish")).toBeNull()
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

  it("prompts with the bare name only", () => {
    expect(editPromptFor(genre, "scifi")).toBe("Genre (fiction, scifi)?")
    expect(editPromptFor(genre, "")).toBe("Genre (fiction, scifi)?")
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
