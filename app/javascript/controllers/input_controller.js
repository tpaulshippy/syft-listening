import { Controller } from "@hotwired/stimulus"

// Data input: asks the designed questions in schema order and fills rows.
// The user speaks every value verbatim; Jev only maps + validates:
// choice_single -> choice over enumerated options (hallucination-guarded),
// choice_multiple -> one noul per option, yes_no -> noul, open types ->
// validity noul (value is the transcript itself). One shared `control`
// choice per prompt (answer / repeat / skip / edit_previous / finish_row).
//
// Grouping: open types are always solo. The backend proposes the next
// contiguous pair of closed-type fields; Jev decides via plan_group.
// Groups never reorder the schema. Invalid/missing required answers block
// (no advance) until fixed or explicitly skipped.
//
// Rows persist in localStorage under INPUT_ROWS_KEY so Visualize can
// auto-share them. Pure helpers are module-level exports for Vitest.

export const SCHEMA_KEY = "syft_design_schema"
export const INPUT_ROWS_KEY = "syft_input_rows"
export const OPEN_TYPES = ["text", "number", "date", "time", "email"]
export const CLOSED_TYPES = ["yes_no", "choice_single", "choice_multiple"]
export const CONTROL_INTENTS = ["answer", "repeat", "skip", "edit_previous", "finish_row"]

export function loadSchema(store = null) {
  const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
  if (!s) return []
  try {
    const parsed = JSON.parse(s.getItem(SCHEMA_KEY) || "[]")
    return Array.isArray(parsed) ? parsed.filter((f) => f && typeof f.name === "string") : []
  } catch {
    return []
  }
}

