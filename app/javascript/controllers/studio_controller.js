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

// Dataset input: a JSON array of objects, or CSV with a header row.
// Detects by first non-whitespace character ("[" -> JSON, else CSV).
export function parseDatasetText(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return { error: "Paste a JSON array or CSV table, or pick a sample." }
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed) || !parsed.length || !parsed.every((r) => r && typeof r === "object")) {
        return { error: "Dataset must be a non-empty array of objects." }
      }
      return { rows: parsed }
    } catch {
      return { error: "Dataset is not valid JSON." }
    }
  }
  return parseCsv(text)
}

// Minimal RFC-4180 reader: quoted fields, "" escapes, CRLF/newlines in quotes.
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ""
  let quoted = false
  let i = 0
  const pushField = () => { row.push(field); field = "" }
  const pushRow = () => { rows.push(row); row = [] }
  while (i < text.length) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2 }
        else { quoted = false; i += 1 }
      } else { field += c; i += 1 }
    } else if (c === '"') {
      quoted = true; i += 1
    } else if (c === ",") {
      pushField(); i += 1
    } else if (c === "\n" || c === "\r") {
      pushField(); pushRow()
      i += (c === "\r" && text[i + 1] === "\n") ? 2 : 1
    } else {
      field += c; i += 1
    }
  }
  pushField(); pushRow()
  const nonEmpty = rows.filter((r) => r.some((v) => String(v).trim() !== ""))
  if (!nonEmpty.length) return { error: "CSV is empty." }
  const headers = nonEmpty[0].map((h) => String(h).trim())
  if (headers.some((h) => h === "")) return { error: "CSV header row has a blank column name." }
  if (new Set(headers).size !== headers.length) return { error: "CSV header row has duplicate column names." }
  const data = nonEmpty.slice(1)
  if (!data.length) return { error: "CSV has a header but no data rows." }
  return {
    rows: data.map((r) => Object.fromEntries(headers.map((h, j) => [h, (r[j] ?? "").trim()]))),
  }
}

export function escapeHtml(s) {
  // No regex anywhere in this app: plain string replacements only.
  return String(s ?? "").split("&").join("&amp;").split("<").join("&lt;")
    .split(">").join("&gt;").split('"').join("&quot;").split("'").join("&#39;")
}

export function slugify(name, taken = {}) {
  // Char loop: lowercase alphanumerics, runs of anything else become one "_".
  const lower = String(name ?? "").toLowerCase()
  let base = ""
  let lastWasGap = true
  for (const ch of lower) {
    if (ch >= "a" && ch <= "z" || ch >= "0" && ch <= "9") { base += ch; lastWasGap = false }
    else if (!lastWasGap) { base += "_"; lastWasGap = true }
  }
  if (!base) base = "col"
  if (base.endsWith("_")) base = base.slice(0, -1)
  let slug = base
  let i = 2
  while (taken[slug]) { slug = `${base}_${i}`; i += 1 }
  taken[slug] = true
  return slug
}

function isDigit(ch) {
  return ch >= "0" && ch <= "9"
}

function isDecimalString(t) {
  let s = t
  if (s.startsWith("-")) s = s.slice(1)
  if (!s) return false
  const parts = s.split(".")
  if (parts.length > 2) return false
  return parts.every((part) => part.length > 0 && [...part].every(isDigit))
}

export function isNumericValue(v) {
  if (typeof v === "number" && Number.isFinite(v)) return true
  return typeof v === "string" && isDecimalString(v.trim())
}

function isDateParts(parts, lens) {
  return parts.length === lens.length &&
    parts.every((part, i) => part.length === lens[i] && [...part].every(isDigit))
}

export function isTemporalValue(v) {
  if (typeof v !== "string") return false
  const parts = v.trim().split("-")
  return isDateParts(parts, [4, 2]) || isDateParts(parts, [4, 2, 2])
}

export function columnType(values) {
  const present = (values || []).filter((v) => v !== null && v !== undefined && v !== "")
  if (!present.length) return "categorical"
  if (present.every(isNumericValue)) return "numeric"
  if (present.every(isTemporalValue)) return "temporal"
  if (present.some((v) => String(v).length > 60)) return "text"
  return "categorical"
}

