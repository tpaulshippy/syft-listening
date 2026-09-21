import { Controller } from "@hotwired/stimulus"

// Data design interview: the user speaks every name and option; Jev makes
// every decision — field type, intents, required flags. No LLM text, no
// matchers: anything Jev leaves unsure repeats the question (an unsure
// field type defaults to text and can be retyped by voice when editing).
// A Jev key is required (voice commands refuse without one).
//
// Schema persists in localStorage under SCHEMA_KEY so the Input and
// Visualize tabs can read it later:
// [{ id, name, type, required, requiredDecided, options[] }]
//
// Pure helpers are module-level exports for Vitest; the Stimulus class
// below drives the interview (name -> classify -> options? -> done).

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

// Jev-only mergers: a confident answer wins, anything else is marked unsure
// and the caller repeats the question. There are no keyword fallbacks.
export function typeFromAnswers(answers) {
  const hit = confidentChoice(answers?.field_type, FIELD_TYPES)
  if (hit) return { type: hit, usedFallback: [] }
  return { type: null, usedFallback: ["field_type"] }
}

export const OPTION_INTENTS = ["add_option", "done_options", "remove_last"]
export const SESSION_INTENTS = ["next_field", "finished", "edit_last", "delete_last"]

export function optionIntentFromAnswers(answers) {
  const hit = confidentChoice(answers?.intent, OPTION_INTENTS)
  if (hit) return { intent: hit, usedFallback: [] }
  return { intent: null, usedFallback: ["intent"] }
}

export function requiredFromAnswers(answers) {
  const hit = noulBool(answers?.required)
  if (hit !== null) return { required: hit, usedFallback: [] }
  return { required: null, usedFallback: ["required"] }
}

export function sessionIntentFromAnswers(answers) {
  const hit = confidentChoice(answers?.intent, SESSION_INTENTS)
  if (hit) return { intent: hit, usedFallback: [] }
  return { intent: null, usedFallback: ["intent"] }
}

// Fields the end-of-session required question hasn't covered yet. A field
// counts as decided once it was included in a required answer or its
// required flag was flipped by hand. Persists on the field objects, so a
// later session only asks about genuinely new fields.
export function fieldsNeedingRequired(fields) {
  return (fields || []).filter((f) => !f.requiredDecided)
}

