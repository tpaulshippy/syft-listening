import { describe, it, expect } from "vitest"
import {
  SAMPLES,
  inferSchema,
  refToName,
  constantSpec,
  specFromAnswers,
  aggregateCategory,
  scatterSeries,
  buildChartConfig,
  renderTableHtml,
  renderCardsHtml,
  renderKpiHtml,
  chartUnavailableHtml,
  resolveChartClass,
  dashboardFromAnswers,
  panelTitle,
  dashboardContainerStyle,
  panelSectionHtml,
  isBlockingFallback,
  partitionFallbacks,
  parseDatasetText,
  applyFilter,
  filterLabel,
  FILTER_OPS,
  shouldAutoLoadDataset,
} from "../app/javascript/controllers/studio_controller.js"

describe("inferSchema (names in order, no types)", () => {
  it("lists bookstore columns with positional refs", () => {
    const schema = inferSchema(SAMPLES.bookstore)
    expect(schema.columns.map((c) => c.name)).toEqual(["title", "genre", "units", "revenue", "month"])
    expect(refToName(schema, "col3")).toBe("revenue")
    expect(refToName(schema, "col9")).toBe("col9")
    expect(schema.row_count).toBe(SAMPLES.bookstore.length)
  })

  it("handles an unseen shape (exoplanets) with zero task-specific code", () => {
    const planets = [
      { name: "Kepler-186f", type: "rocky", moons: 0, distance_au: 0.36, discovered: "2014-04-17" },
      { name: "HD 209458 b", type: "gas giant", moons: 0, distance_au: 0.047, discovered: "1999-11-05" },
      { name: "Titan (moon of Saturn)", type: "moon", moons: 1, distance_au: 9.5, discovered: "1655-03-25" },
    ]
    const schema = inferSchema(planets)
    expect(schema.columns.map((c) => c.name)).toEqual(["name", "type", "moons", "distance_au", "discovered"])
  })
})

describe("constantSpec (schema-derived starting point, Jev fills the rest)", () => {
  const schema = inferSchema(SAMPLES.bookstore)

  it("starts from a fixed table spec, never prompt words", () => {
    const spec = constantSpec(schema, "Bar chart of revenue by genre")
    expect(spec.view).toBe("table")
    expect(spec.xField).toBe("col0") // first column, positional
    expect(spec.yField).toBe("count_rows")
    expect(spec.filter).toBeNull()
  })

  it("merges a confident Jev bar spec over the constants", () => {
    const { spec, usedFallback } = specFromAnswers({
      view: { choice: "bar", confidence: 0.94 },
      x_field: { choice: "col1", confidence: 0.9 },
      y_field: { choice: "col3", confidence: 0.88 },
      aggregation: { choice: "sum", confidence: 0.8 },
      show_legend: { noul: 0.95 },
    }, schema, "Bar chart of revenue by genre")
    expect(spec.view).toBe("bar")
    expect(spec.xField).toBe("col1")
    expect(usedFallback).not.toContain("view")
  })
})

describe("specFromAnswers (parallel-answer merge)", () => {
  const schema = inferSchema(SAMPLES.bookstore)

  it("trusts confident Jev answers", () => {
    const { spec, usedFallback } = specFromAnswers({
      view: { choice: "bar", confidence: 0.94 },
      x_field: { choice: "col1", confidence: 0.9 },
      y_field: { choice: "col3", confidence: 0.88 },
      aggregation: { choice: "sum", confidence: 0.8 },
      show_legend: { noul: 0.95 },
    }, schema, "Bar chart of revenue by genre")
    expect(spec.view).toBe("bar")
    expect(spec.xField).toBe("col1")
    expect(spec.showLegend).toBe(true)
    expect(usedFallback).not.toContain("view")
  })

  it("marks unsure and out-of-schema answers for repeat", () => {
    const { spec, usedFallback } = specFromAnswers({
      view: { choice: "bar", confidence: 0.9 },
      x_field: { choice: "col9", confidence: 0.9 }, // past the last column
      y_field: { choice: "col3", confidence: 0.2 }, // unsure
    }, schema, "Bar chart of revenue by genre")
    expect(spec.xField).toBe("col0") // constant default, not a guess
    expect(usedFallback).toContain("x_field")
    expect(usedFallback).toContain("y_field")
  })
})

