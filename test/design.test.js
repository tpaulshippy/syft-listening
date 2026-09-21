import { describe, it, expect } from "vitest"
import {
  FIELD_TYPES,
  typeFromAnswers,
  optionIntentFromAnswers,
  requiredFromAnswers,
  requiredFieldsFromAnswers,
  sessionIntentFromAnswers,
  fieldsNeedingRequired,
  fieldCardHtml,
  editIntentFromAnswers,
  editMenuPrompt,
  addOption,
  validateFieldName,
  loadSchema,
  saveSchema,
  SCHEMA_KEY,
} from "../app/javascript/controllers/design_controller.js"

describe("design field types (Jev only)", () => {
  it("covers the 8-type registry", () => {
    expect(FIELD_TYPES).toEqual(["text", "number", "date", "time", "email", "yes_no", "choice_single", "choice_multiple"])
  })

  it("trusts confident Jev types, marks unsure for repeat", () => {
    expect(typeFromAnswers({ field_type: { choice: "date", confidence: 0.9 } }).type).toBe("date")
    const unsure = typeFromAnswers({ field_type: { choice: "date", confidence: 0.2 } })
    expect(unsure.type).toBeNull()
    expect(unsure.usedFallback).toContain("field_type")
    expect(typeFromAnswers({ field_type: { choice: "mystery", confidence: 0.9 } }).usedFallback).toContain("field_type")
    expect(typeFromAnswers({}).type).toBeNull()
  })
})

describe("design intents (Jev only)", () => {
  it("marks unsure option intents for repeat", () => {
    expect(optionIntentFromAnswers({ intent: { choice: "done_options", confidence: 0.9 } }).intent).toBe("done_options")
    expect(optionIntentFromAnswers({}).intent).toBeNull()
    expect(optionIntentFromAnswers({}).usedFallback).toContain("intent")
  })

  it("marks unsure required for repeat", () => {
    expect(requiredFromAnswers({ required: { noul: 0.95 } }).required).toBe(true)
    expect(requiredFromAnswers({}).required).toBeNull()
  })

  it("marks unsure session intents for repeat", () => {
    expect(sessionIntentFromAnswers({ intent: { choice: "finished", confidence: 0.9 } }).intent).toBe("finished")
    expect(sessionIntentFromAnswers({}).intent).toBeNull()
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
    }, fields)
    expect(requiredIds).toEqual(["f1"])
    expect(usedFallback).toEqual([])
  })

  it("marks any unsure field for repeat", () => {
    const { requiredIds, usedFallback } = requiredFieldsFromAnswers({
      required_f1: { noul: 0.95 },
    }, fields)
    expect(requiredIds).toEqual(["f1"])
    expect(usedFallback).toEqual(["required_f2"])
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
    expect(validateFieldName("", [])).toContain('name')
    expect(validateFieldName("A", [{ name: "a" }])).toContain('already used')
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

describe("voice edit menu (Jev first)", () => {
  it("trusts the edit_intent choice, marks unsure for repeat", () => {
    expect(editIntentFromAnswers({ intent: { choice: "type", confidence: 0.9 } }).aspect).toBe("type")
    expect(editIntentFromAnswers({}).aspect).toBeNull()
    expect(editIntentFromAnswers({}).usedFallback).toContain("intent")
  })

  it("only offers options for choice fields", () => {
    expect(editMenuPrompt({ name: "Genre", type: "choice_single" })).toContain("options")
    expect(editMenuPrompt({ name: "Age", type: "number" })).not.toContain("options")
  })

  it("hears retypes through the change_type merger", () => {
    expect(typeFromAnswers({ field_type: { choice: "number", confidence: 0.9 } }).type).toBe("number")
    expect(typeFromAnswers({}).type).toBeNull()
  })
})
