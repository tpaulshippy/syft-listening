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
  splitPrompt,
  defaultDashboard,
  dashboardFromAnswers,
  panelTitle,
  dashboardContainerStyle,
  panelSectionHtml,
  parseDatasetText,
  parseCsv,
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

describe("dashboard (option 2: multi-panel)", () => {
  const schema = inferSchema(SAMPLES.bookstore)

  it("splits a spoken multi-view prompt into clauses", () => {
    expect(splitPrompt("Bar chart of revenue by genre with KPI totals")).toEqual([
      "Bar chart of revenue by genre", "KPI totals",
    ])
    expect(splitPrompt("Plot units over month and a table of everything")).toHaveLength(2)
    expect(splitPrompt("Bar chart")).toEqual(["Bar chart"])
  })

  it("builds one panel per clause offline, stacked by default", () => {
    const dash = defaultDashboard(schema, "Bar chart of revenue by genre with KPI totals")
    expect(dash.panels).toHaveLength(2)
    expect(dash.panels[0].view).toBe("bar")
    expect(dash.panels[1].view).toBe("kpi")
    expect(dash.layout).toBe("stack")
  })

  it("honours side-by-side / grid layout keywords", () => {
    expect(defaultDashboard(schema, "A bar chart and a table side by side").layout).toBe("side-by-side")
    expect(defaultDashboard(schema, "A bar chart and a table and KPIs as a grid").layout).toBe("grid")
    expect(defaultDashboard(schema, "Bar chart of revenue by genre").layout).toBe("single")
  })

  it("merges per-panel Jev answers, falling back per slot", () => {
    const { dashboard, usedFallback } = dashboardFromAnswers({
      layout: { choice: "side-by-side", confidence: 0.9 },
      panel_count: { choice: "two", confidence: 0.92 },
      view: { choice: "bar", confidence: 0.94 },
      x_field: { choice: "genre", confidence: 0.9 },
      y_field: { choice: "revenue", confidence: 0.88 },
      view_2: { choice: "kpi", confidence: 0.85 },
      y_field_2: { choice: "owner", confidence: 0.9 }, // not a column -> fallback
    }, schema, "Bar chart of revenue by genre with KPI totals")
    expect(dashboard.layout).toBe("side-by-side")
    expect(dashboard.panels).toHaveLength(2)
    expect(dashboard.panels[0].view).toBe("bar")
    expect(dashboard.panels[1].view).toBe("kpi")
    expect(usedFallback).toContain("y_field_2")
    expect(usedFallback).not.toContain("view_2")
  })

  it("clamps to a single panel when Jev says one", () => {
    const { dashboard } = dashboardFromAnswers({
      panel_count: { choice: "one", confidence: 0.95 },
      view: { choice: "table", confidence: 0.9 },
    }, schema, "Bar chart of revenue by genre with KPI totals")
    expect(dashboard.panels).toHaveLength(1)
    expect(dashboard.layout).toBe("single")
  })

  it("derives deterministic panel titles", () => {
    const { dashboard } = dashboardFromAnswers({}, schema, "Bar chart of revenue by genre")
    expect(panelTitle(dashboard.panels[0], schema)).toBe("revenue by genre · bar")
  })

  it("renders panel sections with chart slots and titles", () => {
    const { dashboard } = dashboardFromAnswers({
      panel_count: { choice: "two", confidence: 0.9 },
      view: { choice: "bar", confidence: 0.9 },
      x_field: { choice: "genre", confidence: 0.9 },
      y_field: { choice: "revenue", confidence: 0.9 },
      view_2: { choice: "kpi", confidence: 0.9 },
    }, schema, "Bar chart of revenue by genre with KPI totals")
    const html = dashboard.panels.map((p, i) => panelSectionHtml(p, SAMPLES.bookstore, schema, i)).join("")
    expect(html).toContain('data-chart-slot="0"')
    expect(html).toContain("revenue by genre · bar")
    expect(html).toContain("6,688") // total revenue KPI across all 8 rows
    expect(dashboardContainerStyle("side-by-side")).toContain("grid")
    expect(dashboardContainerStyle("stack")).toContain("column")
  })
})

describe("CSV dataset input", () => {
  it("parses a simple table", () => {
    const { rows, error } = parseDatasetText("genre,units,revenue\nscifi,35,665\nfiction,42,756\n")
    expect(error).toBeUndefined()
    expect(rows).toEqual([
      { genre: "scifi", units: "35", revenue: "665" },
      { genre: "fiction", units: "42", revenue: "756" },
    ])
    const schema = inferSchema(rows)
    const byName = Object.fromEntries(schema.columns.map((c) => [c.name, c.type]))
    expect(byName).toMatchObject({ genre: "categorical", units: "numeric", revenue: "numeric" })
  })

  it("handles quoted commas, escaped quotes, and CRLF", () => {
    const { rows, error } = parseDatasetText('title,units\r\n"The Midnight, Library",42\r\n"Say ""hi""",7\r\n')
    expect(error).toBeUndefined()
    expect(rows).toEqual([
      { title: "The Midnight, Library", units: "42" },
      { title: 'Say "hi"', units: "7" },
    ])
  })

  it("aggregates numeric strings end to end", () => {
    const { rows } = parseDatasetText("genre,units\nscifi,35\nscifi,44\nfiction,42\n")
    const schema = inferSchema(rows)
    const agg = aggregateCategory(rows,
      { xField: "genre", yField: "units", aggregation: "sum", sortBy: "label_asc" }, schema)
    expect(agg.labels).toEqual(["fiction", "scifi"])
    expect(agg.values).toEqual([42, 79])
  })

  it("rejects header-only, blank-header, and duplicate-header CSV", () => {
    expect(parseDatasetText("a,b,c\n").error).toMatch(/no data rows/)
    expect(parseDatasetText("a,,c\n1,2,3\n").error).toMatch(/blank/)
    expect(parseDatasetText("a,b,a\n1,2,3\n").error).toMatch(/duplicate/)
    expect(parseDatasetText("   ").error).toMatch(/Paste/)
  })

  it("still parses JSON arrays", () => {
    const { rows, error } = parseDatasetText('[{"a":1}]')
    expect(error).toBeUndefined()
    expect(rows).toEqual([{ a: 1 }])
  })
})
