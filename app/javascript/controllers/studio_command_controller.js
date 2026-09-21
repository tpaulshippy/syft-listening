import { Controller } from "@hotwired/stimulus"

// Global voice command bar for /studio: one mic drives every tab.
// The transcript is never inspected here — it rides verbatim to
// POST /jev_command, and Jev decides the destination tab plus the
// design field / input row targets. Routing below only decodes Jev's
// confident choices (same positional style as refToName's col slicing);
// anything unsure repeats instead of guessing.

export const DESTINATIONS = ["design", "input", "visualize"]
export const DESIGN_NEW = "new_field"
export const DESIGN_NONE = "none"
export const ROW_NEW = "new_row"
export const ROW_NONE = "none"
export const MAX_COMMAND_ROWS = 50

function confidentChoice(answer, allowed) {
  const conf = Number(answer?.confidence ?? NaN)
  if (answer?.choice && allowed.includes(answer.choice) && conf >= 0.5) return answer.choice
  return null
}

function rowRef(index) {
  return "row_" + String(index + 1)
}

// Jev-only merger over the router answers. fieldIds are the known design
// field ids; rowCount bounds the row_N options. Returns the decoded
// routing plus which keys fell back (unsure repeats).
export function commandFromAnswers(answers, fieldIds = [], rowCount = 0) {
  const usedFallback = []
  const ids = Array.isArray(fieldIds) ? fieldIds : []
  const n = Math.max(0, Math.min(MAX_COMMAND_ROWS, Number(rowCount) || 0))

  const destination = confidentChoice(answers?.destination, DESTINATIONS)
  if (!destination) usedFallback.push("destination")

  const designAllowed = [DESIGN_NEW, DESIGN_NONE, ...ids]
  const designTarget = confidentChoice(answers?.design_target, designAllowed)
  if (!designTarget) usedFallback.push("design_target")

  const rowAllowed = [ROW_NEW, ROW_NONE]
  for (let i = 0; i < n; i++) rowAllowed.push(rowRef(i))
  const rowTarget = confidentChoice(answers?.row_target, rowAllowed)
  if (!rowTarget) usedFallback.push("row_target")

  let fieldId = null
  let newField = false
  if (designTarget && designTarget !== DESIGN_NEW && designTarget !== DESIGN_NONE) fieldId = designTarget
  if (designTarget === DESIGN_NEW) newField = true

  let rowIndex = null
  let newRow = false
  if (rowTarget === ROW_NEW) {
    newRow = true
  } else if (rowTarget && rowTarget !== ROW_NONE && rowTarget.slice(0, 4) === "row_") {
    const num = Number(rowTarget.slice(4))
    if (Number.isInteger(num) && num >= 1 && num <= n) rowIndex = num - 1
  }

  return { destination, fieldId, newField, rowIndex, newRow, usedFallback }
}

