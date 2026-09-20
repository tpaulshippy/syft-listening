import { describe, it, expect } from "vitest"
import {
  inferSpecFromPrompt,
  specFromAnswers,
  renderSpecHtml,
  bubbleDiameter,
  sortTasks,
  visibleTasks,
  TASKS,
} from "../app/javascript/controllers/builder_controller.js"

describe("inferSpecFromPrompt (offline keyword fallback)", () => {
  it("parses the bubbles-by-owner request", () => {
    const spec = inferSpecFromPrompt("Show open work as bubbles, coloured by owner. Flag blocked tasks.")
    expect(spec.view).toBe("bubbles")
    expect(spec.colorBy).toBe("owner")
    expect(spec.flagBlocked).toBe(true)
  })

  it("parses the blocked-left / ready-right request", () => {
    const spec = inferSpecFromPrompt("Put blocked work on the left and ready work on the right. Keep the bubbles.")
    expect(spec.view).toBe("board")
    expect(spec.split).toBe(true)
  })

  it("parses the cards + checkboxes request", () => {
    const spec = inferSpecFromPrompt("Switch to cards and add completion checkboxes.")
    expect(spec.view).toBe("cards")
    expect(spec.checkboxes).toBe(true)
  })

  it("parses the calendar reading + gym request", () => {
    const spec = inferSpecFromPrompt("Find 90 minutes in my calendar for quiet reading time, and add 45 minutes of gym after.")
    expect(spec.view).toBe("calendar")
    expect(spec.addReading).toBe(true)
    expect(spec.addGym).toBe(true)
    expect(spec.readingMinutes).toBe(90)
    expect(spec.gymMinutes).toBe(45)
  })
})

describe("specFromAnswers (parallel-answer merge)", () => {
  const prompt = "Show open work as bubbles, coloured by owner. Flag blocked tasks."

  it("trusts confident Jev answers", () => {
    const { spec, usedFallback } = specFromAnswers({
      view: { choice: "bubbles", confidence: 0.95 },
      color_by: { choice: "owner", confidence: 0.9 },
      flag_blocked: { noul: 0.97 },
    }, prompt)
    expect(spec.view).toBe("bubbles")
    expect(spec.flagBlocked).toBe(true)
    expect(usedFallback).not.toContain("view")
    expect(usedFallback).not.toContain("flag_blocked")
  })

  it("falls back per-question below 0.5 confidence", () => {
    const { spec, usedFallback } = specFromAnswers({
      view: { choice: "calendar", confidence: 0.2 },
      flag_blocked: { noul: 0.51 },
    }, prompt)
    expect(spec.view).toBe("bubbles") // keyword fallback
    expect(usedFallback).toContain("view")
    expect(usedFallback).toContain("flag_blocked")
  })

  it("overrides the keyword parse when Jev disagrees confidently", () => {
    const { spec } = specFromAnswers({
      view: { choice: "cards", confidence: 0.92 },
      show_checkboxes: { noul: 0.9 },
    }, prompt)
    expect(spec.view).toBe("cards")
    expect(spec.checkboxes).toBe(true)
  })
})

describe("renderSpecHtml (deterministic renderer)", () => {
  it("renders bubbles sized by minutes with blocked flags", () => {
    const html = renderSpecHtml(inferSpecFromPrompt("Show open work as bubbles, coloured by owner. Flag blocked tasks."))
    expect(html).toContain("Write launch story")
    expect(html).toContain("90m")
    expect(html).toContain("⛔ blocked")
  })

  it("renders a blocked / ready board", () => {
    const html = renderSpecHtml(inferSpecFromPrompt("Put blocked work on the left and ready work on the right. Keep the bubbles."))
    expect(html).toContain("Blocked")
    expect(html).toContain("Ready")
  })

  it("renders cards with checkboxes grouped by day", () => {
    const html = renderSpecHtml(inferSpecFromPrompt("Switch to cards and add completion checkboxes."))
    expect(html).toContain('type="checkbox"')
    expect(html).toContain("Thu 9/17")
  })

  it("renders the calendar with added reading + gym blocks", () => {
    const html = renderSpecHtml(inferSpecFromPrompt(
      "Find 90 minutes in my calendar for quiet reading time, and add 45 minutes of gym after."))
    expect(html).toContain("quiet reading time")
    expect(html).toContain("gym")
  })
})

describe("renderer helpers", () => {
  it("sizes bubbles by minutes and supports equal sizing", () => {
    expect(bubbleDiameter(120, "minutes")).toBeGreaterThan(bubbleDiameter(20, "minutes"))
    expect(bubbleDiameter(120, "equal")).toBe(bubbleDiameter(20, "equal"))
  })

  it("sorts largest estimate first by default", () => {
    const sorted = sortTasks(TASKS, "minutes_desc")
    expect(sorted[0].minutes).toBeGreaterThanOrEqual(sorted[1].minutes)
  })

  it("keeps all tasks when no include map is given", () => {
    expect(visibleTasks(TASKS, null)).toHaveLength(TASKS.length)
  })
})
