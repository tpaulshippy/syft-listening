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
    const opts = ["choice_single", "choice_multiple"].includes(f.type) && f.options?.length ? ` (${f.options.join(", ")})` : ""
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

// No word matchers here: understanding belongs to Jev. The no-key path is
// the Start button refusing; every merger below is Jev-or-unsure.
// Dates are parsed by Jev into month/day/year choices (composed to ISO
// below); numbers are Jev-validated then coerced with Number(). Both use
// platform conversion only — our code inspects no characters.

export function controlFromAnswers(answers) {
  const hit = confidentChoice(answers?.control, CONTROL_INTENTS)
  if (hit) return { control: hit, usedFallback: [] }
  return { control: null, usedFallback: ["control"] }
}

// A confident value with an unsure meta-intent is still an answer: Jev
// understood the words (it parsed them into values), it only hedged on
// whether the speaker meant answer/skip/done. Defaulting to answer is the
// conservative choice — ending the row (finish_row) stays explicit, never
// assumed. A confident skip/repeat/done is always honored; only a null
// control with zero value fallbacks is assumed.
export function effectiveControl(control, controlFallback, valueFallback) {
  if (control) return { control, usedFallback: controlFallback, assumed: false }
  if (valueFallback.length === 0) return { control: "answer", usedFallback: [], assumed: true }
  return { control: null, usedFallback: controlFallback, assumed: false }
}

export const ROW_INTENTS = ["edit", "delete"]

// Voice row menu: Jev decides edit vs delete from the `row_intent` choice.
export function rowIntentFromAnswers(answers) {
  const hit = confidentChoice(answers?.intent, ROW_INTENTS)
  if (hit) return { intent: hit, usedFallback: [] }
  return { intent: null, usedFallback: ["intent"] }
}

export const MONTHS = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"]
export const DATE_MIN_YEAR = 1930
export const DATE_YEAR_HEADROOM = 10

export function dateMaxYear(now = null) {
  const ref = now instanceof Date ? now : new Date()
  return ref.getFullYear() + DATE_YEAR_HEADROOM
}

// A confident Jev choice that is canonically an integer in range: "13"
// yes, "13.0" / "thirteen" no. Number() plus a String() round-trip —
// platform conversion, no character inspection in our code.
function confidentInt(answer, min, max) {
  const conf = Number(answer?.confidence ?? NaN)
  if (typeof answer?.choice !== "string" || !(conf >= 0.5)) return null
  const clean = answer.choice.trim()
  if (!clean) return null
  const n = Number(clean)
  if (!Number.isInteger(n) || n < min || n > max || String(n) !== clean) return null
  return n
}