function readSchema() {
  try {
    const parsed = JSON.parse(localStorage.getItem("syft_design_schema") || "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.filter((f) => f && typeof f.id === "string" && typeof f.name === "string")
  } catch {
    return []
  }
}

function readRowCount() {
  try {
    const parsed = JSON.parse(localStorage.getItem("syft_input_rows") || "[]")
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

export default class extends Controller {
  static targets = ["micButton", "status"]

  connect() {
    this.recognition = null
    this.listening = false
    // Loop mode: one tap starts an ongoing conversation. The mic restarts
    // itself after every utterance and pauses while a tab session owns the
    // mic (two recognitions can't run at once) — resuming when it ends.
    this.loop = false
    this.tabSessionActive = false
    this.handleSessionActive = (event) => {
      const on = !!event?.detail?.active
      this.tabSessionActive = on
      if (on) {
        // A tab session just took the mic — yield it immediately.
        try { this.recognition?.abort?.() } catch { /* ignore */ }
        this.listening = false
        return
      }
      if (this.loop && !this.listening) this.resumeLoop("Listening… (tap 🎙 to stop)")
    }
    window.addEventListener("syft:session-active", this.handleSessionActive)
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR && this.hasStatusTarget) {
      this.statusTarget.textContent = "Voice commands need Chrome or Edge — tabs still work by tap."
    }
  }

  disconnect() {
    this.loop = false
    try { this.recognition?.stop() } catch { /* ignore */ }
    try { window.removeEventListener("syft:session-active", this.handleSessionActive) } catch { /* ignore */ }
  }

  currentTab() {
    try {
      const active = document.querySelector('[data-studio-tabs-target="tab"][aria-selected="true"]')
      const name = active?.dataset?.tab
      if (DESTINATIONS.includes(name)) return name
    } catch { /* ignore */ }
    return "design"
  }

  showTab(name) {
    if (!DESTINATIONS.includes(name)) return
    const btn = document.querySelector(`[data-studio-tabs-target="tab"][data-tab="${name}"]`)
    if (btn) btn.click()
  }

  dispatch(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })) } catch { /* non-browser */ }
  }

  setStatus(text) {
    if (this.hasStatusTarget) this.statusTarget.textContent = text
  }

  toggleVoice() {
    if (this.loop) {
      this.stopLoop()
      // The mic is the global stop: a tab session owns its own mic, so
      // tell it to stop too.
      this.dispatch("syft:session-stop")
      return
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      this.setStatus("Voice not supported here — tap a tab instead.")
      return
    }
    const key = localStorage.getItem("syft_jev_key") || ""
    if (!key) {
      this.setStatus("Add your Jev key first — every command is routed by Jev.")
      return
    }
    // Warm up speech output inside the tap gesture — mobile browsers gate
    // it, and a cold engine stalls the first question for seconds.
    try {
      window.speechSynthesis?.cancel()
      window.speechSynthesis?.getVoices()
    } catch { /* ignore */ }
    this.loop = true
    if (this.hasMicButtonTarget) this.micButtonTarget.style.background = "#dc2626"
    this.startCycle()
  }

  stopLoop() {
    this.loop = false
    try { this.recognition?.stop() } catch { /* ignore */ }
    this.listening = false
    if (this.hasMicButtonTarget) this.micButtonTarget.style.background = ""
    this.setStatus("Stopped. Tap 🎙 to start.")
  }

  resumeLoop(status) {
    if (!this.loop || this.listening || this.tabSessionActive) return
    if (status) this.setStatus(status)
    setTimeout(() => this.startCycle(), 350)
  }

  startCycle() {
    if (!this.loop || this.listening || this.tabSessionActive) return
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      this.stopLoop()
      this.setStatus("Voice not supported here — tap a tab instead.")
      return
    }
    const key = localStorage.getItem("syft_jev_key") || ""
    if (!key) {
      this.stopLoop()
      this.setStatus("Add your Jev key first — every command is routed by Jev.")
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
      const heard = (finalText + interim).trim()
      this.setStatus(heard ? `Heard: “${heard}”` : "Listening… (tap 🎙 to stop)")
    }
    this.recognition.onerror = (event) => {
      // A blocked mic never recovers by retrying — stop the loop instead.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this.stopLoop()
        this.setStatus("Mic blocked — allow microphone access, then tap 🎙.")
      }
      // Other errors fall through to onend, which restarts the loop.
    }
    this.recognition.onend = () => {
      this.listening = false
      if (!this.loop) return
      const heard = finalText.trim()
      const run = async () => {
        if (heard) await this.handleCommand(heard)
        else this.setStatus("Didn't catch that — listening…")
        // A routed tab session pauses the loop (see syft:session-active);
        // otherwise keep the conversation going with no new tap.
        this.resumeLoop()
      }
      run()
    }
    try {
      this.recognition.start()
      this.listening = true
      this.setStatus("Listening… (tap 🎙 to stop)")
    } catch {
      this.listening = false
      this.resumeLoop()
    }
  }

  async handleCommand(transcript) {
    const key = localStorage.getItem("syft_jev_key") || ""
    if (!key) {
      this.setStatus("Add your Jev key first — every command is routed by Jev.")
      return
    }
    const schema = readSchema()
    const rowCount = readRowCount()
    const columns = schema.map((f) => f.name)
    this.setStatus(`Heard: “${transcript}” — asking Jev where it goes…`)
    let answers = null
    try {
      const res = await fetch("/jev_command", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
        body: JSON.stringify({
          transcript,
          current_tab: this.currentTab(),
          fields: schema.map((f) => ({ id: f.id, name: f.name })),
          row_count: rowCount,
          columns,
          api_key: key,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) {
        localStorage.removeItem("syft_jev_key_ok")
        this.setStatus("Key rejected — check it and try again.")
        return
      }
      if (!res.ok || !data.answers) {
        this.setStatus(`Jev error (HTTP ${res.status}) — try again or tap a tab.`)
        return
      }
      answers = data.answers
    } catch {
      this.setStatus("Could not reach Jev — try again or tap a tab.")
      return
    }
    const merged = commandFromAnswers(answers, schema.map((f) => f.id), rowCount)
    if (!merged.destination) {
      this.setStatus("Jev wasn't sure where that goes — rephrase and try again.")
      return
    }
    this.routeCommand(transcript, merged)
  }

  routeCommand(transcript, merged) {
    const { destination, fieldId, newField, rowIndex, newRow } = merged
    this.showTab(destination)
    if (destination === "design") {
      if (newField) {
        this.setStatus(`Heard: “${transcript}” — Design: new field.`)
        this.dispatch("syft:design-command", { action: "create" })
      } else if (fieldId) {
        this.setStatus(`Heard: “${transcript}” — Design: editing that field.`)
        this.dispatch("syft:design-command", { action: "edit", fieldId })
      } else {
        this.setStatus(`Heard: “${transcript}” — on Design. Say what to add or change.`)
      }
      return
    }
    if (destination === "input") {
      if (newRow) {
        this.setStatus(`Heard: “${transcript}” — Input: new row.`)
        this.dispatch("syft:input-command", { action: "add" })
      } else if (rowIndex !== null && rowIndex !== undefined) {
        this.setStatus(`Heard: “${transcript}” — Input: editing row ${rowIndex + 1}.`)
        this.dispatch("syft:input-command", { action: "edit", rowIndex })
      } else {
        this.setStatus(`Heard: “${transcript}” — on Input. Say what to add or change.`)
      }
      return
    }
    this.setStatus(`Heard: “${transcript}” — Visualize: building…`)
    this.dispatch("syft:visualize-command", { prompt: transcript })
  }
}
