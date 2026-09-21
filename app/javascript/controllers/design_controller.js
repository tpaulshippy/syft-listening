import { Controller } from "@hotwired/stimulus"

// Data design interview: user speaks/types all free text (field names,
// option names). Jev only classifies — field type, option/session intents,
// required flag. No LLM text generation anywhere.
//
// Schema persists in localStorage under SCHEMA_KEY so the Input and
// Visualize tabs can read it later:
// [{ id, name, type, required, options[] }]
//
// Pure helpers are module-level exports for Vitest; the Stimulus class
// below drives the interview (name -> classify -> options? -> required).

export const FIELD_TYPES = ["text", "number", "date", "time", "email", "yes_no", "choice_single", "choice_multiple"]
export const CHOICE_TYPES = ["choice_single", "choice_multiple"]
export const SCHEMA_KEY = "syft_design_schema"
export const MAX_FIELDS = 20
export const MAX_OPTIONS = 30
export const MAX_NAME_CHARS = 60

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

export function saveSchema(fields, store = null) {
  const s = store || (typeof localStorage !== "undefined" ? localStorage : null)
  s?.setItem(SCHEMA_KEY, JSON.stringify(fields || []))
}

export function validateFieldName(name, existing = []) {
  const t = String(name ?? "").trim()
  if (!t) return "Give the field a name first."
  if (t.length > MAX_NAME_CHARS) return `Keep it under ${MAX_NAME_CHARS} chars.`
  const dup = existing.some((f) => f.name.trim().toLowerCase() === t.toLowerCase())
  if (dup) return "That name is already used — pick another or edit the existing field."
  return null
}

// Word tokens for the no-key fallbacks below: lowercase words with edge
// punctuation stripped, so "Done!" behaves as "done". Understanding always
// goes to Jev first; these whole-word checks are the last resort only.
function isWordChar(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")
}

export function words(text) {
  const out = []
  for (const raw of String(text || "").toLowerCase().split(" ")) {
    let s = raw
    while (s && !isWordChar(s[0])) s = s.slice(1)
    while (s && !isWordChar(s[s.length - 1])) s = s.slice(0, -1)
    if (s) out.push(s)
  }
  return out
}

export function hasWord(text, ...candidates) {
  const ws = words(text)
  return candidates.some((c) => ws.includes(c))
}

export function startsWithPhrase(text, ...phrases) {
  const t = String(text || "").toLowerCase().trim()
  return phrases.some((ph) => t === ph || t.startsWith(ph + " ") || t.startsWith(ph))
}