// Composes Jev's month/day/year choices into YYYY-MM-DD. Any unsure part,
// out-of-range number, or non-real calendar date (Feb 30) is null and the
// caller repeats the question.
export function dateFromAnswers(answers, suffix = "") {
  const monthName = confidentChoice(answers?.[`month${suffix}`], MONTHS)
  const day = confidentInt(answers?.[`day${suffix}`], 1, 31)
  const year = confidentInt(answers?.[`year${suffix}`], DATE_MIN_YEAR, dateMaxYear())
  if (monthName === null || day === null || year === null) return null
  const month = MONTHS.indexOf(monthName) + 1
  const d = new Date(year, month - 1, day)
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

// Coerces a Jev-validated numeric transcript with Number() only: "42" ->
// 42, "forty-two" -> null (repeat). Guards the empty->0 trap explicitly.
export function numberFromTranscript(transcript) {
  const clean = String(transcript ?? "").trim()
  if (!clean) return null
  const n = Number(clean)
  return Number.isFinite(n) ? n : null
}

// Voice field picker: Jev maps "which question" onto one field id.
// Anything unsure repeats the picker.
export function editFieldFromAnswers(answers, fields) {
  const allowed = (fields || []).map((f) => f.id)
  const hit = confidentChoice(answers?.field, allowed)
  if (hit) return { fieldId: hit, usedFallback: [] }
  return { fieldId: null, usedFallback: ["field"] }
}

// Guards Jev's answers without interpreting words: required fields must be
// non-empty, and closed-type values must be members of their option sets.
// Anything else repeats the question.
export function validateGroup(group, values) {
  for (const field of group) {
    const raw = values[field.id]
    const str = Array.isArray(raw) ? raw.join(", ") : String(raw ?? "").trim()
    if (!str && field.required) return { ok: false, reason: `“${field.name}” is required.` }
    if (!str) continue
    if (field.type === "choice_single" && !(field.options || []).includes(raw)) {
      return { ok: false, reason: `Pick one of: ${(field.options || []).join(", ")}.` }
    }
    if (field.type === "choice_multiple" && (!Array.isArray(raw) || !raw.every((o) => (field.options || []).includes(o)))) {
      return { ok: false, reason: `Pick from: ${(field.options || []).join(", ")}.` }
    }
    if (field.type === "yes_no" && raw !== "yes" && raw !== "no") {
      return { ok: false, reason: "Say yes or no." }
    }
  }
  return { ok: true }
}
// Merges one prompt's Jev answers onto 1-2 fields. `transcript` is only the
// verbatim value carrier for text/time/email (used when Jev's validity noul
// confirms) — it is never parsed or matched. Dates ride Jev's month/day/
// year choices (composed to ISO above); numbers are Jev-validated then
// coerced with Number(). Anything unsure repeats.
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
        values[field.id] = null
      }
    } else if (field.type === "choice_multiple") {
      const picks = []
      let unsure = !answers
      for (const opt of field.options || []) {
        const hit = noulBool(answers?.[`pick${suffix}_${opt}`])
        if (hit === true) picks.push(opt)
        else if (hit === null) {
          unsure = true
          usedFallback.push(`pick${suffix}_${opt}`)
        }
      }
      values[field.id] = unsure ? null : picks
    } else if (field.type === "yes_no") {
      const hit = noulBool(answers?.[`value${suffix}`])
      if (hit !== null) values[field.id] = hit ? "yes" : "no"
      else {
        usedFallback.push(`value${suffix}`)
        values[field.id] = null
      }
    } else if (field.type === "date") {
      const iso = dateFromAnswers(answers, suffix)
      if (iso !== null) values[field.id] = iso
      else {
        usedFallback.push(`month${suffix}`, `day${suffix}`, `year${suffix}`)
        values[field.id] = null
      }
    } else if (field.type === "number") {
      const valid = noulBool(answers?.[`valid${suffix}`])
      const num = valid ? numberFromTranscript(transcript) : null
      if (num === null) usedFallback.push(`valid${suffix}`)
      values[field.id] = num
    } else {
      const valid = noulBool(answers?.[`valid${suffix}`])
      if (valid === null) usedFallback.push(`valid${suffix}`)
      values[field.id] = valid ? String(transcript || "").trim() : null
    }
  })
  return { values, usedFallback }
}

