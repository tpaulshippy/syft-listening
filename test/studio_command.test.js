import { describe, it, expect } from "vitest"
import {
  commandFromAnswers,
  DESTINATIONS,
} from "../app/javascript/controllers/studio_command_controller.js"

describe("voice command router (Jev decides, code only decodes)", () => {
  it("routes a new field to design", () => {
    const merged = commandFromAnswers({
      destination: { choice: "design", confidence: 0.92 },
      design_target: { choice: "new_field", confidence: 0.9 },
      row_target: { choice: "none", confidence: 0.9 },
    }, ["f1", "f2"], 3)
    expect(merged.destination).toBe("design")
    expect(merged.newField).toBe(true)
    expect(merged.fieldId).toBeNull()
    expect(merged.usedFallback).toEqual([])
  })

  it("routes an edit to the Jev-chosen field id", () => {
    const merged = commandFromAnswers({
      destination: { choice: "design", confidence: 0.9 },
      design_target: { choice: "f2", confidence: 0.88 },
      row_target: { choice: "none", confidence: 0.9 },
    }, ["f1", "f2"], 3)
    expect(merged.destination).toBe("design")
    expect(merged.fieldId).toBe("f2")
    expect(merged.newField).toBe(false)
  })

  it("routes a new row to input", () => {
    const merged = commandFromAnswers({
      destination: { choice: "input", confidence: 0.9 },
      design_target: { choice: "none", confidence: 0.9 },
      row_target: { choice: "new_row", confidence: 0.91 },
    }, [], 2)
    expect(merged.destination).toBe("input")
    expect(merged.newRow).toBe(true)
    expect(merged.rowIndex).toBeNull()
  })

  it("decodes the Jev-chosen row number positionally", () => {
    const merged = commandFromAnswers({
      destination: { choice: "input", confidence: 0.9 },
      design_target: { choice: "none", confidence: 0.9 },
      row_target: { choice: "row_3", confidence: 0.87 },
    }, [], 5)
    expect(merged.rowIndex).toBe(2)
    expect(merged.newRow).toBe(false)
  })

  it("routes a visualize prompt by destination only", () => {
    const merged = commandFromAnswers({
      destination: { choice: "visualize", confidence: 0.95 },
      design_target: { choice: "none", confidence: 0.9 },
      row_target: { choice: "none", confidence: 0.9 },
    }, ["f1"], 4)
    expect(merged.destination).toBe("visualize")
    expect(DESTINATIONS).toContain("visualize")
  })

  it("marks unsure destinations for repeat instead of guessing", () => {
    const merged = commandFromAnswers({
      destination: { choice: "design", confidence: 0.2 },
      design_target: { choice: "new_field", confidence: 0.9 },
      row_target: { choice: "none", confidence: 0.9 },
    }, [], 0)
    expect(merged.destination).toBeNull()
    expect(merged.usedFallback).toContain("destination")
  })

  it("rejects out-of-range field and row choices", () => {
    const merged = commandFromAnswers({
      destination: { choice: "input", confidence: 0.9 },
      design_target: { choice: "ghost", confidence: 0.9 },
      row_target: { choice: "row_9", confidence: 0.9 },
    }, ["f1"], 2)
    expect(merged.fieldId).toBeNull()
    expect(merged.rowIndex).toBeNull()
    expect(merged.usedFallback).toContain("design_target")
    expect(merged.usedFallback).toContain("row_target")
  })
})
