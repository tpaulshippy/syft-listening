import { Controller } from "@hotwired/stimulus"

// NOTE: never import across controller files — Propshaft serves each file as
// a standalone fingerprinted asset, so relative ESM imports 404 and the
// whole controller fails to register (this broke Visualize's input share).
// Shared bits are duplicated in a few lines instead.
function rowsToDataset(rows) {
  return (rows || []).map((row) => {
    const out = {}
    for (const [k, v] of Object.entries(row || {})) {
      if (k === "_index") continue
      out[k] = v
    }
    return out
  })
}

// Shared rows projected onto the design schema's column names: keys from
// renamed or deleted fields stay in storage (lossless) but never reach the
// dataset JSON or Jev's columns. With no schema (pasted data), everything
// passes through untouched.
export function projectToSchema(rows, names) {
  const wanted = Array.isArray(names) ? names.filter((n) => typeof n === "string" && n) : []
  if (!wanted.length) return rows || []
  const keep = new Set(wanted)
  return (rows || []).map((row) => {
    const out = {}
    for (const [k, v] of Object.entries(row || {})) {
      if (k === "_index" || !keep.has(k)) continue
      out[k] = v
    }
    return out
  })
}

// Generalized voice UI studio: data-agnostic parallel fan-out + generic render.
//
// State = { request, schema, rows }; questions are generated from the schema
// (field-binding choices list the dataset's own columns), Jev answers them in
// parallel, and the interpreter below maps the winning spec onto Chart.js
// (bar/line/pie/scatter/bubbles) or hand-rendered table/cards/KPI DOM.
// Pure helpers are module-level exports so Vitest can cover them without a
// browser; Chart.js is loaded lazily only when a chart actually mounts
// (jsdom has no canvas).

export const VIEWS = ["table", "cards", "kpi", "bar", "line", "pie", "scatter", "bubbles"]
const CHART_VIEWS = ["bar", "line", "pie", "scatter", "bubbles"]

export const SAMPLES = {
  bookstore: [
    { title: "The Midnight Library", genre: "fiction", units: 42, revenue: 756.0, month: "2026-06" },
    { title: "Atomic Habits", genre: "nonfiction", units: 67, revenue: 1206.0, month: "2026-06" },
    { title: "Dune", genre: "scifi", units: 35, revenue: 665.0, month: "2026-06" },
    { title: "The Midnight Library", genre: "fiction", units: 51, revenue: 918.0, month: "2026-07" },
    { title: "Atomic Habits", genre: "nonfiction", units: 58, revenue: 1044.0, month: "2026-07" },
    { title: "Dune", genre: "scifi", units: 44, revenue: 836.0, month: "2026-07" },
    { title: "Project Hail Mary", genre: "scifi", units: 39, revenue: 741.0, month: "2026-07" },
    { title: "Sapiens", genre: "nonfiction", units: 29, revenue: 522.0, month: "2026-07" },
  ],
  workouts: [
    { date: "2026-09-01", activity: "run", minutes: 32, km: 5.1, effort: 7 },
    { date: "2026-09-03", activity: "swim", minutes: 45, km: 1.5, effort: 6 },
    { date: "2026-09-05", activity: "run", minutes: 58, km: 9.2, effort: 8 },
    { date: "2026-09-08", activity: "bike", minutes: 75, km: 22.4, effort: 6 },
    { date: "2026-09-10", activity: "run", minutes: 28, km: 4.6, effort: 5 },
    { date: "2026-09-12", activity: "gym", minutes: 50, km: 0, effort: 7 },
  ],
  incidents: [
    { id: "INC-101", service: "checkout", severity: "critical", minutes_open: 47, status: "resolved", owner: "priya" },
    { id: "INC-102", service: "search", severity: "minor", minutes_open: 120, status: "open", owner: "sam" },
    { id: "INC-103", service: "checkout", severity: "major", minutes_open: 25, status: "open", owner: "maya" },
    { id: "INC-104", service: "billing", severity: "major", minutes_open: 63, status: "resolved", owner: "you" },
    { id: "INC-105", service: "search", severity: "minor", minutes_open: 15, status: "resolved", owner: "you" },
  ],
}