// Merges the end-of-session "which fields are required?" answers: one noul
// per field. Any field Jev leaves unsure repeats the whole question.
export function requiredFieldsFromAnswers(answers, fields) {
  const usedFallback = []
  const requiredIds = []
  for (const field of fields || []) {
    const a = answers?.[`required_${field.id}`]
    let req = null
    if (a != null && a.noul != null) {
      const n = Number(a.noul)
      if (Math.abs(n - 0.5) * 2 >= 0.5) req = n >= 0.5
    }
    if (req === null) usedFallback.push(`required_${field.id}`)
    else if (req) requiredIds.push(field.id)
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

// Voice retype: applies Jev's confident new type to the field in place.
// Leaving a choice type drops its options (they no longer apply);
// entering one keeps (or inits) the list — the caller asks for options
// when it's empty.
export function retypeField(field, newType) {
  if (!field || !FIELD_TYPES.includes(newType)) return { ok: false, changed: false }
  if (field.type === newType) return { ok: true, changed: false }
  field.type = newType
  if (CHOICE_TYPES.includes(newType)) {
    if (!Array.isArray(field.options)) field.options = []
  } else {
    field.options = []
  }
  return { ok: true, changed: true }
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
// `edit_intent` choice. Unsure repeats the menu.
export const EDIT_INTENTS = ["name", "type", "options", "required", "remove", "done"]

export function editIntentFromAnswers(answers) {
  const hit = confidentChoice(answers?.intent, EDIT_INTENTS)
  if (hit) return { aspect: hit, usedFallback: [] }
  return { aspect: null, usedFallback: ["intent"] }
}

// The edit-menu choices, shown on screen (never read aloud): only lists
// options for choice fields, so users are never invited down a dead end.
export function editMenuChoices(field) {
  const aspects = CHOICE_TYPES.includes(field.type)
    ? ["name", "type", "options", "required", "remove", "done"]
    : ["name", "type", "required", "remove", "done"]
  return aspects.join(" · ")
}

// (Retype answers come from the `change_type` Jev step.)

// --- Stimulus controller: voice-only session ---------------------------------
// One mic (the command bar), one Done button. The system speaks each question,
// listens, and advances automatically from what the user says. No typing anywhere.
export default class extends Controller {
  static targets = ["question",
    "fieldList", "status", "voiceStatus", "stepHint",
    "choices"]

  connect() {
    this.fields = loadSchema()
    this.selectedId = null
    this.editing = false
    this.phase = "idle" // idle -> name -> options -> required_fields
    this.pending = null // field under construction
    this.recognition = null
    this.active = false
    this.awaiting = false
    // The key lives in the single top-level card — read fresh at session
    // start, never cached here.
    this.render()
    this.setQuestion("Say “create a new field” — I'll ask for each field.")
    this.setStatus(this.fields.length
      ? `${this.fields.length} field${this.fields.length === 1 ? "" : "s"}.`
      : "No fields yet.")
    this.updateButtons()
    // Global voice commands (Jev-routed): create a field or edit one by id.
    // The action and field id are Jev decisions — never parsed here.
    this.handleVoiceCommand = (event) => {
      const detail = event?.detail || {}
      if (detail.action !== "create" && detail.action !== "edit") return
      this.fields = loadSchema()
      if (detail.action === "edit") {
        const exists = (this.fields || []).some((f) => f.id === detail.fieldId)
        if (!exists) return
        this.selectedId = detail.fieldId
      } else {
        this.selectedId = null
      }
      this.render()
      if (this.active) this.stopSession()
      this.start()
    }
    window.addEventListener("syft:design-command", this.handleVoiceCommand)
    this.handleSessionStop = () => {
      if (!this.active) return
      this.stopSession()
      this.setStatus("Stopped.")
    }
    window.addEventListener("syft:session-stop", this.handleSessionStop)
  }

  disconnect() {
    this.stopSession()
    try { window.removeEventListener("syft:design-command", this.handleVoiceCommand) } catch { /* ignore */ }
    try { window.removeEventListener("syft:session-stop", this.handleSessionStop) } catch { /* ignore */ }
  }

  stopSession() {
    this.active = false
    this.awaiting = false
    try { this.recognition?.abort?.() } catch { /* ignore */ }
    try { this.recognition?.stop() } catch { /* ignore */ }
    try { window.speechSynthesis?.cancel() } catch { /* ignore */ }
    this.broadcastSession(false)
  }

  broadcastSession(on) {
    try { window.dispatchEvent(new CustomEvent("syft:session-active", { detail: { active: !!on } })) } catch { /* non-browser */ }
  }

  // --- session ------------------------------------------------------------------
  // Jev-only: without a key nothing can be decided, so voice commands refuse.
  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      this.setStatus("Voice not supported here — try Chrome or Edge.")
      return
    }
    if (!localStorage.getItem("syft_jev_key")) {
      this.setStatus("Add your Jev key first — every question here is answered by Jev.")
      return
    }
    if (this.active) return
    // One mic: starting here stops any session running elsewhere.
    try { window.dispatchEvent(new CustomEvent("syft:session-stop")) } catch { /* non-browser */ }
    this.active = true
    this.editing = false
    this.updateButtons()
    this.broadcastSession(true)
    // A tapped field means voice-editing; otherwise new-field interview.
    if (this.selectedField()) this.askEditMenu()
    else this.askName()
  }

  // Voice Done (via the finished session intent): asks the closing
  // required question when needed, then ends the session.
  done() {
    if (!this.active) return
    if (!this.fields.length) {
      this.endSession("Session ended — no fields.")
      return
    }
    // Fields are all there — one closing question, only about fields whose
    // required status was never decided (new since the last session).
    this.pending = null
    if (!fieldsNeedingRequired(this.fields).length) {
      this.endSession(`Session ended — ${this.fields.length} field${this.fields.length === 1 ? "" : "s"}, required already set.`)
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
    this.setChoices("")
    this.setStatus(status || `Session ended — ${this.fields.length} field${this.fields.length === 1 ? "" : "s"}.`)
    this.updateButtons()
  }

  // No session buttons — the mic lives in the command bar and sessions
  // start/end by voice. Kept because the session calls it throughout.
  updateButtons() { /* no buttons to enable */ }

  speak(text, onDone = null) {
    try {
      if (!window.speechSynthesis || !text) { onDone?.(); return }
      if (this.hasVoiceStatusTarget) this.voiceStatusTarget.textContent = "Speaking…"
      window.speechSynthesis.cancel()
      try { window.speechSynthesis.resume?.() } catch { /* ignore */ }
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

  // --- interview steps (each speaks, then listens) ------------------------------
  askName() {
    if (!this.active) return
    this.phase = "name"
    this.pending = null
    const n = this.fields.length + 1
    this.setHint("Say the field name, or “finished” to end.")
    this.setChoices("")
    this.sayThenListen(`What should field ${n} be called?`)
  }

  askOptions() {
    if (!this.active) return
    this.phase = "options"
    const count = (this.pending.options || []).length + 1
    this.setHint("Each option is added as heard. Say “done” when finished, “remove last” to undo.")
    this.setChoices((this.pending.options || []).join(" · "))
    this.sayThenListen(`“${this.pending.name}” — tell me option ${count}, or say “done”.`)
  }

  askRequiredFields() {
    if (!this.active) return
    const unasked = fieldsNeedingRequired(this.fields)
    if (!unasked.length) { this.endSession(); return }
    this.phase = "required_fields"
    this.setHint("Name the required ones, say “all”, or say “none”.")
    this.setChoices("")
    this.sayThenListen(`Which fields are required? Name them, or say all or none.`)
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

  // On-screen answer key for the current question. Spoken prompts never
  // list options aloud — the choices live here instead.
  setChoices(text) {
    if (this.hasChoicesTarget) this.choicesTarget.textContent = text
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
        this.setStatus("Mic blocked — allow microphone access, then try your voice command again.")
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

  // --- main router: every utterance goes to Jev; unsure repeats ---------------
  async handleTranscript(text) {
    if (!this.active) return
    if (this.phase === "name") return this.submitNameIntent(text)
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

  // Voice Done button: Jev decides whether the name prompt heard another
  // field name (next_field), the end of the session (finished), or an edit
  // of the last field — never word matching. Unsure repeats the question.
  async submitNameIntent(text) {
    const key = localStorage.getItem("syft_jev_key") || ""
    let merged = { intent: null, usedFallback: ["intent", "no-key"] }
    if (key) {
      try {
        const res = await fetch("/jev_design", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({
            step: "session_intent", transcript: text,
            field_count: this.fields.length, api_key: key,
          }),
        })
        const data = await res.json().catch(() => ({}))
        merged = sessionIntentFromAnswers(res.ok ? data.answers : {})
      } catch {
        merged = sessionIntentFromAnswers({})
      }
    }
    const intent = merged.intent
    if (!this.active) return
    if (!intent) {
      this.sayThenListen(`Sorry — what should field ${this.fields.length + 1} be called? Say the name, or “finished” to end.`)
      return
    }
    if (intent === "finished") return this.done()
    const last = this.fields[this.fields.length - 1]
    if (intent === "delete_last") {
      if (!last) {
        this.sayThenListen(`No fields yet. What should field 1 be called?`)
        return
      }
      this.fields = this.fields.slice(0, -1)
      saveSchema(this.fields)
      this.render()
      this.setStatus(`Removed “${last.name}”.`)
      this.askName()
      return
    }
    if (intent === "edit_last") {
      if (!last) {
        this.sayThenListen(`No fields yet. What should field 1 be called?`)
        return
      }
      this.selectedId = last.id
      this.render()
      this.askEditMenu()
      return
    }
    return this.submitName(text)
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
    const { type } = await this.classifyType(clean)
    if (!this.active) return
    // Jev decides the type from the name alone — never asked outright.
    // Unsure defaults to text; it can be retyped by voice when editing.
    this.pending.type = type || "text"
    if (CHOICE_TYPES.includes(this.pending.type)) this.askOptions()
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
    if (!key) return { type: null, usedFallback: ["field_type", "no-key"] }
    try {
      const res = await fetch("/jev_design", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
        body: JSON.stringify({ step: "classify", field_name: fieldName, api_key: key }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.answers) return { type: null, usedFallback: ["field_type", `http-${res.status}`] }
      return typeFromAnswers(data.answers)
    } catch {
      return { type: null, usedFallback: ["field_type", "connection"] }
    }
  }

  async submitOption(text) {
    const key = localStorage.getItem("syft_jev_key") || ""
    let merged = { intent: null, usedFallback: ["intent", "no-key"] }
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
        merged = optionIntentFromAnswers(res.ok ? data.answers : {})
      } catch {
        merged = optionIntentFromAnswers({})
      }
    }
    const intent = merged.intent
    if (!this.active) return
    if (!intent) {
      this.sayThenListen(`Sorry — say the next option, “done” to finish, or “remove last” to undo.`)
      return
    }
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
        merged = requiredFieldsFromAnswers(res.ok ? data.answers : {}, unasked)
      } catch {
        merged = requiredFieldsFromAnswers({}, unasked)
      }
    }
    if (merged.usedFallback.length) {
      this.sayThenListen(`Sorry — which fields are required? Name them, or say all or none.`)
      return
    }
    const wanted = new Set(merged.requiredIds)
    for (const f of unasked) {
      f.required = wanted.has(f.id)
      f.requiredDecided = true
    }
    saveSchema(this.fields)
    this.render()
    if (!this.active) return
    const names = unasked.filter((f) => f.required).map((f) => f.name)
    this.speak(names.length ? `Marked ${names.join(", ")} as required.` : "Nothing marked required.", () => {
      this.endSession()
    })
  }

  // --- tap a field, voice takes over -------------------------------------------------
  // Tapping a field starts the voice edit — no Start needed. Tapping the
  // selected field again only deselects it. While a session is already
  // active, tapping only moves the selection.
  selectField(event) {
    const id = event.currentTarget.dataset.id
    this.selectedId = this.selectedId === id ? null : id
    this.render()
    if (this.selectedId !== null) this.start()
  }

  selectedField() {
    return this.fields.find((f) => f.id === this.selectedId) || null
  }

  // Voice edit flow for the selected field: menu -> one aspect -> menu -> done.
  // The aspects and types stay on screen; speech asks without listing them.
  askEditMenu(note = "") {
    if (!this.active) return
    const field = this.selectedField()
    if (!field) { this.askName(); return }
    this.phase = "edit_menu"
    this.setHint("Say “done” to finish, or “remove” to delete the field.")
    this.setChoices(editMenuChoices(field))
    this.sayThenListen(`${note ? note + " " : ""}What should I change about ${field.name}?`)
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
    if (!this.active) return
    if (!aspect) {
      this.sayThenListen(`Sorry — what should I change?`)
      return
    }
    if (aspect === "remove") {
      this.fields = this.fields.filter((f) => f.id !== field.id)
      this.selectedId = null
      saveSchema(this.fields)
      this.render()
      this.speak(`Removed ${field.name}.`, () => this.endSession(`Removed “${field.name}”.`))
      return
    }
    if (aspect === "done") {
      this.selectedId = null
      this.endSession()
      return
    }
    if (aspect === "name") {
      this.phase = "edit_name"
      this.setChoices("")
      this.sayThenListen(`Say the new name for ${field.name}.`)
      return
    }
    if (aspect === "type") {
      this.phase = "edit_type"
      this.setChoices(FIELD_TYPES.join(" · "))
      this.sayThenListen(`What type should ${field.name} be?`)
      return
    }
    if (aspect === "required") {
      this.phase = "edit_required"
      this.setChoices("yes · no")
      this.sayThenListen(`Should ${field.name} be required?`)
      return
    }
    if (aspect === "options") {
      if (!CHOICE_TYPES.includes(field.type)) {
        this.sayThenListen(`${field.name} is not a choice field.`)
        this.phase = "edit_menu"
        return
      }
      this.pending = field
      this.editing = true
      this.askOptions()
      return
    }
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
    field.name = clean
    saveSchema(this.fields)
    this.render()
    this.askEditMenu(`Renamed to ${clean}.`)
  }

  async submitEditType(text) {
    const field = this.selectedField()
    if (!field) { this.askName(); return }
    this.setStatus("Checking the type with Jev…")
    const key = localStorage.getItem("syft_jev_key") || ""
    let typed = { type: null, usedFallback: ["field_type", "no-key"] }
    if (key) {
      try {
        const res = await fetch("/jev_design", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({ step: "change_type", transcript: text, field_name: field.name, api_key: key }),
        })
        const data = await res.json().catch(() => ({}))
        typed = typeFromAnswers(res.ok ? data.answers : {})
      } catch {
        typed = typeFromAnswers({})
      }
    }
    if (!this.active) return
    const type = typed.type
    if (!type) {
      this.sayThenListen(`Sorry — what type should ${field.name} be?`)
      return
    }
    retypeField(field, type)
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
    let merged = { required: null, usedFallback: ["required", "no-key"] }
    if (key) {
      try {
        const res = await fetch("/jev_design", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({ step: "required", transcript: text, field_name: field.name, api_key: key }),
        })
        const data = await res.json().catch(() => ({}))
        merged = requiredFromAnswers(res.ok ? data.answers : {})
      } catch {
        merged = requiredFromAnswers({})
      }
    }
    if (!this.active) return
    if (merged.required === null) {
      this.sayThenListen(`Sorry — should ${field.name} be required?`)
      return
    }
    const required = merged.required
    field.required = required
    field.requiredDecided = true
    saveSchema(this.fields)
    this.render()
    this.askEditMenu(required ? "Now required." : "Now optional.")
  }

  clearAll() {
    this.fields = []
    this.selectedId = null
    saveSchema(this.fields)
    this.setChoices("")
    this.render()
  }

  render() {
    if (!this.hasFieldListTarget) return
    this.fieldListTarget.innerHTML = this.fields.length
      ? this.fields.map((f, i) => fieldCardHtml(f, i, f.id === this.selectedId)).join("")
      : `<p style="font-size:12px;color:#a1a1aa;">No fields yet — say “create a new field”.</p>`
  }

}