describe("aggregation + Chart.js config", () => {
  const schema = inferSchema(SAMPLES.bookstore)

  it("sums revenue by genre", () => {
    const agg = aggregateCategory(SAMPLES.bookstore,
      { xField: "col1", yField: "col3", aggregation: "sum", sortBy: "label_asc" }, schema)
    expect(agg.labels).toEqual(["fiction", "nonfiction", "scifi"])
    expect(agg.values).toEqual([1674, 2772, 2242])
  })

  it("counts rows per month", () => {
    const agg = aggregateCategory(SAMPLES.bookstore,
      { xField: "col4", yField: "count_rows", aggregation: "count", sortBy: "label_asc" }, schema)
    expect(agg.labels).toEqual(["2026-06", "2026-07"])
    expect(agg.values).toEqual([3, 5])
  })

  it("builds a bar config Chart.js can consume", () => {
    const { spec } = specFromAnswers({
      view: { choice: "bar", confidence: 0.9 },
      x_field: { choice: "col1", confidence: 0.9 },
      y_field: { choice: "col3", confidence: 0.9 },
      aggregation: { choice: "sum", confidence: 0.9 },
      sort_by: { choice: "label_asc", confidence: 0.9 },
    }, schema, "Bar chart of revenue by genre")
    const config = buildChartConfig(spec, SAMPLES.bookstore, schema)
    expect(config.type).toBe("bar")
    expect(config.data.labels).toContain("scifi")
    expect(config.data.datasets[0].data).toContain(2242)
  })

  it("builds a pie config for share requests", () => {
    const { spec } = specFromAnswers({
      view: { choice: "pie", confidence: 0.9 },
      x_field: { choice: "col1", confidence: 0.9 },
      y_field: { choice: "col2", confidence: 0.9 },
      aggregation: { choice: "sum", confidence: 0.9 },
      sort_by: { choice: "label_asc", confidence: 0.9 },
    }, schema, "Pie chart share of units by genre")
    const config = buildChartConfig(spec, SAMPLES.bookstore, schema)
    expect(config.type).toBe("pie")
    expect(config.data.datasets[0].data.reduce((a, b) => a + b, 0)).toBe(365)
  })

  it("builds scatter series from two numeric columns", () => {
    const wschema = inferSchema(SAMPLES.workouts)
    const { spec } = specFromAnswers({
      view: { choice: "scatter", confidence: 0.9 },
      x_field: { choice: "col2", confidence: 0.9 },
      y_field: { choice: "col3", confidence: 0.9 },
    }, wschema, "Scatter of km vs minutes")
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
    const { spec } = specFromAnswers({
      view: { choice: "table", confidence: 0.9 },
      y_field: { choice: "col3", confidence: 0.9 },
      sort_by: { choice: "value_desc", confidence: 0.9 },
    }, schema, "Table of all incidents, biggest minutes_open first")
    const html = renderTableHtml(SAMPLES.incidents, spec, schema)
    expect(html).toContain("minutes_open")
    expect(html.indexOf("INC-102")).toBeLessThan(html.indexOf("INC-105"))
  })

  it("renders the Jev-chosen metric", () => {
    const { spec } = specFromAnswers({
      view: { choice: "kpi", confidence: 0.9 },
      y_field: { choice: "col3", confidence: 0.9 },
    }, schema, "KPI totals")
    const html = renderKpiHtml(SAMPLES.incidents, spec, schema)
    expect(html).toContain("270") // 47+120+25+63+15
  })

  it("renders a count card when Jev picks count_rows", () => {
    const { spec } = specFromAnswers({
      view: { choice: "kpi", confidence: 0.9 },
      y_field: { choice: "count_rows", confidence: 0.9 },
    }, schema, "KPI totals")
    const html = renderKpiHtml(SAMPLES.incidents, spec, schema)
    expect(html).toContain("5")
  })

  it("renders one card per record", () => {
    const { spec } = specFromAnswers({ view: { choice: "cards", confidence: 0.9 } }, schema, "Cards of incidents")
    const html = renderCardsHtml(SAMPLES.incidents, spec, schema)
    for (const row of SAMPLES.incidents) expect(html).toContain(row.id)
  })
})