export const PALETTE = ["#38bdf8", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#f97316"]

// Auto-load guard: Input rows flow into the dataset on their own, but never
// clobber something the user pasted or edited. Loads when the box is empty
// or still holds the previously auto-loaded snapshot — not when the user
// has typed something of their own since.
export function shouldAutoLoadDataset(currentText, lastLoadedJson, nextJson) {
  if (!nextJson || nextJson === "[]") return false
  const current = String(currentText ?? "").trim()
  if (!current) return true
  return current === String(lastLoadedJson ?? "").trim()
}

// Dataset input: a JSON array of objects. JSON.parse decides validity —
 // no character inspection in our code.
export function parseDatasetText(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return { error: "Paste a JSON array of objects." }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: "Dataset is not valid JSON (expected an array of objects)." }
  }
  if (!Array.isArray(parsed) || !parsed.length || !parsed.every((r) => r && typeof r === "object")) {
    return { error: "Dataset must be a non-empty array of objects." }
  }
  return { rows: parsed }
}

export function escapeHtml(s) {
  // Browser-native escaping: the platform encodes, our code inspects nothing.
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const div = document.createElement("div")
    div.textContent = String(s ?? "")
    return div.innerHTML
  }
  return String(s ?? "")
}

export function cellOf(row, name) {
  if (row == null) return undefined
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name]
  return undefined
}

// Number conversion only — never character inspection. Non-coercible values
// become null and are skipped by aggregations.
export function coerceNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

// Client mirror of StudioController#infer_schema: column names in order.
// Types are gone — Jev judges numeric-ness per question from sample values.
export function inferSchema(rows) {
  const names = []
  for (const row of rows || []) {
    for (const k of Object.keys(row || {})) if (!names.includes(k)) names.push(k)
  }
  return { columns: names.slice(0, 60).map((name) => ({ name })), row_count: (rows || []).length }
}

export function noulConfidence(p) {
  return Math.abs(Number(p) - 0.5) * 2
}

// Field bindings are positional (col0, col1, …) with the real name only in
// the criteria text — no slug transform, nothing to inspect.
export function refToName(schema, ref) {
  const cols = schema?.columns || []
  if (typeof ref === "string" && ref.length > 3 && ref.slice(0, 3) === "col") {
    const i = Number(ref.slice(3))
    if (Number.isInteger(i) && cols[i]) return cols[i].name
  }
  return ref
}

// Row filter — Jev-native only. The backend asks Jev `filter_column`
// (which column, or "none"), `filter_op` (how the value matches), and one
// `filter_value_<slug>` choice per low-cardinality column, since Jev can't
// emit free text. Offline renders are unfiltered. Shape:
// { column: slug, op, value } or null.
export const FILTER_OPS = ["equals", "contains", "starts_with", "ends_with"]

function filterTest(op, want) {
  if (op === "contains") return (v) => v.includes(want)
  if (op === "starts_with") return (v) => v.startsWith(want)
  if (op === "ends_with") return (v) => v.endsWith(want)
  return (v) => v === want
}

export function applyFilter(rows, schema, filter) {
  if (!filter?.column || filter?.value == null || String(filter.value).trim() === "") return rows || []
  const name = refToName(schema, filter.column)
  const want = String(filter.value).trim().toLowerCase()
  const test = filterTest(filter.op || "equals", want)
  const negate = !!filter.negate
  return (rows || []).filter((r) => {
    const v = cellOf(r, name)
    if (v === null || v === undefined) return negate
    const hit = test(String(v).trim().toLowerCase())
    return negate ? !hit : hit
  })
}

export function filterLabel(filter, schema) {
  if (!filter) return ""
  const name = refToName(schema, filter.column)
  const value = filter.value
  const negate = !!filter.negate
  const op = filter.op || "equals"
  if (op === "contains") return negate ? `${name} doesn't contain “${value}”` : `${name} contains “${value}”`
  if (op === "starts_with") return negate ? `${name} doesn't start with “${value}”` : `${name} starts with “${value}”`
  if (op === "ends_with") return negate ? `${name} doesn't end with “${value}”` : `${name} ends with “${value}”`
  return negate ? `${name} ≠ ${value}` : `${name} = ${value}`
}