export function loadRows(store = null) {
  const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
  if (!s) return []
  try {
    const parsed = JSON.parse(s.getItem(INPUT_ROWS_KEY) || "[]")
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveRows(rows, store = null) {
  const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
  s?.setItem(INPUT_ROWS_KEY, JSON.stringify(rows || []))
  // Visualize listens for this and auto-loads the new rows (same document).
  try { window.dispatchEvent(new CustomEvent("syft:input-rows-changed")) } catch { /* non-browser */ }
}

// Next candidate group: a contiguous pair of closed types, else solo.
// Order is always preserved — never skips or reorders fields.
export function proposeGroup(remaining) {
  const list = remaining || []
  if (list.length >= 2 && CLOSED_TYPES.includes(list[0].type) && CLOSED_TYPES.includes(list[1].type)) {
    return [list[0], list[1]]
  }
  return list.slice(0, 1)
}

export function promptFor(group) {
  if (!group?.length) return ""
  const parts = group.map((f) => {
    const opts = f.type.startsWith("choice_") && f.options?.length ? ` (${f.options.join(", ")})` : ""
    return `${f.name}${opts}`
  })
  return group.length === 1 ? `${parts[0]}?` : `${parts.join(" … ")}?`
}

function confidentChoice(answer, allowed) {
  const conf = Number(answer?.confidence ?? NaN)
  if (answer?.choice && allowed.includes(answer.choice) && conf >= 0.5) return answer.choice
  return null
}

function noulBool(answer) {
  if (answer == null || answer.noul == null) return null
  const p = Number(answer.noul)
  if (Math.abs(p - 0.5) * 2 < 0.5) return null
  return p >= 0.5
}

// Offline validity per type (fallback + block/retry reasons).
export function offlineCheck(field, value) {
  const t = String(value ?? "").trim()
  if (!t) return { ok: !field.required, reason: field.required ? "An answer is required." : "" }
  switch (field.type) {
    case "number":
      return /^-?\d+(\.\d+)?$/.test(t) ? { ok: true } : { ok: false, reason: "That didn't look like a number." }
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) ? { ok: true } : { ok: false, reason: "That didn't look like an email." }
    case "date":
      return /^\d{4}-\d{2}(-\d{2})?$/.test(t) ? { ok: true } : { ok: false, reason: "Use YYYY-MM-DD." }
    case "time":
      return /^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(t) ? { ok: true } : { ok: false, reason: "Use HH:MM." }
    case "yes_no": {
      const p = t.toLowerCase()
      if (/^(yes|yeah|yep|sure|true)\b/.test(p)) return { ok: true, value: "yes" }
      if (/^(no|nope|nah|false)\b/.test(p)) return { ok: true, value: "no" }
      return { ok: false, reason: "Say yes or no." }
    }
    case "choice_single": {
      const hit = (field.options || []).find((o) => o.toLowerCase() === t.toLowerCase())
      return hit ? { ok: true, value: hit } : { ok: false, reason: `Pick one of: ${(field.options || []).join(", ")}.` }
    }
    case "choice_multiple": {
      const parts = t.split(/[,;+]|\band\b/i).map((s) => s.trim()).filter(Boolean)
      const hits = parts.map((p) => (field.options || []).find((o) => o.toLowerCase() === p.toLowerCase())).filter(Boolean)
      return hits.length ? { ok: true, value: [...new Set(hits)] } : { ok: false, reason: `Pick from: ${(field.options || []).join(", ")}.` }
    }
    default:
      return { ok: true }
  }
}

export function controlFromAnswers(answers, transcript) {
  const hit = confidentChoice(answers?.control, CONTROL_INTENTS)
  if (hit) return { control: hit, usedFallback: [] }
  const p = String(transcript || "").toLowerCase().trim()
  if (/^(skip|next|don'?t answer)/.test(p)) return { control: "skip", usedFallback: ["control"] }
  if (/^(repeat|pardon|say again|what)/.test(p)) return { control: "repeat", usedFallback: ["control"] }
  if (/^(go back|back|previous|edit last)/.test(p)) return { control: "edit_previous", usedFallback: ["control"] }
  if (/^(finished|done|save|that'?s all)/.test(p) && p.split(/\s+/).length <= 3) {
    return { control: "finish_row", usedFallback: ["control"] }
  }
  return { control: "answer", usedFallback: ["control"] }
}

// Merges one prompt's Jev answers onto 1-2 fields. Values for open types
// are the transcript verbatim; closed types map via choice/noul with the
// hallucination guard (choice must name a real option, conf >= 0.5).
export function valuesFromAnswers(answers, group, transcript) {
  const values = {}
  const usedFallback = []
  group.forEach((field, i) => {
    const suffix = i === 0 ? "" : "_2"
    if (field.type === "choice_single") {
      const a = answers?.[`value${suffix}`]
      const conf = Number(a?.confidence ?? NaN)
      const ok = typeof a?.choice === "string" &&
        (field.options || []).some((o) => o === a.choice) && conf >= 0.5
      if (ok) values[field.id] = a.choice
      else {
        usedFallback.push(`value${suffix}`)
        values[field.id] = offlineCheck(field, transcript).value ?? null
      }
    } else if (field.type === "choice_multiple") {
      const picks = []
      for (const opt of field.options || []) {
        const hit = noulBool(answers?.[`pick${suffix}_${opt}`])
        if (hit === true) picks.push(opt)
        else if (hit === null) usedFallback.push(`pick${suffix}_${opt}`)
      }
      if (!answers || usedFallback.length === (field.options || []).length) {
        values[field.id] = offlineCheck(field, transcript).value ?? []
        if (!usedFallback.includes("choice_multiple")) usedFallback.push("choice_multiple")
      } else {
        values[field.id] = picks
      }
    } else if (field.type === "yes_no") {
      const hit = noulBool(answers?.[`value${suffix}`])
      if (hit !== null) values[field.id] = hit ? "yes" : "no"
      else {
        usedFallback.push(`value${suffix}`)
        values[field.id] = offlineCheck(field, transcript).value ?? null
      }
    } else {
      const valid = noulBool(answers?.[`valid${suffix}`])
      if (valid === null) usedFallback.push(`valid${suffix}`)
      values[field.id] = String(transcript || "").trim()
    }
  })
  return { values, usedFallback }
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

// Auto-share payload for Visualize: rows already keyed by field name, so
// the dataset is the row list itself (drops the internal _index if present).
export function rowsToDataset(rows) {
  return (rows || []).map((row) => {
    const out = {}
    for (const [k, v] of Object.entries(row || {})) {
      if (k === "_index") continue
      out[k] = v
    }
    return out
  })
}

export function rowTableHtml(schema, rows) {
  if (!rows?.length) return `<p style="font-size:12px;color:#a1a1aa;">No records yet.</p>`
  const head = schema.map((f) => `<th style="text-align:left;padding:6px 8px;color:#71717a;font-weight:600;">${escapeHtml(f.name)}</th>`).join("")
  const body = rows.map((row, i) =>
    `<tr style="border-top:1px solid #f4f4f5;"><td style="padding:6px 8px;color:#a1a1aa;">${i + 1}</td>` +
    schema.map((f) => `<td style="padding:6px 8px;">${escapeHtml(Array.isArray(row[f.name]) ? row[f.name].join(", ") : row[f.name] ?? "")}</td>`).join("") +
    `<td style="padding:6px 8px;"><button data-action="click->input#removeRow" data-index="${i}" style="font-size:11px;color:#dc2626;">Delete</button></td></tr>`).join("")
  return `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr><th style="padding:6px 8px;">#</th>${head}<th></th></tr></thead><tbody>${body}</tbody></table></div>`
}

// --- Stimulus controller: voice-only session -----------------------------------
// One Start button, one Done button. The system speaks each question in schema
// order, listens, and advances automatically from what the user says.
export default class extends Controller {
  static targets = ["question", "status", "progress",
    "rowsTable", "inspector", "voiceStatus", "apiKey", "stepHint",
    "startButton", "doneButton"]

  connect() {
    this.schema = loadSchema()
    this.rows = loadRows()
    this.draft = {}
    this.fieldIndex = 0
    this.group = []
    this.recognition = null
    this.active = false
    this.awaiting = false
    if (this.hasApiKeyTarget) {
      this.apiKeyTarget.value = localStorage.getItem("syft_jev_key") || ""
      this.apiKeyTarget.addEventListener("input", () => {
        localStorage.setItem("syft_jev_key", this.apiKeyTarget.value.trim())
      })
    }
    this.render()
    this.setQuestion("Tap Start, then speak — I'll ask each question in order.")
    this.setStatus("Idle. Tap Start to begin.")
    this.updateButtons()
  }

  disconnect() {
    this.stopSession()
  }

  stopSession() {
    this.active = false
    this.awaiting = false
    try { this.recognition?.abort?.() } catch { /* ignore */ }
    try { this.recognition?.stop() } catch { /* ignore */ }
    try { window.speechSynthesis?.cancel() } catch { /* ignore */ }
  }

  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      this.setStatus("Voice not supported here — try Chrome or Edge.")
      return
    }
    if (this.active) return
    this.schema = loadSchema()
    if (!this.schema.length) {
      this.setQuestion("Design fields first — then come back to fill records.")
      return
    }
    this.active = true
    this.draft = {}
    this.fieldIndex = 0
    this.updateButtons()
    this.nextGroup()
  }

  done() {
    if (!this.active) return
    // Save a non-empty draft as a record, then end the session.
    const row = {}
    for (const f of this.schema) {
      const v = this.draft[f.id]
      row[f.name] = Array.isArray(v) ? v : (v ?? "")
    }
    const empty = Object.values(row).every((v) => (Array.isArray(v) ? !v.length : !String(v).trim()))
    if (!empty) {
      this.rows.push(row)
      saveRows(this.rows)
      this.render()
    }
    this.stopSession()
    this.draft = {}
    this.fieldIndex = 0
    this.group = []
    this.setQuestion("Done.")
    this.setStatus(empty ? "Session ended — no answers to save." : `Session ended — saved record ${this.rows.length}.`)
    this.updateButtons()
  }

  updateButtons() {
    if (this.hasStartButtonTarget) this.startButtonTarget.disabled = this.active
    if (this.hasDoneButtonTarget) this.doneButtonTarget.disabled = !this.active
  }

  speak(text, onDone = null) {
    try {
      if (!window.speechSynthesis || !text) { onDone?.(); return }
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = "en-US"
      let finished = false
      const finish = () => { if (!finished) { finished = true; onDone?.() } }
      u.onend = finish
      u.onerror = finish
      window.speechSynthesis.speak(u)
      setTimeout(() => { if (this.active && this.awaiting) finish() }, 8000)
    } catch { onDone?.() }
  }

  sayThenListen(text) {
    if (this.hasQuestionTarget) this.questionTarget.textContent = text
    this.awaiting = true
    this.speak(text, () => { if (this.active && this.awaiting) this.listen() })
  }

  setQuestion(text) {
    if (this.hasQuestionTarget) this.questionTarget.textContent = text
  }

  setStatus(text) {
    if (this.hasStatusTarget) this.statusTarget.textContent = text
  }

  listen() {
    if (!this.active || !this.awaiting) return
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { this.setStatus("Voice not supported here — try Chrome or Edge."); return }
    try { this.recognition?.abort?.() } catch { /* ignore */ }
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
      if (this.hasVoiceStatusTarget) {
        this.voiceStatusTarget.textContent = (finalText + interim).trim()
          ? `Heard: “${(finalText + interim).trim()}”` : "Listening…"
      }
    }
    this.recognition.onerror = (event) => {
      if (!this.active) return
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.awaiting = false
        this.setStatus("Mic blocked — allow microphone access, then tap Start again.")
        this.stopSession()
        this.updateButtons()
      }
    }
    this.recognition.onend = () => {
      if (!this.active || !this.awaiting) return
      const heard = finalText.trim()
      if (heard) {
        this.awaiting = false
        this.handleAnswer(heard)
      } else {
        this.listen()
      }
    }
    try {
      this.recognition.start()
      if (this.hasVoiceStatusTarget) this.voiceStatusTarget.textContent = "Listening…"
    } catch {
      setTimeout(() => { if (this.active && this.awaiting) this.listen() }, 300)
    }
  }

  remaining() {
    return this.schema.slice(this.fieldIndex)
  }

  async nextGroup() {
    if (!this.active) return
    this.schema = loadSchema()
    if (!this.schema.length) {
      this.setQuestion("Design fields first — then come back to fill records.")
      if (this.hasProgressTarget) this.progressTarget.textContent = "0 fields"
      return
    }
    if (this.fieldIndex >= this.schema.length) return this.finishRow()
    const candidate = proposeGroup(this.remaining())
    let group = candidate.slice(0, 1)
    if (candidate.length === 2) {
      const together = await this.planGroup(candidate[0], candidate[1])
      if (!this.active) return
      if (together) group = candidate
    }
    this.group = group
    const q = promptFor(group)
    if (this.hasStepHintTarget) {
      this.stepHintTarget.textContent = group.length === 2
        ? `Answering ${group.map((f) => f.name).join(" + ")} together. Say “skip” to skip, “go back” to edit.`
        : `${group[0].required ? "Required. " : ""}Say “skip” to skip, “go back” to edit.`
    }
    if (this.hasProgressTarget) this.progressTarget.textContent = `Record ${this.rows.length + 1} · field ${this.fieldIndex + 1} of ${this.schema.length}`
    this.sayThenListen(q)
  }

  async planGroup(a, b) {
    const key = localStorage.getItem("syft_jev_key") || ""
    if (!key) return false // offline: solo prompts (safe — never splits free text)
    try {
      const res = await fetch("/jev_input", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
        body: JSON.stringify({ step: "plan_group", fields: [a, b].map((f) => ({ name: f.name, type: f.type, required: f.required, options: f.options })), api_key: key }),
      })
      const data = await res.json().catch(() => ({}))
      const p = Number(data.answers?.ask_together?.noul ?? NaN)
      if (!res.ok || Number.isNaN(p)) return false
      if (Math.abs(p - 0.5) * 2 < 0.5) return false
      this.logInspector(`ask_together(${a.name}+${b.name}) = ${p >= 0.5}`)
      return p >= 0.5
    } catch {
      return false
    }
  }

  async handleAnswer(text) {
    if (!this.active) return
    if (!this.schema.length) { this.setStatus("Design fields first."); return }
    if (!this.group.length) { this.setStatus("Nothing to answer."); return }
    this.setStatus("Checking with Jev…")
    const key = localStorage.getItem("syft_jev_key") || ""
    let answers = {}
    let fbNote = "no-key"
    if (key) {
      try {
        const res = await fetch("/jev_input", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({
            step: "answer", transcript: text,
            fields: this.group.map((f) => ({ name: f.name, type: f.type, required: f.required, options: f.options })),
            api_key: key,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.answers) { answers = data.answers; fbNote = "" }
      } catch { /* offline fallback below */ }
    }
    const { control, usedFallback: cfb } = controlFromAnswers(answers, text)
    const { values, usedFallback: vfb } = valuesFromAnswers(answers, this.group, text)
    this.logInspector(`control=${control} values=${JSON.stringify(values)}${[...cfb, ...vfb].length || fbNote ? ` · fallback(${[...cfb, ...vfb].join(",")}${fbNote ? `,${fbNote}` : ""})` : ""}`)
    if (!this.active) return

    if (control === "repeat") { this.sayThenListen(promptFor(this.group)); return }
    if (control === "skip") { this.advance(values, true); return }
    if (control === "edit_previous") { this.goBack(); return }
    if (control === "finish_row") {
      if (key) { // confirm the unfinished tail verbatim only if it validates
        const tail = this.validateGroup(this.group, values)
        if (!tail.ok) {
          this.setStatus(tail.reason)
          this.sayThenListen(`${tail.reason} ${promptFor(this.group)}`)
          return
        }
        Object.assign(this.draft, values)
      }
      return this.finishRow()
    }
    // control === answer: validate, block + retry on failure
    const check = this.validateGroup(this.group, values)
    if (!check.ok) {
      this.setStatus(check.reason)
      this.sayThenListen(`${check.reason} ${promptFor(this.group)}`)
      return
    }
    this.advance(values, false)
  }

  validateGroup(group, values) {
    for (const field of group) {
      const raw = values[field.id]
      const str = Array.isArray(raw) ? raw.join(", ") : String(raw ?? "").trim()
      if (!str && field.required) return { ok: false, reason: `“${field.name}” is required.` }
      if (!str) continue
      const check = offlineCheck(field, Array.isArray(raw) ? raw.join(", ") : raw)
      // choice/yes_no merges already map to canonical values; re-check guards Jev slips
      if (!check.ok) return { ok: false, reason: check.reason }
    }
    return { ok: true }
  }

  advance(values, skipped) {
    if (!this.active) return
    if (!skipped) Object.assign(this.draft, values)
    this.fieldIndex += this.group.length
    if (this.fieldIndex >= this.schema.length) this.finishRow()
    else { this.setStatus(skipped ? "Skipped." : "Saved."); this.nextGroup() }
  }

  goBack() {
    if (!this.group.length) return
    this.fieldIndex = Math.max(0, this.fieldIndex - this.group.length)
    // drop draft keys for the rewound group
    for (const f of this.group) delete this.draft[f.id]
    this.setStatus("Went back one question.")
    this.nextGroup()
  }

  finishRow() {
    const row = {}
    for (const f of this.schema) {
      const v = this.draft[f.id]
      row[f.name] = Array.isArray(v) ? v : (v ?? "")
    }
    const empty = Object.values(row).every((v) => (Array.isArray(v) ? !v.length : !String(v).trim()))
    if (!empty) {
      this.rows.push(row)
      saveRows(this.rows)
    }
    this.draft = {}
    this.fieldIndex = 0
    this.render()
    if (!this.active) return
    this.setStatus(empty ? "Record discarded (empty)." : `Saved record ${this.rows.length}.`)
    this.nextGroup()
  }

  removeRow(event) {
    const i = Number(event.currentTarget.dataset.index)
    this.rows.splice(i, 1)
    saveRows(this.rows)
    this.render()
  }

  clearRows() {
    this.rows = []
    saveRows(this.rows)
    this.render()
  }

  render() {
    if (this.hasRowsTableTarget) this.rowsTableTarget.innerHTML = rowTableHtml(this.schema, this.rows)
  }

  logInspector(line) {
    if (!this.hasInspectorTarget) return
    const div = document.createElement("div")
    div.textContent = line
    this.inspectorTarget.prepend(div)
  }
}