export function cellOf(row, name) {
  if (row == null) return undefined
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name]
  return undefined
}

export function coerceNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string" && v.trim() !== "" && isNumericValue(v)) return Number(v)
  return null
}

// Client mirror of StudioController#infer_schema (schema preview + fallback).
export function inferSchema(rows) {
  const names = []
  for (const row of rows || []) {
    for (const k of Object.keys(row || {})) if (!names.includes(k)) names.push(k)
  }
  const taken = {}
  const columns = names.slice(0, 60).map((name) => ({
    name,
    slug: slugify(name, taken),
    type: columnType((rows || []).map((r) => cellOf(r, name))),
  }))
  return { columns, row_count: (rows || []).length }
}

export function noulConfidence(p) {
  return Math.abs(Number(p) - 0.5) * 2
}

function colsByType(schema, types) {
  return (schema?.columns || []).filter((c) => types.includes(c.type))
}

function findColumn(schema, slug) {
  return (schema?.columns || []).find((c) => c.slug === slug)
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
  const name = findColumn(schema, filter.column)?.name ?? filter.column
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
  const name = findColumn(schema, filter.column)?.name ?? filter.column
  const value = filter.value
  const negate = !!filter.negate
  const op = filter.op || "equals"
  if (op === "contains") return negate ? `${name} doesn't contain “${value}”` : `${name} contains “${value}”`
  if (op === "starts_with") return negate ? `${name} doesn't start with “${value}”` : `${name} starts with “${value}”`
  if (op === "ends_with") return negate ? `${name} doesn't end with “${value}”` : `${name} ends with “${value}”`
  return negate ? `${name} ≠ ${value}` : `${name} = ${value}`
}

// Shared (whole-dashboard) filter from Jev answers. Column and op use the
// standard mergers; the value must be a real cell in that column (guards
// against a hallucinated choice) — otherwise no filter, recorded fallback.
function sharedFilter(m, fb, answers, usedFallback) {
  const column = m.fieldChoice("filter_column", "none")
  if (column === "none" || column === "count_rows") return null
  const op = m.choice("filter_op", "equals", FILTER_OPS)
  const negate = m.noul("filter_negate", false)
  const key = `filter_value_${column}`
  const a = answers?.[key]
  const conf = Number(a?.confidence ?? NaN)
  const value = typeof a?.choice === "string" ? a.choice.trim() : ""
  const colName = (fb.schemaColumns || []).find((c) => c.slug === column)?.name ?? column
  const want = value.toLowerCase()
  const test = filterTest(op, want)
  const ok = value !== "" && conf >= 0.5 && (fb.allRows || []).some((r) => {
    const v = cellOf(r, colName)
    return v !== null && v !== undefined && test(String(v).trim().toLowerCase())
  })
  if (!ok) { usedFallback.push(key); return null }
  return { column, op, value, negate }
}