// Shared (whole-dashboard) filter from Jev answers. Targeting (column +
// value) is all-or-nothing: the value must be a real cell in that column
// (guards against a hallucinated choice), and anything Jev leaves unsure
// degrades to unfiltered with a note — a half-specified filter never vetoes
// the render ("show miles by route" names a grouping, not a filter, and Jev
// hedges the value). Operator and polarity fall back to constants with a
// note once the target is verified. Leaning-"none" is the same idea: Jev's
// top pick is unfiltered but hedged (e.g. none@0.43 vs scattered columns),
// so showing all rows lands in nonBlocking instead of blocking.
function sharedFilter(answers, fb, nonBlocking) {
  const schema = { columns: fb.schemaColumns || [] }
  const raw = answers?.filter_column
  const rawConf = Number(raw?.confidence ?? NaN)
  if (raw?.choice === "none" && !(rawConf >= 0.5)) {
    nonBlocking.push("filter_column")
    return null
  }
  const notes = []
  const m = makeMergers(answers, schema, notes, nonBlocking)
  const column = m.fieldChoice("filter_column", "none")
  if (column === "none" || column === "count_rows") {
    if (notes.includes("filter_column")) nonBlocking.push("filter_column")
    return null
  }
  const key = `filter_value_${column}`
  const a = answers?.[key]
  const conf = Number(a?.confidence ?? NaN)
  const value = typeof a?.choice === "string" ? a.choice.trim() : ""
  const op = m.choice("filter_op", "equals", FILTER_OPS)
  const negate = m.noul("filter_negate", false)
  const colName = refToName(schema, column)
  const test = filterTest(op, value.toLowerCase())
  const verified = value !== "" && conf >= 0.5 && (fb.allRows || []).some((r) => {
    const v = cellOf(r, colName)
    return v !== null && v !== undefined && test(String(v).trim().toLowerCase())
  })
  if (notes.includes("filter_column") || !verified) {
    if (!verified && !notes.includes(key)) notes.push(key)
    nonBlocking.push(...notes)
    return null
  }
  nonBlocking.push(...notes) // operator / polarity notes only
  return { column, op, value, negate }
}

// Schema-derived starting spec: fixed safe constants, never prompt words.
// Jev fills every slot; anything it leaves unsure repeats the question.
export function constantSpec(schema, prompt) {
  const cols = schema?.columns || []
  return {
    view: "table",
    xField: cols.length ? "col0" : "none",
    yField: "count_rows",
    colorField: "none",
    sizeField: "none",
    aggregation: "sum",
    sortBy: "label_asc",
    showLegend: false,
    showTotals: false,
    horizontal: false,
    include: null,
    filter: null,
    title: prompt,
  }
}

// Merge Jev answers over the constant spec; refs validated vs schema.
function makeMergers(answers, schema, usedFallback, nonBlocking = usedFallback) {
  const validRefs = new Set((schema?.columns || []).map((_, i) => `col${i}`))
  const fieldChoice = (key, fallback) => {
    const a = answers?.[key]
    const conf = Number(a?.confidence ?? NaN)
    if (a?.choice && (a.choice === "none" || a.choice === "count_rows" || validRefs.has(a.choice)) && conf >= 0.5) {
      return a.choice
    }
    usedFallback.push(key)
    return fallback
  }
  const choice = (key, fallback, allowed) => {
    const a = answers?.[key]
    const conf = Number(a?.confidence ?? NaN)
    if (a?.choice && allowed.includes(a.choice) && conf >= 0.5) return a.choice
    usedFallback.push(key)
    return fallback
  }
  const noul = (key, fallback) => {
    const a = answers?.[key]
    if (a == null || a.noul == null) { usedFallback.push(key); return fallback }
    const p = Number(a.noul)
    if (noulConfidence(p) < 0.5) { usedFallback.push(key); return fallback }
    return p >= 0.5
  }
  // Split drivers (color/size): when Jev can't confidently pick a column,
  // "none" (show everything unsplit) is the safe visible default — a split
  // never hides data, so this never blocks.
  const softNoneChoice = (key) => {
    const a = answers?.[key]
    const conf = Number(a?.confidence ?? NaN)
    if (a?.choice && (a.choice === "none" || validRefs.has(a.choice)) && conf >= 0.5) return a.choice
    nonBlocking.push(key)
    return "none"
  }
  return { fieldChoice, choice, noul, softNoneChoice }
}

// One panel's spec. Suffix "" reads the un-suffixed (panel-1) keys,
// "_2" / "_3" the per-panel fan-out keys. Shared display flags are global.
// The row filter is shared across panels (one filter_column/filter_op pair
// for the whole dashboard); callers override fb.filter with it.
function panelSpec(m, suffix, fb, shared) {
  const view = m.choice(`view${suffix}`, fb.view, VIEWS)
  return {
    view,
    xField: view === "kpi" ? fb.xField : m.fieldChoice(`x_field${suffix}`, fb.xField),
    yField: m.fieldChoice(`y_field${suffix}`, fb.yField),
    colorField: m.softNoneChoice(`color_field${suffix}`),
    sizeField: m.softNoneChoice(`size_field${suffix}`),
    aggregation: m.choice(`aggregation${suffix}`, fb.aggregation, ["sum", "avg", "count"]),
    sortBy: m.choice(`sort_by${suffix}`, fb.sortBy, ["value_desc", "value_asc", "label_asc"]),
    ...shared,
    filter: fb.filter ?? null,
    title: fb.title,
  }
}