// Offline keyword fallback for type classification (no key / low confidence).
export function fallbackType(fieldName) {
  const p = String(fieldName || "").toLowerCase()
  const has = (...needles) => needles.some((n) => p.includes(n))
  if (has("email", "e-mail")) return "email"
  if (has("birthday", "birth", "due date", "deadline", "date", "day", "month", "year")) return "date"
  if (has("time", "alarm", "hour", "minute", "meeting at")) return "time"
  if (has("how many", "amount", "count", "number", "qty", "quantity", "price", "cost", "total", "age", "minutes", "km", "units")) return "number"
  if (has("yes-no", "yes no", "yesno", "true", "false", "agree", "confirm")) return "yes_no"
  if (has("pick several", "choose several", "select several", "multiple", "check all")) return "choice_multiple"
  if (has("pick", "choose", "select", "option", "category", "genre", "status", "kind", "type of")) return "choice_single"
  return "text"
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

export function typeFromAnswers(answers, fieldName) {
  const hit = confidentChoice(answers?.field_type, FIELD_TYPES)
  if (hit) return { type: hit, usedFallback: [] }
  return { type: fallbackType(fieldName), usedFallback: ["field_type"] }
}

export const OPTION_INTENTS = ["add_option", "done_options", "remove_last"]
export const SESSION_INTENTS = ["next_field", "finished", "edit_last", "delete_last"]

export function optionIntentFromAnswers(answers, transcript) {
  const hit = confidentChoice(answers?.intent, OPTION_INTENTS)
  if (hit) return { intent: hit, usedFallback: [] }
  if (startsWithPhrase(transcript, "done", "finished", "that's all", "next", "no more")) {
    return { intent: "done_options", usedFallback: ["intent"] }
  }
  const ws = words(transcript)
  if (["remove", "undo", "delete", "drop"].includes(ws[0]) && (ws.length === 1 || ["that", "it", "last"].includes(ws[1]))) {
    return { intent: "remove_last", usedFallback: ["intent"] }
  }
  return { intent: "add_option", usedFallback: ["intent"] }
}

export function requiredFromAnswers(answers, transcript) {
  const hit = noulBool(answers?.required)
  if (hit !== null) return { required: hit, usedFallback: [] }
  if (hasWord(transcript, "required", "must", "mandatory", "yes")) return { required: true, usedFallback: ["required"] }
  return { required: false, usedFallback: ["required"] }
}

export function sessionIntentFromAnswers(answers, transcript) {
  const hit = confidentChoice(answers?.intent, SESSION_INTENTS)
  if (hit) return { intent: hit, usedFallback: [] }
  if (startsWithPhrase(transcript, "finished", "done", "that's all", "complete")) {
    return { intent: "finished", usedFallback: ["intent"] }
  }
  const ws = words(transcript)
  if (["delete", "remove"].includes(ws[0]) && ["last", "that", "it"].includes(ws[1])) {
    return { intent: "delete_last", usedFallback: ["intent"] }
  }
  if (["edit", "rename"].includes(ws[0]) && ["last", "that", "it"].includes(ws[1])) {
    return { intent: "edit_last", usedFallback: ["intent"] }
  }
  return { intent: "next_field", usedFallback: ["intent"] }
}

// Fields the end-of-session required question hasn't covered yet. A field
// counts as decided once it was included in a required answer or its
// required flag was flipped by hand. Persists on the field objects, so a
// later session only asks about genuinely new fields.
export function fieldsNeedingRequired(fields) {
  return (fields || []).filter((f) => !f.requiredDecided)
}

// Merges the end-of-session "which fields are required?" answers: one noul
// per field, falling back to name mentions ("email and birthday"), "all",
// or "none" when Jev is unsure or there is no key.
export function requiredFieldsFromAnswers(answers, fields, transcript) {
  const usedFallback = []
  const requiredIds = []
  for (const field of fields || []) {
    const a = answers?.[`required_${field.id}`]
    let req = null
    if (a != null && a.noul != null) {
      const n = Number(a.noul)
      if (Math.abs(n - 0.5) * 2 >= 0.5) req = n >= 0.5
    }
    if (req === null) {
      usedFallback.push(`required_${field.id}`)
      const lowered = String(transcript || "").toLowerCase()
      if (hasWord(transcript, "none", "nope") || lowered.includes("not required") || lowered.includes("all optional")) req = false
      else if (hasWord(transcript, "all", "every", "everything") || lowered.includes("all of them")) req = true
      else req = lowered.includes(String(field.name || "").toLowerCase())
    }
    if (req) requiredIds.push(field.id)
  }
  return { requiredIds, usedFallback }
}

// Adds a spoken option verbatim; dedups case-insensitively, caps length.
export function addOption(field, option) {
  const t = String(option ?? "").trim()
  if (!t) return { ok: false, reason: "empty" }
  if (t.length > MAX_NAME_CHARS) return { ok: false, reason: "too_long" }
  const opts = field.options || []
  if (opts.some((o) => o.toLowerCase() === t.toLowerCase())) return { ok: false, reason: "duplicate" }
  if (opts.length >= MAX_OPTIONS) return { ok: false, reason: "capped" }
  opts.push(t)
  field.options = opts
  return { ok: true }
}

// No regex anywhere in this app: plain string replacements only.
export function escapeHtml(s) {
  return String(s ?? "").split("&").join("&amp;").split("<").join("&lt;")
    .split(">").join("&gt;").split('"').join("&quot;").split("'").join("&#39;")
}

export function fieldCardHtml(field, index, selected = false) {
  const opts = CHOICE_TYPES.includes(field.type) && field.options?.length
    ? `<div style="font-size:11px;color:#52525b;margin-top:4px;">options: ${field.options.map(escapeHtml).join(" · ")}</div>`
    : ""
  return `<div data-action="click->design#selectField" data-id="${escapeHtml(field.id)}" style="border:${selected ? "2px solid #2563eb" : "1px solid #e4e4e7"};border-radius:12px;padding:10px;cursor:pointer;">` +
    `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;">` +
    `<strong style="font-size:13px;">${index + 1}. ${escapeHtml(field.name)}</strong>` +
    `<span style="font-size:11px;color:#71717a;">${escapeHtml(field.type)}${field.required ? " · required" : ""}</span></div>${opts}</div>`
}

// Voice edit menu: Jev decides which aspect the speaker names, from the
// `edit_intent` choice. The no-key fallback matches whole words only.
export const EDIT_INTENTS = ["name", "type", "options", "required", "remove", "done"]

export function editIntentFromAnswers(answers, transcript) {
  const hit = confidentChoice(answers?.intent, EDIT_INTENTS)
  if (hit) return { aspect: hit, usedFallback: [] }
  const lowered = String(transcript || "").toLowerCase()
  if (["remove", "delete", "drop"].some((w) => hasWord(transcript, w))) return { aspect: "remove", usedFallback: ["intent"] }
  if (["done", "finished", "stop", "no", "nope"].includes(lowered.trim()) || startsWithPhrase(transcript, "that's all")) {
    return { aspect: "done", usedFallback: ["intent"] }
  }
  if (hasWord(transcript, "name", "rename") || lowered.includes("call it") || hasWord(transcript, "title")) {
    return { aspect: "name", usedFallback: ["intent"] }
  }
  if (hasWord(transcript, "option", "options", "choice", "choices")) return { aspect: "options", usedFallback: ["intent"] }
  if (hasWord(transcript, "required", "optional", "must", "need")) return { aspect: "required", usedFallback: ["intent"] }
  if (hasWord(transcript, "type")) return { aspect: "type", usedFallback: ["intent"] }
  return { aspect: null, usedFallback: ["intent"] }
}

// The edit-menu question: only offers options for choice fields, so users
// are never invited down a dead end.
export function editMenuPrompt(field) {
  const aspects = CHOICE_TYPES.includes(field.type)
    ? "name, type, options, or required"
    : "name, type, or required"
  return `Change ${field.name}, or remove it? Say ${aspects}.`
}

// (Retype answers come from the `change_type` Jev step; the no-key path
// reuses fallbackType over the spoken words.)

// --- Stimulus controller: voice-only session ---------------------------------
// One Start button, one Done button. The system speaks each question, listens,
// and advances automatically from what the user says. No typing anywhere.
export default class extends Controller {
  static targets = ["question",
    "fieldList", "status", "inspector", "voiceStatus", "apiKey", "stepHint",
    "startButton", "doneButton"]

  connect() {
    this.fields = loadSchema()
    this.selectedId = null
    this.editing = false
    this.phase = "idle" // idle -> name -> options -> required_fields
    this.pending = null // field under construction
    this.recognition = null
    this.active = false
    this.awaiting = false
    const stored = localStorage.getItem("syft_jev_key") || ""
    if (this.hasApiKeyTarget) {
      this.apiKeyTarget.value = stored
      this.apiKeyTarget.addEventListener("input", () => {
        localStorage.setItem("syft_jev_key", this.apiKeyTarget.value.trim())
      })
    }
    this.render()
    this.setQuestion("Tap Start, then speak — I'll ask for each field.")
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

  // --- session ------------------------------------------------------------------
  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      this.setStatus("Voice not supported here — try Chrome or Edge.")
      return
    }
    if (this.active) return
    this.active = true
    this.editing = false
    this.updateButtons()
    // A tapped field means voice-editing; otherwise new-field interview.
    if (this.selectedField()) this.askEditMenu()
    else this.askName()
  }

  done() {
    if (!this.active) return
    if (!this.fields.length) {
      this.endSession("Session ended — no fields. Tap Start to begin.")
      return
    }
    // Fields are all there — one closing question, only about fields whose
    // required status was never decided (new since the last session).
    this.pending = null
    if (!fieldsNeedingRequired(this.fields).length) {
      this.endSession(`Session ended — ${this.fields.length} field${this.fields.length === 1 ? "" : "s"}, required already set. Tap Start to add more.`)
      return
    }
    this.askRequiredFields()
  }

  endSession(status) {
    this.stopSession()
    this.phase = "idle"
    this.pending = null
    this.editing = false
    this.selectedId = null
    this.render()
    this.setQuestion("Done.")
    this.setStatus(status || `Session ended — ${this.fields.length} field${this.fields.length === 1 ? "" : "s"}. Tap Start to add more.`)
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
      // Safety net: if TTS events never fire, keep going after a pause.
      setTimeout(() => { if (this.active && this.awaiting) finish() }, 8000)
    } catch { onDone?.() }
  }

  // --- interview steps (each speaks, then listens) ------------------------------
  askName() {
    if (!this.active) return
    this.phase = "name"
    this.pending = null
    const n = this.fields.length + 1
    this.setHint("Say the field name — or say “finished” when done.")
    this.sayThenListen(`What should field ${n} be called?`)
  }

  askOptions() {
    if (!this.active) return
    this.phase = "options"
    const count = (this.pending.options || []).length + 1
    this.setHint("Each option is added as heard. Say “done” when finished, “remove last” to undo.")
    this.sayThenListen(`“${this.pending.name}” — tell me option ${count}, or say “done”.`)
  }

  askRequiredFields() {
    if (!this.active) return
    const unasked = fieldsNeedingRequired(this.fields)
    if (!unasked.length) { this.endSession(); return }
    this.phase = "required_fields"
    const names = unasked.map((f) => f.name).join(", ")
    this.setHint("Name the required ones, say “all”, or say “none”.")
    this.sayThenListen(`Which fields are required? ${names}.`)
  }

  sayThenListen(text) {
    if (this.hasQuestionTarget) this.questionTarget.textContent = text
    this.awaiting = true
    this.speak(text, () => { if (this.active && this.awaiting) this.listen() })
  }

  setQuestion(text) {
    if (this.hasQuestionTarget) this.questionTarget.textContent = text
  }

  setHint(text) {
    if (this.hasStepHintTarget) this.stepHintTarget.textContent = text
  }

  setStatus(text) {
    if (this.hasStatusTarget) this.statusTarget.textContent = text
  }

  // --- listening: one shot per question, auto-submits what is heard -------------
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
      // other errors fall through to onend, which retries while awaiting
    }
    this.recognition.onend = () => {
      if (!this.active || !this.awaiting) return
      const heard = finalText.trim()
      if (heard) {
        this.awaiting = false
        this.handleTranscript(heard)
      } else {
        // silence — keep listening for the same question
        this.listen()
      }
    }
    try {
      this.recognition.start()
      if (this.hasVoiceStatusTarget) this.voiceStatusTarget.textContent = "Listening…"
    } catch {
      // start raced a stop; retry shortly while still awaiting
      setTimeout(() => { if (this.active && this.awaiting) this.listen() }, 300)
    }
  }

  // --- main router: what the user said drives the next step ---------------------
  async handleTranscript(text) {
    if (!this.active) return
    if (this.phase === "name") {
      // Exact session commands act as voice-buttons; everything else is a name.
      const w = words(text)
      if (w.length <= 2 && (["finished", "done", "stop"].includes(w[0]) || startsWithPhrase(text, "that's all", "no more"))) {
        this.done()
        return
      }
      return this.submitName(text)
    }
    if (this.phase === "options") return this.submitOption(text)
    if (this.phase === "required_fields") return this.submitRequiredFields(text)
    if (this.phase === "edit_menu") return this.submitEditMenu(text)
    if (this.phase === "edit_name") return this.submitEditName(text)
    if (this.phase === "edit_type") return this.submitEditType(text)
    if (this.phase === "edit_required") return this.submitEditRequired(text)
  }

  repeatQuestion() {
    // re-speak the current question and listen again
    if (this.phase === "name") return this.askName()
    if (this.phase === "options") return this.askOptions()
    if (this.phase === "required_fields") return this.askRequiredFields()
    if (this.phase === "edit_menu") return this.askEditMenu()
  }

  async submitName(name) {
    const clean = String(name ?? "").trim()
    const err = validateFieldName(clean, this.fields)
    if (err) {
      this.setStatus(err)
      this.sayThenListen(`I didn't catch a usable name. ${err} What should the field be called?`)
      return
    }
    if (this.fields.length >= MAX_FIELDS) {
      this.setStatus(`Field cap reached (${MAX_FIELDS}).`)
      this.sayThenListen(`Field cap reached. Say “finished” to end, or remove a field first.`)
      return
    }
    this.pending = { id: `f${Date.now().toString(36)}`, name: clean, type: "text", required: false, requiredDecided: false, options: [] }
    this.setStatus("Classifying type with Jev…")
    const { type, usedFallback } = await this.classifyType(clean)
    if (!this.active) return
    this.pending.type = type
    this.logInspector(`field_type = ${type}${usedFallback.length ? " · fallback" : ""}`)
    if (CHOICE_TYPES.includes(type)) this.askOptions()
    else this.commitField()
  }

  // A finished field goes straight onto the list — required is asked once,
  // for all fields together, when the session ends.
  commitField() {
    this.fields.push(this.pending)
    saveSchema(this.fields)
    this.setStatus(`Added “${this.pending.name}” (${this.pending.type}).`)
    this.render()
    this.askName()
  }

  async classifyType(fieldName) {
    const key = localStorage.getItem("syft_jev_key") || ""
    if (!key) return { type: fallbackType(fieldName), usedFallback: ["field_type", "no-key"] }
    try {
      const res = await fetch("/jev_design", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
        body: JSON.stringify({ step: "classify", field_name: fieldName, api_key: key }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.answers) return { type: fallbackType(fieldName), usedFallback: ["field_type", `http-${res.status}`] }
      return typeFromAnswers(data.answers, fieldName)
    } catch {
      return { type: fallbackType(fieldName), usedFallback: ["field_type", "connection"] }
    }
  }

  async submitOption(text) {
    const key = localStorage.getItem("syft_jev_key") || ""
    let intent = "add_option"
    let fb = ["intent", "no-key"]
    if (key) {
      try {
        const res = await fetch("/jev_design", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({
            step: "option_intent", transcript: text, field_name: this.pending.name,
            options_so_far: this.pending.options, api_key: key,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.answers) {
          const m = optionIntentFromAnswers(data.answers, text)
          intent = m.intent
          fb = m.usedFallback
        } else {
          intent = optionIntentFromAnswers({}, text).intent
        }
      } catch {
        intent = optionIntentFromAnswers({}, text).intent
      }
    } else {
      intent = optionIntentFromAnswers({}, text).intent
    }
    this.logInspector(`option intent = ${intent}${fb.length ? " · fallback" : ""}`)
    if (!this.active) return
    if (intent === "done_options") {
      if (!(this.pending.options || []).length) {
        this.setStatus("I need at least one option.")
        this.sayThenListen(`I need at least one option for “${this.pending.name}”. Tell me the first option.`)
        return
      }
      if (this.editing) {
        // Editing an existing field in place — nothing to push.
        this.editing = false
        this.pending = null
        saveSchema(this.fields)
        this.render()
        this.askEditMenu("Options updated.")
        return
      }
      this.commitField()
    } else if (intent === "remove_last") {
      this.pending.options.pop()
      this.setStatus("Removed the last option.")
      this.askOptions()
    } else {
      const r = addOption(this.pending, text)
      this.setStatus(r.ok ? `Added “${text}”.` : r.reason === "duplicate" ? "Already have that option — try another." : r.reason === "capped" ? `Option cap (${MAX_OPTIONS}) reached — say “done”.` : "Could not add that option.")
      if (r.ok || r.reason === "duplicate") this.askOptions()
      else this.repeatQuestion()
    }
  }

  async submitRequiredFields(text) {
    const unasked = fieldsNeedingRequired(this.fields)
    if (!unasked.length) { this.endSession(); return }
    const key = localStorage.getItem("syft_jev_key") || ""
    let merged = { requiredIds: [], usedFallback: ["required_fields", "no-key"] }
    if (key) {
      try {
        const res = await fetch("/jev_design", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({
            step: "required_fields", transcript: text,
            fields: unasked.map((f) => ({ id: f.id, name: f.name })),
            api_key: key,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.answers) {
          merged = requiredFieldsFromAnswers(data.answers, unasked, text)
        } else {
          merged = requiredFieldsFromAnswers({}, unasked, text)
        }
      } catch {
        merged = requiredFieldsFromAnswers({}, unasked, text)
      }
    } else {
      merged = requiredFieldsFromAnswers({}, unasked, text)
    }
    const wanted = new Set(merged.requiredIds)
    for (const f of unasked) {
      f.required = wanted.has(f.id)
      f.requiredDecided = true
    }
    saveSchema(this.fields)
    this.render()
    this.logInspector(`required = ${unasked.filter((f) => f.required).map((f) => f.name).join(", ") || "none"}${merged.usedFallback.length ? " · fallback" : ""}`)
    if (!this.active) return
    const names = unasked.filter((f) => f.required).map((f) => f.name)
    this.speak(names.length ? `Marked ${names.join(", ")} as required.` : "Nothing marked required.", () => {
      this.endSession()
    })
  }

  // --- tap to select, voice to change ----------------------------------------------
  // Tapping a field only selects it. Every change happens by voice after Start.
  selectField(event) {
    const id = event.currentTarget.dataset.id
    this.selectedId = this.selectedId === id ? null : id
    this.render()
  }

  selectedField() {
    return this.fields.find((f) => f.id === this.selectedId) || null
  }

  // Voice edit flow for the selected field: menu -> one aspect -> menu -> done.
  askEditMenu(note = "") {
    if (!this.active) return
    const field = this.selectedField()
    if (!field) { this.askName(); return }
    this.phase = "edit_menu"
    this.setHint("Say “done” to finish, or “remove” to delete the field.")
    this.sayThenListen(`${note ? note + " " : ""}${editMenuPrompt(field)}`)
  }

  async submitEditMenu(text) {
    const field = this.selectedField()
    if (!field) { this.askName(); return }
    const key = localStorage.getItem("syft_jev_key") || ""
    let merged = { aspect: null, usedFallback: ["intent", "no-key"] }
    if (key) {
      try {
        const res = await fetch("/jev_design", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({ step: "edit_intent", transcript: text, field_name: field.name, api_key: key }),
        })
        const data = await res.json().catch(() => ({}))
        merged = editIntentFromAnswers(res.ok ? data.answers : {}, text)
      } catch {
        merged = editIntentFromAnswers({}, text)
      }
    } else {
      merged = editIntentFromAnswers({}, text)
    }
    const aspect = merged.aspect
    this.logInspector(`edit intent = ${aspect}${merged.usedFallback.length ? " · fallback" : ""}`)
    if (!this.active) return
    if (aspect === "remove") {
      this.fields = this.fields.filter((f) => f.id !== field.id)
      this.selectedId = null
      saveSchema(this.fields)
      this.render()
      this.speak(`Removed ${field.name}.`, () => this.endSession(`Removed “${field.name}”. Tap Start to add more.`))
      return
    }
    if (aspect === "done") {
      this.selectedId = null
      this.endSession()
      return
    }
    if (aspect === "name") {
      this.phase = "edit_name"
      this.sayThenListen(`Say the new name for ${field.name}.`)
      return
    }
    if (aspect === "type") {
      this.phase = "edit_type"
      this.sayThenListen(`What type should ${field.name} be? Text, number, date, time, email, yes or no, single choice, or multiple choice.`)
      return
    }
    if (aspect === "required") {
      this.phase = "edit_required"
      this.sayThenListen(`Should ${field.name} be required? Say yes or no.`)
      return
    }
    if (aspect === "options") {
      if (!CHOICE_TYPES.includes(field.type)) {
        this.sayThenListen(`${field.name} is not a choice field. Say name, type, or required — or done.`)
        this.phase = "edit_menu"
        return
      }
      this.pending = field
      this.editing = true
      this.askOptions()
      return
    }
    this.sayThenListen(`Sorry — say name, type, options, or required. Or say done.`)
  }

  async submitEditName(text) {
    const field = this.selectedField()
    if (!field) { this.askName(); return }
    const clean = String(text ?? "").trim()
    const err = validateFieldName(clean, this.fields.filter((f) => f.id !== field.id))
    if (err) {
      this.sayThenListen(`${err} Say the new name for ${field.name}.`)
      return
    }
    const old = field.name
    field.name = clean
    saveSchema(this.fields)
    this.render()
    this.logInspector(`renamed ${old} -> ${clean}`)
    this.askEditMenu(`Renamed to ${clean}.`)
  }

  async submitEditType(text) {
    const field = this.selectedField()
    if (!field) { this.askName(); return }
    this.setStatus("Checking the type with Jev…")
    const key = localStorage.getItem("syft_jev_key") || ""
    let typed = { type: fallbackType(text), usedFallback: ["field_type", "no-key"] }
    if (key) {
      try {
        const res = await fetch("/jev_design", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({ step: "change_type", transcript: text, field_name: field.name, api_key: key }),
        })
        const data = await res.json().catch(() => ({}))
        typed = typeFromAnswers(res.ok ? data.answers : {}, text)
      } catch {
        typed = typeFromAnswers({}, text)
      }
    }
    if (!this.active) return
    const type = typed.type
    this.logInspector(`retyped ${field.name} -> ${type}${typed.usedFallback.length ? " · fallback" : ""}`)
    if (!FIELD_TYPES.includes(type)) {
      this.sayThenListen(`I didn't catch a type. Text, number, date, time, email, yes or no, single choice, or multiple choice?`)
      return
    }
    field.type = type
    saveSchema(this.fields)
    this.render()
    if (CHOICE_TYPES.includes(type) && !(field.options || []).length) {
      this.pending = field
      this.editing = true
      this.askOptions()
      return
    }
    this.askEditMenu(`Now a ${type} field.`)
  }

  async submitEditRequired(text) {
    const field = this.selectedField()
    if (!field) { this.askName(); return }
    const key = localStorage.getItem("syft_jev_key") || ""
    let required = requiredFromAnswers({}, text).required
    if (key) {
      try {
        const res = await fetch("/jev_design", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({ step: "required", transcript: text, field_name: field.name, api_key: key }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.answers) required = requiredFromAnswers(data.answers, text).required
      } catch { /* fallback stands */ }
    }
    if (!this.active) return
    field.required = required
    field.requiredDecided = true
    saveSchema(this.fields)
    this.render()
    this.logInspector(`required(${field.name}) = ${required}`)
    this.askEditMenu(required ? "Now required." : "Now optional.")
  }

  clearAll() {
    this.fields = []
    this.selectedId = null
    saveSchema(this.fields)
    this.render()
  }

  render() {
    if (!this.hasFieldListTarget) return
    this.fieldListTarget.innerHTML = this.fields.length
      ? this.fields.map((f, i) => fieldCardHtml(f, i, f.id === this.selectedId)).join("")
      : `<p style="font-size:12px;color:#a1a1aa;">No fields yet — tap Start and speak.</p>`
  }

  logInspector(line) {
    if (!this.hasInspectorTarget) return
    const div = document.createElement("div")
    div.textContent = line
    this.inspectorTarget.prepend(div)
  }
}
