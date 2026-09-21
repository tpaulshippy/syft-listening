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

// Offline keyword fallback for type classification (no key / low confidence).
export function fallbackType(fieldName) {
  const p = String(fieldName || "").toLowerCase()
  if (/(email|e-mail)/.test(p)) return "email"
  if (/(birthday|birth|due date|deadline|date|day|month|year)/.test(p)) return "date"
  if (/(time|alarm|hour|minute|meeting at)/.test(p)) return "time"
  if (/(how many|amount|count|(-|^)(number|qty|quantity|price|cost|total|age|minutes|km|units)|number of)/.test(p)) return "number"
  if (/(yes[\s-]?no|true[\s-]?false|agree|confirm)/.test(p)) return "yes_no"
  if (/(pick several|choose several|select several|multiple|check all)/.test(p)) return "choice_multiple"
  if (/(pick|choose|select|option|category|genre|status|kind|type of)/.test(p)) return "choice_single"
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
  const p = String(transcript || "").toLowerCase().trim()
  if (/^(done|finished|that'?s all|next|no more)/.test(p)) return { intent: "done_options", usedFallback: ["intent"] }
  if (/^(remove|undo|delete|drop)( that| it| last)?$/.test(p)) return { intent: "remove_last", usedFallback: ["intent"] }
  return { intent: "add_option", usedFallback: ["intent"] }
}

export function requiredFromAnswers(answers, transcript) {
  const hit = noulBool(answers?.required)
  if (hit !== null) return { required: hit, usedFallback: [] }
  const p = String(transcript || "").toLowerCase()
  if (/(required|must|mandatory|yes)/.test(p)) return { required: true, usedFallback: ["required"] }
  return { required: false, usedFallback: ["required"] }
}

export function sessionIntentFromAnswers(answers, transcript) {
  const hit = confidentChoice(answers?.intent, SESSION_INTENTS)
  if (hit) return { intent: hit, usedFallback: [] }
  const p = String(transcript || "").toLowerCase().trim()
  if (/^(finished|done|that'?s all|complete)/.test(p)) return { intent: "finished", usedFallback: ["intent"] }
  if (/^(delete|remove) (last|that|it)/.test(p)) return { intent: "delete_last", usedFallback: ["intent"] }
  if (/^(edit|rename) (last|that|it)/.test(p)) return { intent: "edit_last", usedFallback: ["intent"] }
  return { intent: "next_field", usedFallback: ["intent"] }
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

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

export function fieldCardHtml(field, index) {
  const opts = CHOICE_TYPES.includes(field.type) && field.options?.length
    ? `<div style="font-size:11px;color:#52525b;margin-top:4px;">options: ${field.options.map(escapeHtml).join(" · ")}</div>`
    : ""
  return `<div style="border:1px solid #e4e4e7;border-radius:12px;padding:10px;" data-field-id="${escapeHtml(field.id)}">` +
    `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;">` +
    `<strong style="font-size:13px;">${index + 1}. ${escapeHtml(field.name)}</strong>` +
    `<span style="font-size:11px;color:#71717a;">${escapeHtml(field.type)}${field.required ? " · required" : ""}</span></div>${opts}` +
    `<div style="display:flex;gap:6px;margin-top:8px;font-size:11px;">` +
    `<button data-action="click->design#removeField" data-id="${escapeHtml(field.id)}" style="border:1px solid #e4e4e7;border-radius:999px;padding:2px 10px;">Remove</button>` +
    `<button data-action="click->design#toggleRequired" data-id="${escapeHtml(field.id)}" style="border:1px solid #e4e4e7;border-radius:999px;padding:2px 10px;">${field.required ? "Make optional" : "Make required"}</button>` +
    `</div></div>`
}

// --- Stimulus controller: interview driver ---------------------------------
export default class extends Controller {
  static targets = ["question", "fieldName", "answer", "micButton", "askButton",
    "fieldList", "status", "inspector", "voiceStatus", "apiKey", "keyStatus", "stepHint"]

  connect() {
    this.fields = loadSchema()
    this.phase = "name" // name -> options -> required -> done
    this.pending = null // field under construction
    this.recognition = null
    this.listening = false
    const stored = localStorage.getItem("syft_jev_key") || ""
    if (this.hasApiKeyTarget) {
      this.apiKeyTarget.value = stored
      this.apiKeyTarget.addEventListener("input", () => {
        localStorage.setItem("syft_jev_key", this.apiKeyTarget.value.trim())
      })
    }
    this.render()
    this.askName()
  }

  disconnect() {
    try { this.recognition?.stop() } catch { /* ignore */ }
    try { window.speechSynthesis?.cancel() } catch { /* ignore */ }
  }

  speak(text) {
    try {
      if (!window.speechSynthesis || !text) return
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = "en-US"
      window.speechSynthesis.speak(u)
    } catch { /* nice-to-have only */ }
  }

  // --- interview steps ------------------------------------------------------
  askName() {
    this.phase = "name"
    this.pending = null
    const n = this.fields.length + 1
    this.setQuestion(`What should field ${n} be called?`)
    this.setHint("Speak or type the field name, then Add field.")
    if (this.hasFieldNameTarget) {
      this.fieldNameTarget.value = ""
      this.fieldNameTarget.focus?.()
    }
  }

  askOptions() {
    this.phase = "options"
    const count = (this.pending.options || []).length + 1
    this.setQuestion(`“${this.pending.name}” — dictate option ${count}, or say “done”.`)
    this.setHint("Each option is added verbatim. Say “done” when finished, “remove last” to undo.")
    if (this.hasAnswerTarget) this.answerTarget.value = ""
  }

  askRequired() {
    this.phase = "required"
    this.setQuestion(`Is “${this.pending.name}” required?`)
    this.setHint("Say “yes, required” or “no, optional”.")
    if (this.hasAnswerTarget) this.answerTarget.value = ""
  }

  setQuestion(text) {
    if (this.hasQuestionTarget) this.questionTarget.textContent = text
    this.speak(text)
  }

  setHint(text) {
    if (this.hasStepHintTarget) this.stepHintTarget.textContent = text
  }

  setStatus(text) {
    if (this.hasStatusTarget) this.statusTarget.textContent = text
  }

  // --- main submit: routes by interview phase --------------------------------
  async submit() {
    if (this.phase === "name") return this.submitName()
    const text = this.hasAnswerTarget ? this.answerTarget.value.trim() : ""
    if (!text) { this.setStatus("Speak or type an answer first."); return }
    if (this.phase === "options") return this.submitOption(text)
    if (this.phase === "required") return this.submitRequired(text)
  }

  async submitName() {
    const name = this.hasFieldNameTarget ? this.fieldNameTarget.value.trim() : ""
    const err = validateFieldName(name, this.fields)
    if (err) { this.setStatus(err); return }
    if (this.fields.length >= MAX_FIELDS) { this.setStatus(`Field cap reached (${MAX_FIELDS}). Remove one to add more.`); return }
    this.pending = { id: `f${Date.now().toString(36)}`, name, type: "text", required: false, options: [] }
    this.setStatus("Classifying type with Jev…")
    const { type, usedFallback } = await this.classifyType(name)
    this.pending.type = type
    this.logInspector(`field_type = ${type}${usedFallback.length ? " · fallback" : ""}`)
    if (CHOICE_TYPES.includes(type)) this.askOptions()
    else this.askRequired()
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
    if (intent === "done_options") {
      if (!(this.pending.options || []).length) { this.setStatus("Add at least one option, or remove the field."); return }
      this.askRequired()
    } else if (intent === "remove_last") {
      this.pending.options.pop()
      this.setStatus("Removed the last option.")
      this.askOptions()
    } else {
      const r = addOption(this.pending, text)
      this.setStatus(r.ok ? `Added “${text}”.` : r.reason === "duplicate" ? "Already have that option — try another." : r.reason === "capped" ? `Option cap (${MAX_OPTIONS}) reached — say “done”.` : "Could not add that option.")
      if (r.ok || r.reason === "duplicate") this.askOptions()
    }
    if (this.hasAnswerTarget) this.answerTarget.value = ""
  }

  async submitRequired(text) {
    const key = localStorage.getItem("syft_jev_key") || ""
    let required = /required|must|mandatory/.test(text.toLowerCase()) && !/optional|not/.test(text.toLowerCase())
    let fb = ["required", "no-key"]
    if (key) {
      try {
        const res = await fetch("/jev_design", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
          body: JSON.stringify({ step: "required", transcript: text, field_name: this.pending.name, api_key: key }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok && data.answers) {
          const m = requiredFromAnswers(data.answers, text)
          required = m.required
          fb = m.usedFallback
        } else {
          required = requiredFromAnswers({}, text).required
        }
      } catch {
        required = requiredFromAnswers({}, text).required
      }
    } else {
      required = requiredFromAnswers({}, text).required
    }
    this.logInspector(`required = ${required}${fb.length ? " · fallback" : ""}`)
    this.pending.required = required
    this.fields.push(this.pending)
    saveSchema(this.fields)
    this.setStatus(`Added “${this.pending.name}” (${this.pending.type}).`)
    this.render()
    this.askName()
    if (this.hasAnswerTarget) this.answerTarget.value = ""
  }

  // --- field list management --------------------------------------------------
  removeField(event) {
    const id = event.currentTarget.dataset.id
    this.fields = this.fields.filter((f) => f.id !== id)
    saveSchema(this.fields)
    this.render()
    this.askName()
  }

  toggleRequired(event) {
    const id = event.currentTarget.dataset.id
    const f = this.fields.find((x) => x.id === id)
    if (f) { f.required = !f.required; saveSchema(this.fields); this.render() }
  }

  clearAll() {
    this.fields = []
    saveSchema(this.fields)
    this.render()
    this.askName()
  }

  render() {
    if (!this.hasFieldListTarget) return
    this.fieldListTarget.innerHTML = this.fields.length
      ? this.fields.map((f, i) => fieldCardHtml(f, i)).join("")
      : `<p style="font-size:12px;color:#a1a1aa;">No fields yet — answer above to add the first.</p>`
    if (this.hasStatusTarget && !this.hasPendingGuard()) {
      // keep current status; just update counts in hint
    }
  }

  hasPendingGuard() { return false }

  logInspector(line) {
    if (!this.hasInspectorTarget) return
    const div = document.createElement("div")
    div.textContent = line
    this.inspectorTarget.prepend(div)
  }

  // --- voice (Web Speech API in, speechSynthesis out) --------------------------
  toggleVoice() {
    if (this.listening) { try { this.recognition?.stop() } catch { /* ignore */ } return }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      if (this.hasVoiceStatusTarget) this.voiceStatusTarget.textContent = "Voice not supported here — type instead."
      return
    }
    const target = this.phase === "name" && this.hasFieldNameTarget ? this.fieldNameTarget : this.hasAnswerTarget ? this.answerTarget : null
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
      if (target) target.value = (finalText + interim).trim()
      if (this.hasVoiceStatusTarget) this.voiceStatusTarget.textContent = interim ? `Hearing: “${interim}…”` : `Heard: “${finalText.trim()}”`
    }
    this.recognition.onerror = (event) => {
      this.listening = false
      if (this.hasVoiceStatusTarget) this.voiceStatusTarget.textContent = `Mic error: ${event.error} — type instead.`
    }
    this.recognition.onend = () => {
      this.listening = false
      if (this.hasMicButtonTarget) this.micButtonTarget.style.background = ""
      const heard = target?.value.trim()
      if (this.hasVoiceStatusTarget) this.voiceStatusTarget.textContent = heard ? `Heard: “${heard}”` : "Didn't catch that — try again or type."
      if (heard) this.submit()
    }
    try {
      this.recognition.start()
      this.listening = true
      if (this.hasMicButtonTarget) this.micButtonTarget.style.background = "#dc2626"
      if (this.hasVoiceStatusTarget) this.voiceStatusTarget.textContent = "Listening…"
    } catch (e) {
      if (this.hasVoiceStatusTarget) this.voiceStatusTarget.textContent = `Could not start mic: ${e.message}`
    }
  }

  answerKeydown(event) {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); this.submit() }
  }
}