// Schema-derived starting spec: fixed safe constants, never prompt words.
// Jev fills every slot; anything it leaves unsure repeats the question.
export function constantSpec(schema, prompt) {
  const cols = schema?.columns || []
  const nonNumeric = cols.find((c) => c.type !== "numeric")
  return {
    view: "table",
    xField: nonNumeric?.slug || cols[0]?.slug || "none",
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

// Merge Jev answers over the constant spec; slugs validated vs schema.
function makeMergers(answers, schema, usedFallback) {
  const validSlugs = new Set((schema?.columns || []).map((c) => c.slug))
  const fieldChoice = (key, fallback) => {
    const a = answers?.[key]
    const conf = Number(a?.confidence ?? NaN)
    if (a?.choice && (a.choice === "none" || a.choice === "count_rows" || validSlugs.has(a.choice)) && conf >= 0.5) {
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
  return { fieldChoice, choice, noul }
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
    colorField: m.fieldChoice(`color_field${suffix}`, fb.colorField),
    sizeField: m.fieldChoice(`size_field${suffix}`, fb.sizeField),
    aggregation: m.choice(`aggregation${suffix}`, fb.aggregation, ["sum", "avg", "count"]),
    sortBy: m.choice(`sort_by${suffix}`, fb.sortBy, ["value_desc", "value_asc", "label_asc"]),
    ...shared,
    filter: fb.filter ?? null,
    title: fb.title,
  }
}

function sharedFlags(m, fb) {
  const include = {}
  for (const col of fb.schemaColumns || []) {
    include[col.slug] = m.noul(`include_${col.slug}`, true)
  }
  return {
    showLegend: m.noul("show_legend", fb.showLegend),
    showTotals: m.noul("show_totals", fb.showTotals),
    horizontal: m.noul("horizontal", fb.horizontal),
    include,
  }
}

export function specFromAnswers(answers, schema, prompt, rows = null) {
  const fb = { ...constantSpec(schema, prompt), schemaColumns: schema?.columns || [], allRows: rows }
  const usedFallback = []
  const m = makeMergers(answers, schema, usedFallback)
  const filter = sharedFilter(m, fb, answers, usedFallback)
  return { spec: panelSpec(m, "", { ...fb, filter }, sharedFlags(m, fb)), usedFallback }
}

export const MAX_PANELS = 3
export const LAYOUTS = ["single", "stack", "side-by-side", "grid"]
export const PANEL_COUNT_WORDS = { one: 1, two: 2, three: 3 }

export function dashboardFromAnswers(answers, schema, prompt, rows = null) {
  const fb = constantSpec(schema, prompt)
  const usedFallback = []
  const m = makeMergers(answers, schema, usedFallback)
  const countWord = m.choice("panel_count", "one", Object.keys(PANEL_COUNT_WORDS))
  const count = Math.min(MAX_PANELS, PANEL_COUNT_WORDS[countWord])
  const layout = m.choice("layout", "single", LAYOUTS)
  const fbBase = { schemaColumns: schema?.columns || [], allRows: rows }
  const filter = sharedFilter(m, fbBase, answers, usedFallback)
  const fbWithCols = (panel) => ({ ...panel, ...fbBase, filter })
  const shared = sharedFlags(m, { ...fb, schemaColumns: schema?.columns || [] })
  const panels = Array.from({ length: count }, (_, i) =>
    panelSpec(m, i === 0 ? "" : `_${i + 1}`, fbWithCols(fb), shared))
  return { dashboard: { layout: count < 2 ? "single" : layout, panels, title: prompt }, usedFallback }
}

// Deterministic panel title — Jev can't generate text, so derive it.
export function panelTitle(panel, schema) {
  if (panel.view === "kpi") return "totals · kpi"
  const y = panel.yField === "count_rows" ? "count" : colName(schema, panel.yField)
  const x = panel.xField === "none" ? "" : ` by ${colName(schema, panel.xField)}`
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

function colName(schema, slug) {
  return findColumn(schema, slug)?.name ?? slug
}

export function visibleColumns(schema, include) {
  const cols = schema?.columns || []
  if (!include) return cols
  const kept = cols.filter((c) => include[c.slug] !== false)
  return kept.length ? kept : cols
}

// Group rows by xField and reduce yField — pure, feeds Chart.js directly.
export function aggregateCategory(rows, spec, schema) {
  const groups = new Map()
  for (const row of applyFilter(rows, schema, spec.filter)) {
    const xRaw = spec.xField === "none" ? "all" : cellOf(row, colName(schema, spec.xField))
    const key = xRaw === null || xRaw === undefined || xRaw === "" ? "(blank)" : String(xRaw)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  let labels = [...groups.keys()]
  let values = labels.map((label) => {
    const items = groups.get(label)
    if (spec.yField === "count_rows" || spec.aggregation === "count") return items.length
    const nums = items.map((r) => coerceNumber(cellOf(r, colName(schema, spec.yField)))).filter((n) => n !== null)
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
  const xName = colName(schema, spec.xField)
  const yName = spec.yField === "count_rows" ? null : colName(schema, spec.yField)
  const sName = spec.sizeField === "none" ? null : colName(schema, spec.sizeField)
  const cName = spec.colorField === "none" ? null : colName(schema, spec.colorField)
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
        label: spec.yField === "count_rows" ? "count" : colName(schema, spec.yField),
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
    const yName = colName(schema, spec.yField)
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
  const titleCol = (spec.xField !== "none" && findColumn(schema, spec.xField)) ? colName(schema, spec.xField) : cols[0]?.name
  const cards = kept.map((row) => {
    const facts = cols.filter((c) => c.name !== titleCol).slice(0, 5).map((c) =>
      `<div style="font-size:11px;color:#52525b;"><span style="color:#a1a1aa;">${escapeHtml(c.name)}</span> ${escapeHtml(cellOf(row, c.name))}</div>`).join("")
    return `<div style="border:1px solid #e4e4e7;border-radius:12px;padding:10px;min-width:180px;flex:1;">` +
      `<h4 style="font-size:13px;font-weight:700;margin-bottom:4px;">${escapeHtml(cellOf(row, titleCol))}</h4>${facts}</div>`
  }).join("")
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cards}</div>` + totalsLine(kept, spec, schema)
}

export function renderKpiHtml(rows, spec, schema) {
  const numeric = colsByType(schema, ["numeric"])
  const kept = applyFilter(rows, schema, spec.filter)
  const kpis = numeric.slice(0, 4).map((c) => {
    const nums = kept.map((r) => coerceNumber(cellOf(r, c.name))).filter((n) => n !== null)
    const sum = nums.reduce((a, b) => a + b, 0)
    return `<div style="border:1px solid #e4e4e7;border-radius:12px;padding:12px;min-width:140px;flex:1;text-align:center;">` +
      `<div style="font-size:11px;color:#71717a;">${escapeHtml(c.name)} · sum</div>` +
      `<div style="font-size:28px;font-weight:700;">${fmt(round2(sum))}</div>` +
      `<div style="font-size:11px;color:#71717a;">avg ${fmt(round2(nums.length ? sum / nums.length : 0))} · n=${kept.length}</div></div>`
  }).join("")
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;">${kpis || "<p>No numeric columns.</p>"}</div>`
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
    "dataset", "schemaLine", "prompt", "micButton", "askButton", "canvas",
    "latency", "questionCount", "inspector", "status", "voiceStatus",
    "supportWarning", "headline", "apiKey", "keyStatus", "testButton", "inputShare",
  ]

  connect() {
    this.recognition = null
    this.listening = false
    this.charts = []
    this.ChartClass = null
    this.apiKeyTarget.value = localStorage.getItem("syft_jev_key") || ""
    this.apiKeyTarget.addEventListener("input", () => {
      localStorage.setItem("syft_jev_key", this.apiKeyTarget.value.trim())
      this.updateKeyStatus()
    })
    this.apiKeyTarget.addEventListener("paste", () => {
      setTimeout(() => {
        localStorage.setItem("syft_jev_key", this.apiKeyTarget.value.trim())
        this.testKey()
      }, 0)
    })
    this.updateKeyStatus()
    this.lastAutoLoaded = null
    this.handleInputRowsChanged = () => this.autoLoadFromInput()
    this.handleTabShown = (event) => { if (event?.detail === "visualize") this.autoLoadFromInput() }
    window.addEventListener("syft:input-rows-changed", this.handleInputRowsChanged)
    window.addEventListener("syft:tab-shown", this.handleTabShown)
    this.refreshInputShare()
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) this.supportWarningTarget.classList.remove("hidden")
  }

  disconnect() {
    try { this.recognition?.stop() } catch { /* ignore */ }
    try { window.removeEventListener("syft:input-rows-changed", this.handleInputRowsChanged) } catch { /* ignore */ }
    try { window.removeEventListener("syft:tab-shown", this.handleTabShown) } catch { /* ignore */ }
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
      `${parsed.rows.length} rows · ` + schema.columns.map((c) => `${c.name}:${c.type}`).join(", ")
  }

  // --- input auto-share -----------------------------------------------------------
  // Rows collected in the Input tab flow here on their own: on every save
  // and whenever this tab is shown. Never clobbers text the user typed or
  // pasted themselves (see shouldAutoLoadDataset).
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
      ? `${rows.length} input record${rows.length === 1 ? "" : "s"} loaded from the Input tab.`
      : "No input records yet — they appear here automatically once filled in."
  }

  autoLoadFromInput() {
    const { rows } = this.readInputShare()
    this.refreshInputShare()
    if (!rows.length) return
    const nextJson = JSON.stringify(rowsToDataset(rows), null, 1)
    if (!shouldAutoLoadDataset(this.datasetTarget.value, this.lastAutoLoaded, nextJson)) return
    this.datasetTarget.value = nextJson
    this.lastAutoLoaded = nextJson
    this.datasetInput()
    this.refreshInputShare()
  }

  // --- key (shared) ---------------------------------------------------------------
  updateKeyStatus() {
    const key = this.apiKeyTarget.value.trim()
    const ok = key.length > 0 && localStorage.getItem("syft_jev_key_ok") === key
    this.keyStatusTarget.textContent = ok ? "✓ Key works — Jev will answer the schema-driven question set."
      : key ? "Tap Test to verify this key."
      : "Add your key — every render is answered by Jev."
    this.keyStatusTarget.className = "mt-1 text-xs " + (ok ? "text-emerald-600" : "text-zinc-500 dark:text-zinc-400")
  }

  toggleKeyVisibility() {
    this.apiKeyTarget.type = this.apiKeyTarget.type === "password" ? "text" : "password"
  }

  async testKey() {
    const key = this.apiKeyTarget.value.trim()
    if (!key) { this.keyStatusTarget.textContent = "Paste your key first."; return }
    this.keyStatusTarget.textContent = "Testing…"
    try {
      const res = await fetch("/jev_analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
        body: JSON.stringify({ text: "The Eiffel Tower is in Paris.", metrics: ["specificity"], api_key: key }),
      })
      if (res.ok) {
        localStorage.setItem("syft_jev_key_ok", key)
        this.updateKeyStatus()
      } else {
        localStorage.removeItem("syft_jev_key_ok")
        this.keyStatusTarget.textContent = "✗ Key rejected — check it and try again."
        this.keyStatusTarget.className = "text-xs mt-1 text-red-600"
      }
    } catch {
      this.keyStatusTarget.textContent = "✗ Could not reach the server."
      this.keyStatusTarget.className = "text-xs mt-1 text-red-600"
    }
  }

  // --- voice -----------------------------------------------------------------------
  toggleVoice() {
    if (this.listening) { try { this.recognition?.stop() } catch { /* ignore */ } return }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      this.voiceStatusTarget.textContent = "Voice not supported here — type your request instead."
      return
    }
    this.recognition = new SR()
    this.recognition.continuous = false
    this.recognition.interimResults = true
    this.recognition.lang = "en-US"
    let finalText = ""
    this.recognition.onresult = (event) => {
      let interim = ""
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript + " "
        else interim += event.results[i][0].transcript
      }
      this.promptTarget.value = (finalText + interim).trim()
      this.voiceStatusTarget.textContent = interim ? `Hearing: “${interim}…”` : `Heard: “${finalText.trim()}”`
    }
    this.recognition.onerror = (event) => {
      this.listening = false
      this.voiceStatusTarget.textContent = `Mic error: ${event.error} — you can type instead.`
    }
    this.recognition.onend = () => {
      this.listening = false
      this.micButtonTarget.style.background = ""
      const heard = this.promptTarget.value.trim()
      if (heard) {
        this.voiceStatusTarget.textContent = `Heard: “${heard}” — building…`
        this.ask()
      } else {
        this.voiceStatusTarget.textContent = "Didn't catch that — try again or type."
      }
    }
    try {
      this.recognition.start()
      this.listening = true
      this.micButtonTarget.style.background = "#dc2626"
      this.voiceStatusTarget.textContent = "Listening… say how to render it (“Bar chart of revenue by genre”)."
    } catch (e) {
      this.voiceStatusTarget.textContent = `Could not start mic: ${e.message}`
    }
  }

  promptKeydown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      this.ask()
    }
  }

  promptInput() {
    this.headlineTarget.textContent = this.promptTarget.value.trim() || "Paste any dataset, then speak or type how to render it."
  }

  usePrompt(event) {
    this.promptTarget.value = event.currentTarget.dataset.prompt
    this.promptInput()
    this.ask()
  }

  // --- build (Jev only — no key or unsure answers repeat, never render) ---------
  async ask() {
    const prompt = this.promptTarget.value.trim()
    if (!prompt) { this.statusTarget.textContent = "Say or type how to render the data first."; return }
    const parsed = this.parseDataset()
    if (parsed.error) { this.statusTarget.textContent = parsed.error; return }
    const rows = parsed.rows
    const t0 = performance.now()
    this.headlineTarget.textContent = prompt
    this.askButtonTarget.disabled = true
    this.statusTarget.textContent = "Asking Jev the schema-driven questions in parallel…"
    try {
      const key = this.apiKeyTarget.value.trim()
      const schema = inferSchema(rows)
      if (!key) {
        this.statusTarget.textContent = "Add your Jev key first — every render is answered by Jev."
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
        this.updateKeyStatus()
        this.statusTarget.textContent = "Key rejected — check it and try again."
        return
      }
      if (!res.ok || !data.answers) {
        this.statusTarget.textContent = `Jev error (HTTP ${res.status}) — try again.`
        return
      }
      const serverSchema = data.schema || schema
      const { dashboard, usedFallback } = dashboardFromAnswers(data.answers || {}, serverSchema, prompt, rows)
      if (usedFallback.length) {
        this.statusTarget.textContent = `Jev wasn't sure about ${usedFallback.slice(0, 4).join(", ")} — rephrase and Ask again.`
        return
      }
      this.renderResult(dashboard, rows, serverSchema, prompt, t0, {
        count: data.question_count ?? Object.keys(data.answers).length,
        model: data.model || "jev-latest",
        answers: data.answers,
        usedFallback,
      })
    } catch {
      this.statusTarget.textContent = "Could not reach Jev — try again."
    } finally {
      this.askButtonTarget.disabled = false
    }
  }

  renderResult(dashboard, rows, schema, prompt, t0, meta) {
    const ms = Math.round(performance.now() - t0)
    this.destroyCharts()
    this.canvasTarget.innerHTML =
      `<div style="${dashboardContainerStyle(dashboard.layout)}">` +
      dashboard.panels.map((panel, i) => panelSectionHtml(panel, rows, schema, i)).join("") +
      `</div>`
    this.mountPanelCharts(dashboard, rows, schema)
    this.latencyTarget.textContent = `${ms.toLocaleString()} ms`
    this.questionCountTarget.textContent =
      `${meta.count} multiple-choice answers in parallel · ${meta.model}`
    const rows_out = Object.entries(meta.answers || {}).slice(0, 80).map(([k, a]) => {
      const val = a?.choice ?? (a?.noul != null ? (Number(a.noul) >= 0.5 ? "yes" : "no") : "?")
      const c = a?.confidence ?? (a?.noul != null ? noulConfidence(a.noul) : null)
      return `<div>${escapeHtml(k)} = <strong>${escapeHtml(val)}</strong> <span style="color:#a1a1aa;">${c == null ? "" : `conf ${Number(c).toFixed(2)}`}</span></div>`
    })
    this.inspectorTarget.innerHTML = rows_out.join("")
    const n = dashboard.panels.length
    this.statusTarget.textContent = `Rendered “${prompt}” as ${n} panel${n === 1 ? "" : "s"} (${dashboard.layout}). All answers from Jev.` +
      (n === 1 && dashboard.panels[0].filter
        ? ` Filter ${filterLabel(dashboard.panels[0].filter, schema)} — ${applyFilter(rows, schema, dashboard.panels[0].filter).length} of ${(rows || []).length} rows.`
        : "")
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
