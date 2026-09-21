import { describe, it, expect } from "vitest"
import {
  FIELD_TYPES,
  fallbackType,
  typeFromAnswers,
  optionIntentFromAnswers,
  requiredFromAnswers,
  requiredFieldsFromAnswers,
  sessionIntentFromAnswers,
  fieldsNeedingRequired,
  fieldCardHtml,
  parseEditMenu,
  parseFieldType,
  editMenuPrompt,
  addOption,
  validateFieldName,
  loadSchema,
  saveSchema,
  SCHEMA_KEY,
} from "../app/javascript/controllers/design_controller.js"

describe("design field types", () => {
  it("covers the 8-type registry", () => {
    expect(FIELD_TYPES).toEqual(["text", "number", "date", "time", "email", "yes_no", "choice_single", "choice_multiple"])
  })

  it("falls back by keyword", () => {
    expect(fallbackType("Birthday")).toBe("date")
    expect(fallbackType("Contact email")).toBe("email")
    expect(fallbackType("Wake-up time")).toBe("time")
    expect(fallbackType("How many guests")).toBe("number")
    expect(fallbackType("Pick a genre")).toBe("choice_single")
    expect(fallbackType("Notes")).toBe("text")
  })

  it("trusts confident Jev types, falls back otherwise", () => {
    expect(typeFromAnswers({ field_type: { choice: "date", confidence: 0.9 } }, "Birthday").type).toBe("date")
    const fb = typeFromAnswers({ field_type: { choice: "date", confidence: 0.2 } }, "Birthday")
    expect(fb.type).toBe("date") // fallback agrees here
    expect(fb.usedFallback).toContain("field_type")
    const bad = typeFromAnswers({ field_type: { choice: "mystery", confidence: 0.9 } }, "Notes")
    expect(bad.type).toBe("text")
  })
})

describe("design intents", () => {
  it("parses option intents with keyword fallback", () => {
    expect(optionIntentFromAnswers({ intent: { choice: "done_options", confidence: 0.9 } }, "done").intent).toBe("done_options")
    expect(optionIntentFromAnswers({}, "done").intent).toBe("done_options")
    expect(optionIntentFromAnswers({}, "remove last").intent).toBe("remove_last")
    expect(optionIntentFromAnswers({}, "Sci-fi").intent).toBe("add_option")
  })

  it("parses required with noul + keyword fallback", () => {
    expect(requiredFromAnswers({ required: { noul: 0.95 } }, "yes").required).toBe(true)
    expect(requiredFromAnswers({}, "yes, required").required).toBe(true)
    expect(requiredFromAnswers({}, "optional").required).toBe(false)
  })

  it("parses session intents", () => {
    expect(sessionIntentFromAnswers({ intent: { choice: "finished", confidence: 0.9 } }, "finished").intent).toBe("finished")
    expect(sessionIntentFromAnswers({}, "finished").intent).toBe("finished")
    expect(sessionIntentFromAnswers({}, "delete last").intent).toBe("delete_last")
    expect(sessionIntentFromAnswers({}, "something else").intent).toBe("next_field")
  })
})

describe("end-of-session required", () => {
  const fields = [
    { id: "f1", name: "Email" },
    { id: "f2", name: "Birthday" },
  ]

  it("maps one noul per field", () => {
    const { requiredIds, usedFallback } = requiredFieldsFromAnswers({
      required_f1: { noul: 0.95 },
      required_f2: { noul: 0.05 },
    }, fields, "email")
    expect(requiredIds).toEqual(["f1"])
    expect(usedFallback).toEqual([])
  })

  it("falls back to name mentions, all, or none", () => {
    expect(requiredFieldsFromAnswers({}, fields, "email and birthday").requiredIds).toEqual(["f1", "f2"])
    expect(requiredFieldsFromAnswers({}, fields, "all of them").requiredIds).toEqual(["f1", "f2"])
    expect(requiredFieldsFromAnswers({}, fields, "none").requiredIds).toEqual([])
  })

  it("only asks about fields never decided", () => {
    const all = [
      { id: "f1", name: "Email", requiredDecided: true },
      { id: "f2", name: "Birthday" },
    ]
    expect(fieldsNeedingRequired(all).map((f) => f.id)).toEqual(["f2"])
    expect(fieldsNeedingRequired([])).toEqual([])
  })
})

describe("design options + validation", () => {
  it("adds options verbatim, dedups, caps", () => {
    const field = { options: [] }
    expect(addOption(field, " Sci-fi ").ok).toBe(true)
    expect(field.options).toEqual(["Sci-fi"])
    expect(addOption(field, "sci-fi").ok).toBe(false)
    expect(addOption(field, "").ok).toBe(false)
  })

  it("validates names", () => {
    expect(validateFieldName("", [])).toMatch(/name/)
    expect(validateFieldName("A", [{ name: "a" }])).toMatch(/already used/)
    expect(validateFieldName("ok", [])).toBeNull()
  })

  it("round-trips the schema through storage", () => {
    const store = (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) } })()
    saveSchema([{ id: "f1", name: "Genre", type: "choice_single", required: false, options: ["a"] }], store)
    expect(store.getItem(SCHEMA_KEY)).toContain("Genre")
    expect(loadSchema(store)).toHaveLength(1)
  })
})

describe("field card", () => {
  const field = { id: "f1", name: "Genre", type: "choice_single", required: true, options: ["a", "b"] }

  it("is tappable to select, with no editor panel", () => {
    const html = fieldCardHtml(field, 0, false)
    expect(html).toContain("design#selectField")
    expect(html).not.toContain("<select")
    expect(html).not.toContain("design#closeEditor")
  })

  it("highlights the selected field", () => {
    expect(fieldCardHtml(field, 0, true)).toContain("2px solid #2563eb")
  })
})

describe("voice edit menu", () => {
  it("routes aspects, removal, and finish", () => {
    expect(parseEditMenu("name")).toBe("name")
    expect(parseEditMenu("rename it")).toBe("name")
    expect(parseEditMenu("change the name")).toBe("name")
    expect(parseEditMenu("change the type")).toBe("type")
    expect(parseEditMenu("add an option")).toBe("options")
    expect(parseEditMenu("make it required")).toBe("required")
    expect(parseEditMenu("remove it")).toBe("remove")
    expect(parseEditMenu("done")).toBe("done")
    expect(parseEditMenu("scifi")).toBeNull()
  })

  it("only offers options for choice fields", () => {
    expect(editMenuPrompt({ name: "Genre", type: "choice_single" })).toContain("options")
    expect(editMenuPrompt({ name: "Age", type: "number" })).not.toContain("options")
  })

  it("hears field types with synonyms", () => {
    expect(parseFieldType("multiple choice")).toBe("choice_multiple")
    expect(parseFieldType("dropdown")).toBe("choice_single")
    expect(parseFieldType("yes or no")).toBe("yes_no")
    expect(parseFieldType("email address")).toBe("email")
    expect(parseFieldType("birthday")).toBe("date")
    expect(parseFieldType("scifi")).toBeNull()
  })
})