function sharedFlags(m, fb) {
  const include = {}
  for (let i = 0; i < (fb.schemaColumns || []).length; i++) {
    include[`col${i}`] = m.noul(`include_col${i}`, true)
  }
  return {
    showLegend: m.noul("show_legend", fb.showLegend),
    showTotals: m.noul("show_totals", fb.showTotals),
    horizontal: m.noul("horizontal", fb.horizontal),
    include,
  }
}

// Flags with safe visual defaults (include -> show the column, display
// flags -> off) and row filters (drop to unfiltered with a note): Jev being
// lukewarm about them never blocks a render — the spec carries the fallback
// and the UI notes it. Broad prompts like "table of all data" land include
// nouls near 0.7, straddling the confidence cliff, so gating on them breaks
// visualization. Anything else (view, bindings) still repeats the question.
export function isBlockingFallback(key) {
  if (typeof key === "string" && key.slice(0, 8) === "include_") return false
  if (key === "show_legend" || key === "show_totals" || key === "horizontal") return false
  if (key === "filter_column" || key === "filter_op" || key === "filter_negate") return false
  if (typeof key === "string" && key.slice(0, 13) === "filter_value_") return false
  return true
}

export function partitionFallbacks(usedFallback) {
  const blocking = []
  const nonBlocking = []
  for (const key of usedFallback || []) {
    if (isBlockingFallback(key)) blocking.push(key)
    else nonBlocking.push(key)
  }
  return { blocking, nonBlocking }
}

export function specFromAnswers(answers, schema, prompt, rows = null) {
  const fb = { ...constantSpec(schema, prompt), schemaColumns: schema?.columns || [], allRows: rows }
  const usedFallback = []
  const nonBlocking = []
  const m = makeMergers(answers, schema, usedFallback, nonBlocking)
  const mSoft = makeMergers(answers, schema, nonBlocking)
  const filter = sharedFilter(answers, fb, nonBlocking)
  return { spec: panelSpec(m, "", { ...fb, filter }, sharedFlags(mSoft, fb)), usedFallback, nonBlocking }
}

export const MAX_PANELS = 3
export const LAYOUTS = ["single", "stack", "side-by-side", "grid"]
export const PANEL_COUNT_WORDS = { one: 1, two: 2, three: 3 }

export function dashboardFromAnswers(answers, schema, prompt, rows = null) {
  const fb = constantSpec(schema, prompt)
  const usedFallback = []
  const nonBlocking = []
  const m = makeMergers(answers, schema, usedFallback, nonBlocking)
  const mSoft = makeMergers(answers, schema, nonBlocking)
  const countWord = m.choice("panel_count", "one", Object.keys(PANEL_COUNT_WORDS))
  const count = Math.min(MAX_PANELS, PANEL_COUNT_WORDS[countWord])
  const layout = m.choice("layout", "single", LAYOUTS)
  const fbBase = { schemaColumns: schema?.columns || [], allRows: rows }
  const filter = sharedFilter(answers, fbBase, nonBlocking)
  const fbWithCols = (panel) => ({ ...panel, ...fbBase, filter })
  const shared = sharedFlags(mSoft, { ...fb, schemaColumns: schema?.columns || [] })
  const panels = Array.from({ length: count }, (_, i) =>
    panelSpec(m, i === 0 ? "" : `_${i + 1}`, fbWithCols(fb), shared))
  return { dashboard: { layout: count < 2 ? "single" : layout, panels, title: prompt }, usedFallback, nonBlocking }
}

// Deterministic panel title — Jev can't generate text, so derive it.
export function panelTitle(panel, schema) {
  if (panel.view === "kpi") return "totals · kpi"
  const y = panel.yField === "count_rows" ? "count" : refToName(schema, panel.yField)
  const x = panel.xField === "none" ? "" : ` by ${refToName(schema, panel.xField)}`
  return `${y}${x} · ${panel.view}`
}

export function dashboardContainerStyle(layout) {
  if (layout === "side-by-side") return "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;"
  if (layout === "grid") return "display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;"
  return "display:flex;flex-direction:column;gap:10px;"
}