describe("end-to-end on a never-before-seen dataset (Jev answers, no task code)", () => {
  const planets = [
    { name: "Kepler-186f", type: "rocky", moons: 0, distance_au: 0.36 },
    { name: "Kepler-22b", type: "rocky", moons: 0, distance_au: 0.85 },
    { name: "HD 209458 b", type: "gas giant", moons: 0, distance_au: 0.047 },
    { name: "51 Pegasi b", type: "gas giant", moons: 0, distance_au: 0.052 },
    { name: "Europa", type: "moon", moons: 1, distance_au: 5.2 },
  ]

  it("goes from Jev answers to chart config with no task-specific code", () => {
    const schema = inferSchema(planets)
    const { spec, usedFallback } = specFromAnswers({
      view: { choice: "bar", confidence: 0.9 },
      x_field: { choice: "col1", confidence: 0.9 },
      y_field: { choice: "col2", confidence: 0.9 },
      aggregation: { choice: "sum", confidence: 0.9 },
      sort_by: { choice: "label_asc", confidence: 0.9 },
    }, schema, "Bar chart of moons by type")
    expect(usedFallback).not.toContain("view")
    expect(usedFallback).not.toContain("x_field")
    expect(usedFallback).not.toContain("y_field")
    expect(spec.view).toBe("bar")
    const config = buildChartConfig(spec, planets, schema)
    expect(config.type).toBe("bar")
    const i = config.data.labels.indexOf("moon")
    expect(config.data.datasets[0].data[i]).toBe(1)
  })
})