export function escapeHtml(s) {
  // No regex anywhere in this app: plain string replacements only.
  return String(s ?? "").split("&").join("&amp;").split("<").join("&lt;")
    .split(">").join("&gt;").split('"').join("&quot;").split("'").join("&#39;")
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

export function rowTableHtml(schema, rows, selectedIndex = null) {
  if (!rows?.length) return `<p style="font-size:12px;color:#a1a1aa;">No rows yet.</p>`
  const head = schema.map((f) => `<th style="text-align:left;padding:6px 8px;color:#71717a;font-weight:600;">${escapeHtml(f.name)}</th>`).join("")
  const body = rows.map((row, i) =>
    `<tr data-action="click->input#selectRow" data-index="${i}" style="border-top:1px solid #f4f4f5;cursor:pointer;${i === selectedIndex ? "outline:2px solid #2563eb;outline-offset:-2px;" : ""}"><td style="padding:6px 8px;color:#a1a1aa;">${i + 1}</td>` +
    schema.map((f) => `<td style="padding:6px 8px;">${escapeHtml(Array.isArray(row[f.name]) ? row[f.name].join(", ") : row[f.name] ?? "")}</td>`).join("") + `</tr>`).join("")
  return `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr><th style="padding:6px 8px;">#</th>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    `<p style="font-size:11px;color:#a1a1aa;margin-top:4px;">Tap a row, then Start, to change or delete it by voice.</p>`
}

// The guided-edit prompt for one field: bare name, current value, skip option.
// "Skip" is the shared control choice, so Jev routes it — no word matching.
export function editPromptFor(field, current) {
  const display = Array.isArray(current) ? current.join(", ") : String(current ?? "").trim()
  return `${promptFor([field])} Currently ${display || "empty"}. Say a new value, or skip.`
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
    this.selectedIndex = null
    this.editValues = null
    this.editIdx = 0
    this.editSingle = false
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
    if (!localStorage.getItem("syft_jev_key")) {
      this.setStatus("Add your Jev key first — every answer here is mapped by Jev.")
      return
    }
    if (this.active) return
    this.schema = loadSchema()
    if (!this.schema.length) {
      this.setQuestion("Design fields first — then come back to fill rows.")
      return
    }
    this.active = true
    this.draft = {}
    this.fieldIndex = 0
    this.editSingle = false
    this.updateButtons()
    // A tapped row means voice-editing it; otherwise a new row.
    if (this.selectedIndex !== null && this.rows[this.selectedIndex]) {
      this.render()
      this.askRowMenu()
      return
    }
    this.selectedIndex = null
    this.render()
    this.nextGroup()
  }

  done() {
    if (!this.active) return
    // Save a non-empty draft as a row, then end the session.
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
    this.selectedIndex = null
    this.editValues = null
    this.render()
    this.setQuestion("Done.")
    this.setStatus(empty ? "Session ended — no answers to save." : `Session ended — saved row ${this.rows.length}.`)
    this.updateButtons()
  }

  updateButtons() {
    if (this.hasStartButtonTarget) this.startButtonTarget.disabled = this.active
    if (this.hasDoneButtonTarget) this.doneButtonTarget.disabled = !this.active
  }

  speak(text, onDone = null) {
    try {
      if (!window.speechSynthesis || !text) { onDone?.(); return }
      if (this.hasVoiceStatusTarget) this.voiceStatusTarget.textContent = "Speaking…"
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = "en-US"
      let finished = false
      let timer = null
      const finish = () => { if (!finished) { finished = true; if (timer) clearTimeout(timer); onDone?.() } }
      u.onend = finish
      u.onerror = finish
      window.speechSynthesis.speak(u)
      // Safety net: if TTS events never fire, advance after estimated speech
      // time instead of a fixed wait (short prompts recover fast, long ones
      // still get room to finish). No regex: split on plain spaces.
      const words = String(text).split(" ").filter((w) => w.length).length || 1
      const estMs = Math.min(15000, Math.max(3000, words * 500 + 2000))
      timer = setTimeout(() => { if (this.active && this.awaiting) finish() }, estMs)
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
    this.mode = "record"
    this.schema = loadSchema()
    if (!this.schema.length) {
      this.setQuestion("Design fields first — then come back to fill rows.")
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
    if (this.hasProgressTarget) this.progressTarget.textContent = `Row ${this.rows.length + 1} · field ${this.fieldIndex + 1} of ${this.schema.length}`
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
    if (this.mode === "menu") return this.submitRowMenu(text)
    if (this.mode === "edit_pick") return this.submitEditFieldChoice(text)
    if (this.mode === "edit") return this.submitEditAnswer(text)
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
      } catch { fbNote = "connection" }
    }
    const { control: rawControl, usedFallback: cfb } = controlFromAnswers(answers)
    const { values, usedFallback: vfb } = valuesFromAnswers(answers, this.group, text)
    const { control, usedFallback: efb, assumed } = effectiveControl(rawControl, cfb, vfb)
    const unsure = [...efb, ...vfb]
    this.logInspector(`control=${control}${assumed ? " (assumed — Jev unsure, values confident)" : ""} values=${JSON.stringify(values)}${unsure.length || fbNote ? ` · unsure(${unsure.join(",")}${fbNote ? `,${fbNote}` : ""})` : ""}`)
    if (!this.active) return
    if (!control || unsure.length) {
      this.sayThenListen(`Sorry — ${promptFor(this.group)}`)
      return
    }

    if (control === "repeat") { this.sayThenListen(promptFor(this.group)); return }
    if (control === "skip") { this.advance(values, true); return }
    if (control === "edit_previous") { this.goBack(); return }
    if (control === "finish_row") {
      const tail = validateGroup(this.group, values)
      if (!tail.ok) {
        this.setStatus(tail.reason)
        this.sayThenListen(`${tail.reason} ${promptFor(this.group)}`)
        return
      }
      Object.assign(this.draft, values)
      return this.finishRow()
    }
    // control === answer: validate, block + retry on failure
    const check = validateGroup(this.group, values)
    if (!check.ok) {
      this.setStatus(check.reason)
      this.sayThenListen(`${check.reason} ${promptFor(this.group)}`)
      return
    }
    this.advance(values, false)
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
    this.setStatus(empty ? "Row discarded (empty)." : `Saved row ${this.rows.length}.`)
    this.nextGroup()
  }

  // --- tap a row, voice takes over -------------------------------------------------
  // Tapping a row starts the voice flow (edit-or-delete menu) — no Start
  // needed. Tapping the selected row again only deselects it. While a
  // session is already active, tapping only moves the selection.
  selectRow(event) {
    const i = Number(event.currentTarget.dataset.index)
    this.selectedIndex = this.selectedIndex === i ? null : i
    this.render()
    if (this.selectedIndex !== null) this.start()
  }

  askRowMenu() {
    if (!this.active) return
    const row = this.rows[this.selectedIndex]
    if (!row) { this.selectedIndex = null; this.nextGroup(); return }
    this.mode = "menu"
    if (this.hasStepHintTarget) this.stepHintTarget.textContent = "Say “edit” to change answers, or “delete” to remove the row."
    if (this.hasProgressTarget) this.progressTarget.textContent = `Row ${this.selectedIndex + 1} of ${this.rows.length}`
    this.sayThenListen(`Row ${this.selectedIndex + 1}. Edit it, or delete it?`)
  }

  async submitRowMenu(text) {
    if (!this.active) return
    const key = localStorage.getItem("syft_jev_key") || ""
    let merged = { intent: null, usedFallback: ["intent", "no-key"] }
    if (key) {
      try {
        const res = await fetch("/jev_input", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({ step: "row_intent", transcript: text, api_key: key }),
        })
        const data = await res.json().catch(() => ({}))
        merged = rowIntentFromAnswers(res.ok ? data.answers : {}, text)
      } catch {
        merged = rowIntentFromAnswers({}, text)
      }
    } else {
      merged = rowIntentFromAnswers({}, text)
    }
    const want = merged.intent
    this.logInspector(`row intent = ${want}${merged.usedFallback.length ? " · fallback" : ""}`)
    if (!this.active) return
    if (want === "delete") {
      const n = this.selectedIndex + 1
      this.rows.splice(this.selectedIndex, 1)
      saveRows(this.rows) // notifies Visualize, which auto-loads
      this.endEdit("Row deleted.")
      this.speak(`Row ${n} deleted.`)
      return
    }
    if (want === "edit") {
      this.editValues = {}
      this.editSingle = true
      this.askEditFieldChoice()
      return
    }
    this.sayThenListen(`Sorry — say edit, or delete. Row ${this.selectedIndex + 1}: edit it, or delete it?`)
  }

  // Editing asks which question to change, then re-asks just that one.
  // The field names stay on screen in the table — voice never lists them.
  askEditFieldChoice() {
    if (!this.active) return
    const row = this.rows[this.selectedIndex]
    if (!row) { this.selectedIndex = null; this.nextGroup(); return }
    this.mode = "edit_pick"
    if (this.hasStepHintTarget) this.stepHintTarget.textContent = "Say the field name — the columns are in the table below."
    if (this.hasProgressTarget) this.progressTarget.textContent = `Editing row ${this.selectedIndex + 1} — pick a question`
    this.sayThenListen(`Which question should I change?`)
  }

  async submitEditFieldChoice(text) {
    if (!this.active) return
    const row = this.rows[this.selectedIndex]
    if (!row) return this.endEdit("Row is gone.")
    this.setStatus("Checking with Jev…")
    const key = localStorage.getItem("syft_jev_key") || ""
    let merged = { fieldId: null, usedFallback: ["field", "no-key"] }
    if (key) {
      try {
        const res = await fetch("/jev_input", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({
            step: "edit_field", transcript: text,
            fields: this.schema.map((f) => ({ id: f.id, name: f.name })),
            api_key: key,
          }),
        })
        const data = await res.json().catch(() => ({}))
        merged = editFieldFromAnswers(res.ok ? data.answers : {}, this.schema)
      } catch {
        merged = editFieldFromAnswers({}, this.schema)
      }
    } else {
      merged = editFieldFromAnswers({}, this.schema)
    }
    this.logInspector(`edit field = ${merged.fieldId}${merged.usedFallback.length ? " · unsure" : ""}`)
    if (!this.active) return
    const picked = (this.schema || []).findIndex((f) => f.id === merged.fieldId)
    if (picked < 0) {
      this.sayThenListen(`Sorry — which question should I change? Say the field name.`)
      return
    }
    this.editIdx = picked
    this.askEditField()
  }

  askEditField() {
    if (!this.active) return
    const row = this.rows[this.selectedIndex]
    if (!row || this.editIdx >= this.schema.length) return this.commitEdit()
    this.mode = "edit"
    const field = this.schema[this.editIdx]
    if (this.hasStepHintTarget) {
      this.stepHintTarget.textContent = `Row ${this.selectedIndex + 1} · field ${this.editIdx + 1} of ${this.schema.length}. Say “skip” to leave it, “go back” to revisit.`
    }
    if (this.hasProgressTarget) this.progressTarget.textContent = `Editing row ${this.selectedIndex + 1} · field ${this.editIdx + 1} of ${this.schema.length}`
    this.sayThenListen(editPromptFor(field, row[field.name]))
  }

  async submitEditAnswer(text) {
    if (!this.active) return
    const row = this.rows[this.selectedIndex]
    if (!row) return this.endEdit("Row is gone.")
    const field = this.schema[this.editIdx]
    this.setStatus("Checking with Jev…")
    const { answers, fbNote } = await this.jevAnswer(text, [field])
    const { control: rawControl, usedFallback: cfb } = controlFromAnswers(answers)
    const { values, usedFallback: vfb } = valuesFromAnswers(answers, [field], text)
    const { control, usedFallback: efb, assumed } = effectiveControl(rawControl, cfb, vfb)
    const unsure = [...efb, ...vfb]
    this.logInspector(`edit ${field.name}=${JSON.stringify(values[field.id])} control=${control}${assumed ? " (assumed — Jev unsure, values confident)" : ""}${unsure.length || fbNote ? ` · unsure(${unsure.join(",")}${fbNote ? `,${fbNote}` : ""})` : ""}`)
    if (!this.active) return
    // The shared control choice carries keep (skip) and go-back intents.
    if (!control || (control !== "skip" && control !== "edit_previous" && unsure.length)) {
      this.sayThenListen(`Sorry — ${editPromptFor(field, row[field.name])}`)
      return
    }
    // Single-question edit: answer commits, skip keeps the old value and
    // commits, go-back re-asks the same question (there is only one).
    if (control === "skip") {
      if (this.editSingle) return this.commitEdit()
      this.editIdx += 1
      this.askEditField()
      return
    }
    if (control === "edit_previous") {
      if (this.editSingle) {
        this.setStatus("Only one question in this edit.")
        this.askEditField()
        return
      }
      this.editIdx = Math.max(0, this.editIdx - 1)
      delete this.editValues[this.schema[this.editIdx].id]
      this.setStatus("Went back one question.")
      this.askEditField()
      return
    }
    if (control === "repeat") {
      this.sayThenListen(editPromptFor(field, row[field.name]))
      return
    }
    if (control === "finish_row") return this.commitEdit()
    // control === answer: validate, block + retry on failure
    const check = validateGroup([field], values)
    if (!check.ok) {
      this.setStatus(check.reason)
      this.sayThenListen(`${check.reason} ${editPromptFor(field, values[field.id])}`)
      return
    }
    this.editValues[field.id] = values[field.id]
    if (this.editSingle) return this.commitEdit()
    this.editIdx += 1
    this.askEditField()
  }

  commitEdit() {
    const row = this.rows[this.selectedIndex]
    if (!row) return this.endEdit("Row is gone.")
    for (const f of this.schema) {
      if (this.editValues && f.id in this.editValues) {
        const v = this.editValues[f.id]
        row[f.name] = Array.isArray(v) ? v : (v ?? "")
      }
    }
    saveRows(this.rows) // notifies Visualize, which auto-loads
    this.render()
    const n = this.selectedIndex + 1
    this.endEdit(`Row ${n} updated.`)
    this.speak(`Row ${n} updated.`)
  }

  async jevAnswer(transcript, fields) {
    const key = localStorage.getItem("syft_jev_key") || ""
    if (!key) return { answers: {}, fbNote: "no-key" }
    try {
      const res = await fetch("/jev_input", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
        body: JSON.stringify({
          step: "answer", transcript: transcript,
          fields: fields.map((f) => ({ name: f.name, type: f.type, required: f.required, options: f.options })),
          api_key: key,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.answers) return { answers: data.answers, fbNote: "" }
      return { answers: {}, fbNote: `http-${res.status}` }
    } catch {
      return { answers: {}, fbNote: "connection" }
    }
  }

  endEdit(status) {
    this.stopSession()
    this.draft = {}
    this.fieldIndex = 0
    this.group = []
    this.selectedIndex = null
    this.editValues = null
    this.editSingle = false
    this.render()
    this.setQuestion("Done.")
    this.setStatus(status || "Edit ended. Tap a row for more.")
    this.updateButtons()
  }

  clearRows() {
    this.rows = []
    this.selectedIndex = null
    saveRows(this.rows)
    this.render()
  }

  render() {
    if (this.hasRowsTableTarget) this.rowsTableTarget.innerHTML = rowTableHtml(this.schema, this.rows, this.selectedIndex)
  }

  logInspector(line) {
    if (!this.hasInspectorTarget) return
    const div = document.createElement("div")
    div.textContent = line
    this.inspectorTarget.prepend(div)
  }
}