export function panelSectionHtml(panel, rows, schema, slot) {
  const kept = applyFilter(rows, schema, panel.filter)
  const caption = panel.filter
    ? `<p style="font-size:11px;color:#71717a;margin:-2px 0 6px;">Filter ${escapeHtml(filterLabel(panel.filter, schema))} · ${kept.length} of ${(rows || []).length} rows</p>`
    : ""
  let body
  if (panel.filter && !kept.length) {
    body = `<p style="font-size:12px;color:#a1a1aa;">No rows match ${escapeHtml(filterLabel(panel.filter, schema))}.</p>`
  } else if (CHART_VIEWS.includes(panel.view)) {
    body = `<div data-chart-slot="${slot}" style="position:relative;height:280px;"><canvas></canvas></div>` +
      totalsLine(kept, panel, schema)
  } else if (panel.view === "cards") {
    body = renderCardsHtml(kept, panel, schema)
  } else if (panel.view === "kpi") {
    body = renderKpiHtml(kept, panel, schema)
  } else {
    body = renderTableHtml(kept, { ...panel, view: "table" }, schema)
    panel.view = "table"
  }
  return `<section style="border:1px solid #e4e4e7;border-radius:12px;padding:10px;min-width:0;">` +
    `<h4 style="font-size:12px;font-weight:700;margin-bottom:6px;">${escapeHtml(panelTitle(panel, schema))}</h4>${caption}${body}</section>`
}

export function visibleColumns(schema, include) {
  const cols = (schema?.columns || []).map((c, i) => ({ ...c, ref: `col${i}` }))
  if (!include) return cols
  const kept = cols.filter((c) => include[c.ref] !== false)
  return kept.length ? kept : cols
}

