import { describe, it, expect } from "vitest"
import {
  SAMPLES,
  inferSchema,
  slugify,
  columnType,
  defaultSpec,
  specFromAnswers,
  aggregateCategory,
  scatterSeries,
  buildChartConfig,
  renderTableHtml,
  renderCardsHtml,
  renderKpiHtml,
  chartUnavailableHtml,
  resolveChartClass,
} from "../app/javascript/controllers/studio_controller.js"

describe("inferSchema (arbitrary data)", () => {
  it("types bookstore columns", () => {
    const schema = inferSchema(SAMPLES.bookstore)
    const byName = Object.fromEntries(schema.columns.map((c) => [c.name, c.type]))
    expect(byName).toMatchObject({ genre: "categorical", units: "numeric", revenue: "numeric", month: "temporal", title: "categorical" })
    expect(schema.row_count).toBe(SAMPLES.bookstore.length)
  })

  it("handles an unseen shape (exoplanets) with zero task-specific code", () => {
    const planets = [
      { name: "Kepler-186f", type: "rocky", moons: 0, distance_au: 0.36, discovered: "2014-04-17" },
      { name: "HD 209458 b", type: "gas giant", moons: 0, distance_au: 0.047, discovered: "1999-11-05" },
      { name: "Titan (moon of Saturn)", type: "moon", moons: 1, distance_au: 9.5, discovered: "1655-03-25" },
    ]
    const schema = inferSchema(planets)
    const byName = Object.fromEntries(schema.columns.map((c) => [c.name, c.type]))
    expect(byName).toMatchObject({ type: "categorical", moons: "numeric", distance_au: "numeric", discovered: "temporal" })
  })

  it("slugifies odd names uniquely", () => {
    const taken = {}
    expect(slugify("Minutes Open", taken)).toBe("minutes_open")
    expect(slugify("minutes-open!", taken)).toBe("minutes_open_2")
    expect(slugify("!!!", taken)).toBe("col")
  })

  it("treats long strings as text", () => {
    expect(columnType(["short", "x".repeat(80)])).toBe("text")
  })
})

describe("defaultSpec (offline voice-prompt parse)", () => {
  const schema = inferSchema(SAMPLES.bookstore)

  it("parses a spoken bar-chart request", () => {
    const spec = defaultSpec(schema, "Bar chart of revenue by genre")
    expect(spec.view).toBe("bar")
    expect(spec.xField).toBe("genre")
    expect(spec.yField).toBe("revenue")
  })

  it("parses a trend request onto the time axis", () => {
    const spec = defaultSpec(schema, "Show the trend of units over month as a line")
    expect(spec.view).toBe("line")
    expect(spec.xField).toBe("month")
    expect(spec.yField).toBe("units")
  })

  it("parses a table request with biggest-first sort", () => {
    const inc = inferSchema(SAMPLES.incidents)
    const spec = defaultSpec(inc, "Table of all incidents, biggest minutes_open first")
    expect(spec.view).toBe("table")
    expect(spec.yField).toBe("minutes_open")
    expect(spec.sortBy).toBe("value_desc")
  })

  it("parses a KPI request", () => {
    const spec = defaultSpec(inferSchema(SAMPLES.workouts), "KPI totals: how many workouts and total minutes")
    expect(spec.view).toBe("kpi")
  })

  it("puts scatter on two numeric axes", () => {
    const spec = defaultSpec(inferSchema(SAMPLES.workouts), "Scatter of km vs minutes")
    expect(spec.view).toBe("scatter")
    expect(spec.xField).toBe("minutes")
    expect(spec.yField).toBe("km")
  })
})

describe("specFromAnswers (parallel-answer merge)", () => {
  const schema = inferSchema(SAMPLES.bookstore)

  it("trusts confident Jev answers", () => {
    const { spec, usedFallback } = specFromAnswers({
      view: { choice: "bar", confidence: 0.94 },
      x_field: { choice: "genre", confidence: 0.9 },
      y_field: { choice: "revenue", confidence: 0.88 },
      aggregation: { choice: "sum", confidence: 0.8 },
      show_legend: { noul: 0.95 },
    }, schema, "Bar chart of revenue by genre")
    expect(spec.view).toBe("bar")
    expect(spec.xField).toBe("genre")
    expect(spec.showLegend).toBe(true)
    expect(usedFallback).not.toContain("view")
  })

  it("rejects slugs outside the schema and falls back per-question", () => {
    const { spec, usedFallback } = specFromAnswers({
      view: { choice: "bar", confidence: 0.9 },
      x_field: { choice: "owner", confidence: 0.9 }, // not a bookstore column
      y_field: { choice: "revenue", confidence: 0.2 }, // unsure
    }, schema, "Bar chart of revenue by genre")
    expect(spec.xField).toBe("genre")
    expect(usedFallback).toContain("x_field")
    expect(usedFallback).toContain("y_field")
  })
})