describe("dashboard (Jev-driven multi-panel)", () => {
  const schema = inferSchema(SAMPLES.bookstore)

  it("starts from one constant panel and grows on Jev's count", () => {
    const { dashboard, usedFallback } = dashboardFromAnswers({
      panel_count: { choice: "two", confidence: 0.92 },
      layout: { choice: "stack", confidence: 0.9 },
      view: { choice: "bar", confidence: 0.9 },
      x_field: { choice: "col1", confidence: 0.9 },
      y_field: { choice: "col3", confidence: 0.9 },
      view_2: { choice: "kpi", confidence: 0.9 },
    }, schema, "Bar chart of revenue by genre with KPI totals")
    expect(dashboard.panels).toHaveLength(2)
    expect(dashboard.panels[0].view).toBe("bar")
    expect(dashboard.panels[1].view).toBe("kpi")
    expect(dashboard.layout).toBe("stack")
    expect(usedFallback).not.toContain("panel_count")
  })

  it("marks an unsure count for repeat instead of guessing panels", () => {
    const { usedFallback } = dashboardFromAnswers({}, schema, "Bar chart")
    expect(usedFallback).toContain("panel_count")
  })

  it("merges per-panel Jev answers, falling back per slot", () => {
    const { dashboard, usedFallback } = dashboardFromAnswers({
      layout: { choice: "side-by-side", confidence: 0.9 },
      panel_count: { choice: "two", confidence: 0.92 },
      view: { choice: "bar", confidence: 0.94 },
      x_field: { choice: "col1", confidence: 0.9 },
      y_field: { choice: "col3", confidence: 0.88 },
      view_2: { choice: "kpi", confidence: 0.85 },
      y_field_2: { choice: "col9", confidence: 0.9 }, // past the last column -> fallback
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
    const { dashboard } = dashboardFromAnswers({
      view: { choice: "bar", confidence: 0.9 },
      x_field: { choice: "col1", confidence: 0.9 },
      y_field: { choice: "col3", confidence: 0.9 },
    }, schema, "Bar chart of revenue by genre")
    expect(panelTitle(dashboard.panels[0], schema)).toBe("revenue by genre · bar")
  })

  it("renders panel sections with chart slots and titles", () => {
    const { dashboard } = dashboardFromAnswers({
      panel_count: { choice: "two", confidence: 0.9 },
      view: { choice: "bar", confidence: 0.9 },
      x_field: { choice: "col1", confidence: 0.9 },
      y_field: { choice: "col3", confidence: 0.9 },
      view_2: { choice: "kpi", confidence: 0.9 },
      y_field_2: { choice: "col3", confidence: 0.9 },
    }, schema, "Bar chart of revenue by genre with KPI totals")
    const html = dashboard.panels.map((p, i) => panelSectionHtml(p, SAMPLES.bookstore, schema, i)).join("")
    expect(html).toContain('data-chart-slot="0"')
    expect(html).toContain("revenue by genre · bar")
    expect(html).toContain("6,688") // total revenue KPI across all 8 rows
    expect(dashboardContainerStyle("side-by-side")).toContain("grid")
    expect(dashboardContainerStyle("stack")).toContain("column")
  })
})

describe("dataset input (JSON only — no CSV parsing)", () => {
  it("parses a JSON array of objects", () => {
    const { rows, error } = parseDatasetText('[{"genre":"scifi","units":35},{"genre":"fiction","units":42}]')
    expect(error).toBeUndefined()
    expect(rows).toEqual([
      { genre: "scifi", units: 35 },
      { genre: "fiction", units: 42 },
    ])
  })

  it("aggregates numbers end to end with Number conversion", () => {
    const { rows } = parseDatasetText('[{"genre":"scifi","units":"35"},{"genre":"scifi","units":"44"},{"genre":"fiction","units":"42"}]')
    const schema = inferSchema(rows)
    const agg = aggregateCategory(rows,
      { xField: "col0", yField: "col1", aggregation: "sum", sortBy: "label_asc" }, schema)
    expect(agg.labels).toEqual(["fiction", "scifi"])
    expect(agg.values).toEqual([42, 79])
  })

  it("rejects non-JSON, non-arrays, and empties", () => {
    expect(parseDatasetText("genre,units\nscifi,35\n").error).toContain('JSON')
    expect(parseDatasetText('{"a":1}').error).toContain('array')
    expect(parseDatasetText("[]").error).toContain('non-empty')
    expect(parseDatasetText("   ").error).toContain('Paste')
  })

  it("still parses JSON arrays", () => {
    const { rows, error } = parseDatasetText('[{"a":1}]')
    expect(error).toBeUndefined()
    expect(rows).toEqual([{ a: 1 }])
  })
})

describe("row filter (Jev-native)", () => {
  const schema = inferSchema(SAMPLES.incidents)

  it("offers the documented operators", () => {
    expect(FILTER_OPS).toEqual(["equals", "contains", "starts_with", "ends_with"])
  })

  it("matches equals case-insensitively", () => {
    const kept = applyFilter(SAMPLES.incidents, schema, { column: "status", op: "equals", value: "OPEN" })
    expect(kept.map((r) => r.id).sort()).toEqual(["INC-102", "INC-103"])
  })

  it("matches contains / starts_with / ends_with", () => {
    const ids = (f) => applyFilter(SAMPLES.incidents, schema, f).map((r) => r.id).sort()
    expect(ids({ column: "owner", op: "contains", value: "am" })).toEqual(["INC-102"])
    expect(ids({ column: "service", op: "starts_with", value: "CHECK" })).toEqual(["INC-101", "INC-103"])
    expect(ids({ column: "id", op: "ends_with", value: "05" })).toEqual(["INC-105"])
  })

  it("inverts matches when negated", () => {
    const ids = (f) => applyFilter(SAMPLES.incidents, schema, f).map((r) => r.id).sort()
    expect(ids({ column: "status", op: "equals", value: "open", negate: true }))
      .toEqual(["INC-101", "INC-104", "INC-105"])
    expect(ids({ column: "owner", op: "contains", value: "a", negate: true }))
      .toEqual(["INC-104", "INC-105"])
  })

  it("labels a negated filter", () => {
    expect(filterLabel({ column: "status", op: "equals", value: "open", negate: true }, schema))
      .toBe("status ≠ open")
    expect(filterLabel({ column: "owner", op: "contains", value: "am", negate: true }, schema))
      .toBe("owner doesn't contain “am”")
  })

  it("returns all rows without a filter and none on mismatch", () => {
    expect(applyFilter(SAMPLES.incidents, schema, null)).toHaveLength(5)
    expect(applyFilter(SAMPLES.incidents, schema, { column: "status", op: "equals", value: "nobody" })).toHaveLength(0)
  })

  it("labels a filter per operator", () => {
    expect(filterLabel({ column: "status", op: "equals", value: "open" }, schema)).toBe("status = open")
    expect(filterLabel({ column: "owner", op: "contains", value: "am" }, schema)).toBe("owner contains “am”")
    expect(filterLabel({ column: "service", op: "starts_with", value: "check" }, schema)).toBe("service starts with “check”")
  })

  it("starts unfiltered until Jev answers", () => {
    expect(constantSpec(schema, "Table of incidents where status is open").filter).toBeNull()
  })

  it("merges confident Jev filter answers", () => {
    const { spec, usedFallback } = specFromAnswers({
      view: { choice: "table", confidence: 0.9 },
      filter_column: { choice: "col4", confidence: 0.9 },
      filter_op: { choice: "equals", confidence: 0.85 },
      filter_negate: { noul: 0.05 },
      filter_value_col4: { choice: "open", confidence: 0.9 },
    }, schema, "Table of open incidents", SAMPLES.incidents)
    expect(spec.filter).toEqual({ column: "col4", op: "equals", value: "open", negate: false })
    expect(usedFallback).not.toContain("filter_column")
    expect(usedFallback).not.toContain("filter_value_col4")
    expect(usedFallback).not.toContain("filter_negate")
  })

  it("merges a negated Jev filter", () => {
    const { spec } = specFromAnswers({
      filter_column: { choice: "col4", confidence: 0.9 },
      filter_op: { choice: "equals", confidence: 0.9 },
      filter_negate: { noul: 0.95 },
      filter_value_col4: { choice: "open", confidence: 0.9 },
    }, schema, "Books that are not open", SAMPLES.incidents)
    expect(spec.filter).toEqual({ column: "col4", op: "equals", value: "open", negate: true })
  })

  it("drops the filter when Jev says none or is unsure", () => {
    const none = specFromAnswers(
      { filter_column: { choice: "none", confidence: 0.95 } }, schema, "Table", SAMPLES.incidents)
    expect(none.spec.filter).toBeNull()
    const unsure = specFromAnswers(
      { filter_column: { choice: "col4", confidence: 0.2 } }, schema, "Table", SAMPLES.incidents)
    expect(unsure.spec.filter).toBeNull()
    expect(unsure.usedFallback).toContain("filter_column")
  })

  it("rejects a hallucinated value and records fallback", () => {
    const { spec, usedFallback } = specFromAnswers({
      filter_column: { choice: "col4", confidence: 0.9 },
      filter_op: { choice: "equals", confidence: 0.9 },
      filter_value_col4: { choice: "purple", confidence: 0.9 },
    }, schema, "Table", SAMPLES.incidents)
    expect(spec.filter).toBeNull()
    expect(usedFallback).toContain("filter_value_col4")
  })

  it("shares one filter across dashboard panels", () => {
    const answers = {
      panel_count: { choice: "two", confidence: 0.92 },
      view: { choice: "bar", confidence: 0.9 },
      view_2: { choice: "table", confidence: 0.9 },
      filter_column: { choice: "col1", confidence: 0.9 },
      filter_op: { choice: "equals", confidence: 0.9 },
      filter_value_col1: { choice: "checkout", confidence: 0.9 },
    }
    const { dashboard } = dashboardFromAnswers(answers, schema, "Bars and a table for checkout", SAMPLES.incidents)
    expect(dashboard.panels).toHaveLength(2)
    for (const p of dashboard.panels) {
      expect(p.filter).toEqual({ column: "col1", op: "equals", value: "checkout", negate: false })
    }
  })

  it("shows an empty state instead of an empty chart", () => {
    const html = panelSectionHtml(
      { view: "bar", xField: "status", yField: "minutes_open", filter: { column: "status", op: "equals", value: "nobody" } },
      SAMPLES.incidents, schema, 0)
    expect(html).toContain("No rows match")
    expect(html).not.toContain("data-chart-slot")
  })

  it("captions a filtered panel with match counts", () => {
    const html = panelSectionHtml(
      { view: "table", xField: "status", yField: "minutes_open", filter: { column: "status", op: "equals", value: "open" } },
      SAMPLES.incidents, schema, 0)
    expect(html).toContain("status = open")
    expect(html).toContain("2 of 5 rows")
    expect(html).toContain("INC-102")
    expect(html).not.toContain("INC-101")
  })
})

describe("fallback partition (safe display defaults never block)", () => {
  it("treats include/display flags as non-blocking", () => {
    expect(isBlockingFallback("include_col0")).toBe(false)
    expect(isBlockingFallback("include_col4")).toBe(false)
    expect(isBlockingFallback("show_legend")).toBe(false)
    expect(isBlockingFallback("show_totals")).toBe(false)
    expect(isBlockingFallback("horizontal")).toBe(false)
    expect(isBlockingFallback("view")).toBe(true)
    expect(isBlockingFallback("x_field")).toBe(true)
    expect(isBlockingFallback("filter_negate")).toBe(true)
    expect(isBlockingFallback("panel_count")).toBe(true)
  })

  it("renders table-of-all-data when Jev is lukewarm on includes (live replay)", () => {
    const spaced = [
      { "Did you brush your teeth": "no", "Did you read a story": "yes", "Did you kiss mommy": "yes", "What's your name": "Roman" },
      { "Did you brush your teeth": "yes", "Did you read a story": "yes", "Did you kiss mommy": "yes", "What's your name": "Renée" },
      { "Did you brush your teeth": "yes", "Did you read a story": "yes", "Did you kiss mommy": "yes", "What's your name": "Mercy", "How old are you": "Nine" },
    ]
    const schema = inferSchema(spaced)
    // Exact Jev nouls from the live replay: includes hover near the cliff.
    const answers = {
      panel_count: { choice: "one", confidence: 1.0 },
      layout: { choice: "single", confidence: 0.96 },
      view: { choice: "table", confidence: 1.0 },
      x_field: { choice: "col3", confidence: 0.54 },
      y_field: { choice: "col4", confidence: 0.95 },
      color_field: { choice: "col3", confidence: 0.7 },
      size_field: { choice: "col4", confidence: 0.71 },
      aggregation: { choice: "count", confidence: 0.9 },
      sort_by: { choice: "label_asc", confidence: 0.84 },
      show_legend: { noul: 0.29 },
      show_totals: { noul: 0.26 },
      horizontal: { noul: 0.54 },
      filter_column: { choice: "none", confidence: 0.94 },
      include_col0: { noul: 0.77 },
      include_col1: { noul: 0.77 },
      include_col2: { noul: 0.71 },
      include_col3: { noul: 0.76 },
      include_col4: { noul: 0.53 },
    }
    const { dashboard, usedFallback, nonBlocking: softFlags } = dashboardFromAnswers(answers, schema, "table of all data", spaced)
    expect(softFlags).toContain("include_col2")
    expect(softFlags).toContain("include_col4")
    const { blocking, nonBlocking } = partitionFallbacks(usedFallback)
    expect(blocking).toEqual([])
    expect([...nonBlocking, ...softFlags]).toContain("include_col2")
    const html = dashboard.panels.map((p, i) => panelSectionHtml(p, spaced, schema, i)).join("")
    expect(html).toContain("Did you brush your teeth")
    expect(html).toContain("Roman")
  })

  it("renders unfiltered when Jev leans none but hedges (live replay)", () => {
    const spaced = [
      { "Did you brush your teeth": "no", "What's your name": "Roman" },
      { "Did you brush your teeth": "yes", "What's your name": "Renée" },
    ]
    const schema = inferSchema(spaced)
    // Exact live Jev values for "Teeth brushing by name on a bar chart":
    // top pick none@0.52 but confidence 0.43.
    const answers = {
      panel_count: { choice: "one", confidence: 1.0 },
      layout: { choice: "single", confidence: 0.91 },
      view: { choice: "bar", confidence: 0.98 },
      x_field: { choice: "col1", confidence: 0.94 },
      y_field: { choice: "count_rows", confidence: 0.66 },
      color_field: { choice: "none", confidence: 0.66 },
      size_field: { choice: "none", confidence: 0.7 },
      aggregation: { choice: "count", confidence: 0.77 },
      sort_by: { choice: "label_asc", confidence: 0.57 },
      show_legend: { noul: 0.23 },
      show_totals: { noul: 0.47 },
      horizontal: { noul: 0.42 },
      filter_column: { choice: "none", confidence: 0.43 },
      include_col0: { noul: 0.75 },
      include_col1: { noul: 0.84 },
    }
    const { dashboard, usedFallback, nonBlocking } = dashboardFromAnswers(answers, schema, "Teeth brushing by name on a bar chart", spaced)
    expect(usedFallback).not.toContain("filter_column")
    expect(nonBlocking).toContain("filter_column")
    expect(dashboard.panels[0].filter).toBeNull()
    const { blocking } = partitionFallbacks(usedFallback)
    expect(blocking).toEqual([])
    expect(dashboard.panels[0].view).toBe("bar")
  })

  it("still blocks when Jev leans a real filter column but hedges", () => {
    const schema = inferSchema([{ a: "x" }, { a: "y" }])
    const answers = {
      panel_count: { choice: "one", confidence: 0.95 },
      layout: { choice: "single", confidence: 0.9 },
      view: { choice: "table", confidence: 0.9 },
      filter_column: { choice: "col0", confidence: 0.4 },
    }
    const { usedFallback } = dashboardFromAnswers(answers, schema, "Table", [{ a: "x" }])
    expect(usedFallback).toContain("filter_column")
    const { blocking } = partitionFallbacks(usedFallback)
    expect(blocking).toContain("filter_column")
  })
})

describe("input auto-load guard", () => {
  it("loads into an empty box, refreshes its own snapshot, never clobbers typing", () => {
    expect(shouldAutoLoadDataset("", null, '[{"a":1}]')).toBe(true)
    expect(shouldAutoLoadDataset('[{"a":1}]', '[{"a":1}]', '[{"a":1},{"a":2}]')).toBe(true)
    expect(shouldAutoLoadDataset("pasted,stuff", '[{"a":1}]', '[{"a":1},{"a":2}]')).toBe(false)
    expect(shouldAutoLoadDataset("", null, "[]")).toBe(false)
  })
})