// Group rows by xField and reduce yField — pure, feeds Chart.js directly.
export function aggregateCategory(rows, spec, schema) {
  const groups = new Map()
  for (const row of applyFilter(rows, schema, spec.filter)) {
    const xRaw = spec.xField === "none" ? "all" : cellOf(row, refToName(schema, spec.xField))
    const key = xRaw === null || xRaw === undefined || xRaw === "" ? "(blank)" : String(xRaw)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  let labels = [...groups.keys()]
  let values = labels.map((label) => {
    const items = groups.get(label)
    if (spec.yField === "count_rows" || spec.aggregation === "count") return items.length
    const nums = items.map((r) => coerceNumber(cellOf(r, refToName(schema, spec.yField)))).filter((n) => n !== null)
    if (!nums.length) return 0
    const sum = nums.reduce((a, b) => a + b, 0)
    return spec.aggregation === "avg" ? sum / nums.length : sum
  })
  const order = labels.map((label, i) => ({ label, value: values[i] }))
  if (spec.sortBy === "value_desc") order.sort((a, b) => b.value - a.value)
  else if (spec.sortBy === "value_asc") order.sort((a, b) => a.value - b.value)
  else order.sort((a, b) => String(a.label).localeCompare(String(b.label)))
  return { labels: order.map((o) => o.label), values: order.map((o) => round2(o.value)) }
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100
}

// Points for scatter/bubbles, grouped into one series per color value.
export function scatterSeries(rows, spec, schema) {
  const xName = refToName(schema, spec.xField)
  const yName = spec.yField === "count_rows" ? null : refToName(schema, spec.yField)
  const sName = spec.sizeField === "none" ? null : refToName(schema, spec.sizeField)
  const cName = spec.colorField === "none" ? null : refToName(schema, spec.colorField)
  const byColor = new Map()
  for (const row of applyFilter(rows, schema, spec.filter)) {
    const x = coerceNumber(cellOf(row, xName))
    const y = yName ? coerceNumber(cellOf(row, yName)) : coerceNumber(cellOf(row, xName))
    if (x === null || y === null) continue
    const color = cName ? String(cellOf(row, cName) ?? "all") : "all"
    const r = sName ? coerceNumber(cellOf(row, sName)) : null
    if (!byColor.has(color)) byColor.set(color, [])
    byColor.get(color).push({ x, y, r: r === null ? 5 : Math.max(3, Math.min(18, 3 + r / 8)) })
  }
  return [...byColor.entries()].map(([label, data], i) => ({
    label, data, backgroundColor: PALETTE[i % PALETTE.length],
  }))
}

// Pure Chart.js config builder — no Chart instance, jsdom-safe.
export function buildChartConfig(spec, rows, schema) {
  const agg = aggregateCategory(rows, spec, schema)
  const legend = { display: !!spec.showLegend }
  if (spec.view === "pie") {
    return {
      type: "pie",
      data: {
        labels: agg.labels,
        datasets: [{ data: agg.values, backgroundColor: agg.labels.map((_, i) => PALETTE[i % PALETTE.length]) }],
      },
      options: { responsive: true, plugins: { legend } },
    }
  }
  if (spec.view === "scatter" || spec.view === "bubbles") {
    const series = scatterSeries(rows, spec, schema).map((s) => ({
      ...s, ...(spec.view === "bubbles" ? {} : { pointRadius: 5 }),
    }))
    return {
      type: spec.view === "bubbles" ? "bubble" : "scatter",
      data: { datasets: series },
      options: { responsive: true, plugins: { legend } },
    }
  }
  const horizontal = !!spec.horizontal && spec.view === "bar"
  return {
    type: spec.view === "line" ? "line" : "bar",
    data: {
      labels: agg.labels,
      datasets: [{
        label: spec.yField === "count_rows" ? "count" : refToName(schema, spec.yField),
        data: agg.values,
        backgroundColor: spec.view === "line" ? "#38bdf8" : agg.labels.map((_, i) => PALETTE[i % PALETTE.length]),
        ...(spec.view === "line" ? { fill: false, tension: 0.25 } : {}),
      }],
    },
    options: { responsive: true, indexAxis: horizontal ? "y" : "x", plugins: { legend } },
  }
}

function fmt(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n ?? "")
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function renderTableHtml(rows, spec, schema) {
  const cols = visibleColumns(schema, spec.include)
  const kept = applyFilter(rows, schema, spec.filter)
  const sorted = [...kept]
  if (spec.yField !== "count_rows") {
    const yName = refToName(schema, spec.yField)
    sorted.sort((a, b) => {
      const av = coerceNumber(cellOf(a, yName)) ?? 0
      const bv = coerceNumber(cellOf(b, yName)) ?? 0
      return spec.sortBy === "value_asc" ? av - bv : bv - av
    })
  }
  const head = cols.map((c) => `<th style="text-align:left;padding:6px 8px;color:#71717a;font-weight:600;">${escapeHtml(c.name)}</th>`).join("")
  const body = sorted.map((row) =>
    `<tr style="border-top:1px solid #f4f4f5;">` +
    cols.map((c) => `<td style="padding:6px 8px;">${escapeHtml(cellOf(row, c.name))}</td>`).join("") + `</tr>`).join("")
  return `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    totalsLine(kept, spec, schema)
}

export function renderCardsHtml(rows, spec, schema) {
  const cols = visibleColumns(schema, spec.include)
  const kept = applyFilter(rows, schema, spec.filter)
  const titleCol = spec.xField !== "none" ? refToName(schema, spec.xField) : cols[0]?.name
  const cards = kept.map((row) => {
    const facts = cols.filter((c) => c.name !== titleCol).slice(0, 5).map((c) =>
      `<div style="font-size:11px;color:#52525b;"><span style="color:#a1a1aa;">${escapeHtml(c.name)}</span> ${escapeHtml(cellOf(row, c.name))}</div>`).join("")
    return `<div style="border:1px solid #e4e4e7;border-radius:12px;padding:10px;min-width:180px;flex:1;">` +
      `<h4 style="font-size:13px;font-weight:700;margin-bottom:4px;">${escapeHtml(cellOf(row, titleCol))}</h4>${facts}</div>`
  }).join("")
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cards}</div>` + totalsLine(kept, spec, schema)
}

// KPI renders the Jev-chosen yField metric (Jev already judged it numeric
// from the sample values) — one metric per panel, composed via multi-panel.
export function renderKpiHtml(rows, spec, schema) {
  const kept = applyFilter(rows, schema, spec.filter)
  if (spec.yField === "count_rows") {
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;">` +
      `<div style="border:1px solid #e4e4e7;border-radius:12px;padding:12px;min-width:140px;flex:1;text-align:center;">` +
      `<div style="font-size:11px;color:#71717a;">rows</div>` +
      `<div style="font-size:28px;font-weight:700;">${fmt(kept.length)}</div></div></div>`
  }
  const name = refToName(schema, spec.yField)
  const nums = kept.map((r) => coerceNumber(cellOf(r, name))).filter((n) => n !== null)
  const sum = nums.reduce((a, b) => a + b, 0)
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;">` +
    `<div style="border:1px solid #e4e4e7;border-radius:12px;padding:12px;min-width:140px;flex:1;text-align:center;">` +
    `<div style="font-size:11px;color:#71717a;">${escapeHtml(name)} · sum</div>` +
    `<div style="font-size:28px;font-weight:700;">${fmt(round2(sum))}</div>` +
    `<div style="font-size:11px;color:#71717a;">avg ${fmt(round2(nums.length ? sum / nums.length : 0))} · n=${kept.length}</div></div></div>`
}

function totalsLine(rows, spec, schema) {
  if (!spec.showTotals) return ""
  const agg = aggregateCategory(rows, spec, schema)
  const total = agg.values.reduce((a, b) => a + b, 0)
  return `<p style="font-size:11px;color:#71717a;margin-top:8px;">${agg.labels.length} groups · total ${fmt(round2(total))}</p>`
}

export function chartUnavailableHtml(reason) {
  return `<p style="font-size:12px;color:#a1a1aa;margin-bottom:6px;">Chart unavailable here (${escapeHtml(reason)}). Tabulated instead.</p>`
}

// Resolves the Chart constructor off the global scope. The UMD script sets
// window.Chart to the Chart class itself (pre-registered); an ESM-style
// namespace ({ Chart, registerables }) is accepted too.
export function resolveChartClass(root) {
  const cls = root?.Chart?.Chart ?? root?.Chart
  if (typeof cls !== "function") throw new Error("Chart.js script (chart.umd.js) failed to load")
  return cls
}

// --- Stimulus controller (dataset + voice + Jev call + Chart.js mount) --------
export default class extends Controller {
  static targets = [
    "dataset", "schemaLine", "canvas",
    "status", "inputShare",
  ]

  // The request prompt lives in the frozen bar — publish it on the voice
  // bus instead of showing it in this section.
  voice(detail) {
    try { window.dispatchEvent(new CustomEvent("syft:voice", { detail })) } catch { /* non-browser */ }
  }

  connect() {
    this.charts = []
    this.ChartClass = null
    // The key lives in the single top-level card — read fresh per render,
    // never cached here.
    this.lastAutoLoaded = null
    this.handleInputRowsChanged = () => this.autoLoadFromInput()
    this.handleTabShown = (event) => { if (event?.detail === "visualize") this.autoLoadFromInput() }
    // Global voice commands (Jev-routed): the request is the transcript
    // verbatim — carried, never parsed — rendered through the normal ask().
    // There is no typed prompt: voice is the only input.
    this.request = ""
    this.handleVoiceCommand = (event) => {
      const prompt = event?.detail?.prompt
      if (typeof prompt !== "string" || !prompt.trim()) return
      this.request = prompt
      this.voice({ prompt })
      this.ask()
    }
    window.addEventListener("syft:input-rows-changed", this.handleInputRowsChanged)
    window.addEventListener("syft:tab-shown", this.handleTabShown)
    window.addEventListener("syft:visualize-command", this.handleVoiceCommand)
    this.autoLoadFromInput()
  }

  disconnect() {
    try { window.removeEventListener("syft:input-rows-changed", this.handleInputRowsChanged) } catch { /* ignore */ }
    try { window.removeEventListener("syft:tab-shown", this.handleTabShown) } catch { /* ignore */ }
    try { window.removeEventListener("syft:visualize-command", this.handleVoiceCommand) } catch { /* ignore */ }
    this.destroyCharts()
  }

  destroyCharts() {
    for (const chart of this.charts || []) {
      try { chart.destroy() } catch { /* ignore */ }
    }
    this.charts = []
  }

  // --- dataset -----------------------------------------------------------------
  parseDataset() {
    return parseDatasetText(this.datasetTarget.value)
  }

  datasetInput() {
    const parsed = this.parseDataset()
    if (parsed.error) {
      this.schemaLineTarget.textContent = parsed.error
      return
    }
    const schema = inferSchema(parsed.rows)
    this.schemaLineTarget.textContent =
      `${parsed.rows.length} rows · ` + schema.columns.map((c) => c.name).join(", ")
  }

  // --- input auto-share -----------------------------------------------------------
  // Rows collected in the Input section flow here on their own: on every
  // save and on connect. Never clobbers text the user typed or pasted
  // themselves (see shouldAutoLoadDataset).
  readInputShare() {
    try {
      const rows = JSON.parse(localStorage.getItem("syft_input_rows") || "[]")
      const schema = JSON.parse(localStorage.getItem("syft_design_schema") || "[]")
      if (!Array.isArray(rows) || !rows.length) return { rows: [], fields: [] }
      return { rows, fields: Array.isArray(schema) ? schema : [] }
    } catch {
      return { rows: [], fields: [] }
    }
  }

  refreshInputShare() {
    if (!this.hasInputShareTarget) return
    const { rows } = this.readInputShare()
    this.inputShareTarget.textContent = rows.length
      ? `${rows.length} input row${rows.length === 1 ? "" : "s"} loaded from the Input section.`
      : "No input rows yet — they appear here automatically once filled in."
  }

  autoLoadFromInput() {
    const { rows, fields } = this.readInputShare()
    this.refreshInputShare()
    if (!rows.length) return
    const names = fields.map((f) => f?.name).filter((n) => typeof n === "string" && n)
    const nextJson = JSON.stringify(projectToSchema(rowsToDataset(rows), names), null, 1)
    if (!shouldAutoLoadDataset(this.datasetTarget.value, this.lastAutoLoaded, nextJson)) return
    this.datasetTarget.value = nextJson
    this.lastAutoLoaded = nextJson
    this.datasetInput()
    this.refreshInputShare()
  }

  // --- build (Jev only — no key or unsure answers repeat, never render) ---------
  async ask() {
    const prompt = String(this.request || "").trim()
    if (!prompt) { this.statusTarget.textContent = "Say how to render the data first."; return }
    const parsed = this.parseDataset()
    if (parsed.error) { this.statusTarget.textContent = parsed.error; return }
    const rows = parsed.rows
    this.statusTarget.textContent = "Asking Jev the schema-driven questions in parallel…"
    try {
      const key = localStorage.getItem("syft_jev_key") || ""
      const schema = inferSchema(rows)
      if (!key) {
        this.statusTarget.textContent = "Add your Jev key above first — every render is answered by Jev."
        return
      }
      const res = await fetch("/jev_studio", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
        body: JSON.stringify({ prompt, dataset: rows.slice(0, 100), api_key: key }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) {
        localStorage.removeItem("syft_jev_key_ok")
        this.statusTarget.textContent = "Key rejected — check it and try again."
        return
      }
      if (!res.ok || !data.answers) {
        this.statusTarget.textContent = `Jev error (HTTP ${res.status}) — try again.`
        return
      }
      const serverSchema = data.schema || schema
      const { dashboard, usedFallback, nonBlocking = [] } = dashboardFromAnswers(data.answers || {}, serverSchema, prompt, rows)
      const { blocking, nonBlocking: soft } = partitionFallbacks(usedFallback)
      const notes = [...soft, ...nonBlocking]
      if (blocking.length) {
        this.statusTarget.textContent = `Jev wasn't sure about ${blocking.slice(0, 4).join(", ")} — rephrase and say it again.`
        return
      }
      this.renderResult(dashboard, rows, serverSchema, prompt, {
        usedFallback: notes,
      })
    } catch {
      this.statusTarget.textContent = "Could not reach Jev — try again."
    }
  }

  renderResult(dashboard, rows, schema, prompt, meta) {
    this.destroyCharts()
    this.canvasTarget.innerHTML =
      `<div style="${dashboardContainerStyle(dashboard.layout)}">` +
      dashboard.panels.map((panel, i) => panelSectionHtml(panel, rows, schema, i)).join("") +
      `</div>`
    this.mountPanelCharts(dashboard, rows, schema)
    const n = dashboard.panels.length
    const defaultsNote = (meta.usedFallback || []).length
      ? ` Showed defaults for ${meta.usedFallback.slice(0, 4).join(", ")}.`
      : ""
    this.statusTarget.textContent = `Rendered “${prompt}” as ${n} panel${n === 1 ? "" : "s"} (${dashboard.layout}). All answers from Jev.` +
      (n === 1 && dashboard.panels[0].filter
        ? ` Filter ${filterLabel(dashboard.panels[0].filter, schema)} — ${applyFilter(rows, schema, dashboard.panels[0].filter).length} of ${(rows || []).length} rows.`
        : "") + defaultsNote
  }

  // Chart.js ships as a classic UMD script (see the <script> tag in the
  // studio view): single self-contained file, no ESM graph that can 404 on
  // a missing chunk. The UMD build pre-registers all components and sets
  // window.Chart to the Chart class itself.
  loadChartLib() {
    if (this.ChartClass) return this.ChartClass
    this.ChartClass = resolveChartClass(window)
    return this.ChartClass
  }

  mountPanelCharts(dashboard, rows, schema) {
    this.canvasTarget.querySelectorAll("[data-chart-slot]").forEach((slotEl) => {
      const panel = dashboard.panels[Number(slotEl.dataset.chartSlot)]
      if (!panel || !CHART_VIEWS.includes(panel.view)) return
      try {
        const Chart = this.loadChartLib()
        this.charts.push(new Chart(slotEl.querySelector("canvas"), buildChartConfig(panel, rows, schema)))
      } catch (e) {
        // No canvas/Chart available — the deterministic fallback is a table.
        // Surface the reason (previously swallowed) so it can be diagnosed.
        const reason = (e && e.message) || String(e)
        console.error("Chart.js failed to mount:", e)
        slotEl.outerHTML = chartUnavailableHtml(reason) +
          renderTableHtml(rows, { ...panel, view: "table" }, schema)
      }
    })
  }
}