describe("aggregation + Chart.js config", () => {
  const schema = inferSchema(SAMPLES.bookstore)

  it("sums revenue by genre", () => {
    const agg = aggregateCategory(SAMPLES.bookstore,
      { xField: "genre", yField: "revenue", aggregation: "sum", sortBy: "label_asc" }, schema)
    expect(agg.labels).toEqual(["fiction", "nonfiction", "scifi"])
    expect(agg.values).toEqual([1674, 2772, 2242])
  })

  it("counts rows per month", () => {
    const agg = aggregateCategory(SAMPLES.bookstore,
      { xField: "month", yField: "count_rows", aggregation: "count", sortBy: "label_asc" }, schema)
    expect(agg.labels).toEqual(["2026-06", "2026-07"])
    expect(agg.values).toEqual([3, 5])
  })

  it("builds a bar config Chart.js can consume", () => {
    const spec = defaultSpec(schema, "Bar chart of revenue by genre")
    const config = buildChartConfig(spec, SAMPLES.bookstore, schema)
    expect(config.type).toBe("bar")
    expect(config.data.labels).toContain("scifi")
    expect(config.data.datasets[0].data).toContain(2242)
  })

  it("builds a pie config for share requests", () => {
    const spec = defaultSpec(schema, "Pie chart share of units by genre")
    const config = buildChartConfig(spec, SAMPLES.bookstore, schema)
    expect(config.type).toBe("pie")
    expect(config.data.datasets[0].data.reduce((a, b) => a + b, 0)).toBe(365)
  })

  it("builds scatter series from two numeric columns", () => {
    const wschema = inferSchema(SAMPLES.workouts)
    const spec = defaultSpec(wschema, "Scatter of km vs minutes")
    const series = scatterSeries(SAMPLES.workouts, spec, wschema)
    expect(series.length).toBe(1)
    expect(series[0].data).toHaveLength(6)
    expect(series[0].data[0]).toMatchObject({ x: 32, y: 5.1 })
  })
})

describe("DOM renderers", () => {
  const schema = inferSchema(SAMPLES.incidents)

  it("explains chart failures with the underlying reason", () => {
    const html = chartUnavailableHtml("Failed to fetch chart.js.js <script>")
    expect(html).toContain("Tabulated instead")
    expect(html).toContain("Failed to fetch")
    expect(html).not.toContain("<script>")
  })

  it("resolves the UMD Chart class off window", () => {
    function FakeChart() {}
    expect(resolveChartClass({ Chart: FakeChart })).toBe(FakeChart)
    expect(resolveChartClass({ Chart: { Chart: FakeChart, registerables: [] } })).toBe(FakeChart)
    expect(() => resolveChartClass({})).toThrow("failed to load")
    expect(() => resolveChartClass({ Chart: {} })).toThrow("failed to load")
    expect(() => resolveChartClass(undefined)).toThrow("failed to load")
  })

  it("renders a table with schema headers, biggest first", () => {
    const spec = defaultSpec(schema, "Table of all incidents, biggest minutes_open first")
    const html = renderTableHtml(SAMPLES.incidents, spec, schema)
    expect(html).toContain("minutes_open")
    expect(html.indexOf("INC-102")).toBeLessThan(html.indexOf("INC-105"))
  })

  it("renders KPI sums for numeric columns", () => {
    const spec = defaultSpec(schema, "KPI totals")
    const html = renderKpiHtml(SAMPLES.incidents, spec, schema)
    expect(html).toContain("270") // 47+120+25+63+15
  })

  it("renders one card per record", () => {
    const spec = defaultSpec(schema, "Cards of incidents")
    const html = renderCardsHtml(SAMPLES.incidents, spec, schema)
    for (const row of SAMPLES.incidents) expect(html).toContain(row.id)
  })
})

describe("end-to-end on a never-before-seen dataset (voice prompt, no key)", () => {
  const planets = [
    { name: "Kepler-186f", type: "rocky", moons: 0, distance_au: 0.36 },
    { name: "Kepler-22b", type: "rocky", moons: 0, distance_au: 0.85 },
    { name: "HD 209458 b", type: "gas giant", moons: 0, distance_au: 0.047 },
    { name: "51 Pegasi b", type: "gas giant", moons: 0, distance_au: 0.052 },
    { name: "Europa", type: "moon", moons: 1, distance_au: 5.2 },
  ]

  it("goes from spoken prompt to chart config with no task-specific code", () => {
    const schema = inferSchema(planets)
    const spec = defaultSpec(schema, "Bar chart of moons by type")
    expect(spec.view).toBe("bar")
    const config = buildChartConfig(spec, planets, schema)
    expect(config.type).toBe("bar")
    const i = config.data.labels.indexOf("moon")
    expect(config.data.datasets[0].data[i]).toBe(1)
  })
})
