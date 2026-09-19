import { Controller } from "@hotwired/stimulus"

// Speech Insights: free in-browser transcription (Web Speech API) +
// near-real-time Jev analysis via POST /jev_analyze (Rails proxy).
//
// - API key stored in localStorage ("syft_jev_key"); verified keys in "syft_jev_key_ok".
// - Each metric toggle maps to Jev questions ("habits" fans out to 4 nouls); disabled metrics are not sent.
// - Auto-analyzes every time a sentence is finalized (last ~1400 chars only, keeps it fast/cheap).
// - Confidence < 0.5 renders as "uncertain" (nouls use distance from 0.5).
export default class extends Controller {
  static targets = [
    "apiKey", "apiKeyCard", "keyStatus", "testButton",
    "metric", "status", "supportWarning",
    "transcriptFinal", "transcriptInterim", "wordCount", "manualText",
    "cardFactualClaim", "cardSpecificity", "cardComplexity", "cardGrammar",
    "cardEmotion", "cardHabits",
    "timer", "waveform", "recordButton", "iconMic", "iconStop",
    "caption", "recorderCard", "metricsGrid", "transcriptCard",
    "footerNote",
  ]

  // Deterministic bar heights for the equalizer (fraction of full height).
  WAVE_LEVELS = [
    0.35, 0.6, 0.9, 0.5, 0.75, 0.4, 1.0, 0.55, 0.8, 0.35, 0.65, 0.95, 0.45,
    0.7, 0.5, 0.85, 0.4, 0.6, 1.0, 0.5, 0.75, 0.35, 0.65, 0.9, 0.45,
  ]

  SPECIFICITY_LABELS = [
    "Entirely vague",
    "Vague, no specifics",
    "Some concrete details",
    "Mostly concrete",
    "Highly specific",
  ]
  HABIT_LABELS = {
    filler: "Filler words",
    hedging: "Hedging",
    repetition: "Repetition",
    question_asked: "Asked a question",
  }
  COMPLEXITY_LABELS = [
    "Very simple",
    "Simple everyday language",
    "Moderately complex",
    "Complex",
    "Highly complex / academic",
  ]
  GRAMMAR_LABELS = [
    "Many errors",
    "Several noticeable errors",
    "Mostly correct, minor slips",
    "Fully correct",
  ]

  connect() {
    this.listening = false
    this.recognition = null
    this.finalText = ""
    this.analyzing = false
    this.lastAnalyzedText = ""
    this.elapsedSeconds = 0
    this.timerInterval = null

    this.apiKeyTarget.value = localStorage.getItem("syft_jev_key") || ""
    this.restoreToggles()
    this.apiKeyTarget.addEventListener("input", () => {
      localStorage.setItem("syft_jev_key", this.apiKeyTarget.value.trim())
      this.updateGate()
    })
    this.apiKeyTarget.addEventListener("paste", () => {
      // Value lands after the event; verify the pasted key automatically.
      setTimeout(() => {
        localStorage.setItem("syft_jev_key", this.apiKeyTarget.value.trim())
        this.testKey()
      }, 0)
    })
    this.updateGate()
    this.buildWaveform()
    this.updateTimer()
    this.updateWordCount()
    this.updateCardsVisibility()

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) this.supportWarningTarget.classList.remove("hidden")
  }

  disconnect() {
    this.stopRecognition()
  }

  // --- equalizer + timer ------------------------------------------------------
  buildWaveform() {
    if (!this.hasWaveformTarget) return
    this.waveformTarget.innerHTML = ""
    this.WAVE_LEVELS.forEach((level, i) => {
      const bar = document.createElement("span")
      bar.className = "wave-bar w-[3px] rounded-full bg-current"
      bar.style.height = `${Math.round(level * 100)}%`
      bar.style.animationDelay = `${(-i * 0.07).toFixed(2)}s`
      this.waveformTarget.appendChild(bar)
    })
  }

  startTimer() {
    this.stopTimer()
    this.timerInterval = setInterval(() => {
      this.elapsedSeconds += 1
      this.updateTimer()
    }, 1000)
  }

  stopTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval)
    this.timerInterval = null
  }

  updateTimer() {
    if (!this.hasTimerTarget) return
    const m = String(Math.floor(this.elapsedSeconds / 60)).padStart(2, "0")
    const s = String(this.elapsedSeconds % 60).padStart(2, "0")
    this.timerTarget.textContent = `${m}:${s}`
  }

  setRecordingUI(recording) {
    if (this.hasRecorderCardTarget) {
      this.recorderCardTarget.classList.toggle("recording", recording)
    }
    if (this.hasIconMicTarget) this.iconMicTarget.classList.toggle("hidden", recording)
    if (this.hasIconStopTarget) this.iconStopTarget.classList.toggle("hidden", !recording)
    if (this.hasCaptionTarget) {
      this.captionTarget.textContent = recording ? "Tap to stop" : "Tap to speak"
    }
    if (this.hasRecordButtonTarget) {
      this.recordButtonTarget.setAttribute(
        "aria-label", recording ? "Stop speaking" : "Start speaking"
      )
    }
  }

  // --- toggles ------------------------------------------------------------
  enabledMetrics() {
    return this.metricTargets.filter((c) => c.checked).map((c) => c.value)
  }

  metricsChanged(event) {
    const prefs = {}
    this.metricTargets.forEach((c) => { prefs[c.value] = c.checked })
    localStorage.setItem("syft_jev_metrics", JSON.stringify(prefs))
    this.updateCardsVisibility()
    this.analyzeNow()
  }

  restoreToggles() {
    try {
      const prefs = JSON.parse(localStorage.getItem("syft_jev_metrics") || "{}")
      this.metricTargets.forEach((c) => {
        if (prefs[c.value] !== undefined) c.checked = !!prefs[c.value]
      })
    } catch { /* keep defaults */ }
  }

  updateCardsVisibility() {
    const on = new Set(this.enabledMetrics())
    this.element.querySelectorAll("[data-metric-card]").forEach((card) => {
      card.style.opacity = on.has(card.dataset.metricCard) ? "1" : "0.35"
    })
  }

  // --- key ----------------------------------------------------------------
  // Recorder, metrics, and transcript stay hidden until a verified key
  // exists. Verified = this exact key passed Test (stored in
  // "syft_jev_key_ok"); editing the key or a 401 from Jev locks them again.
  // The explanation blocks below the key card are always shown.
  isKeyVerified() {
    const key = this.apiKeyTarget.value.trim()
    return key.length > 0 && localStorage.getItem("syft_jev_key_ok") === key
  }

  updateGate() {
    const ok = this.isKeyVerified()
    ;["recorderCard", "metricsGrid", "transcriptCard"].forEach((name) => {
      this[`${name}Target`].classList.toggle("hidden", !ok)
    })
    const anchor = ok ? this.footerNoteTarget : this.recorderCardTarget
    this.element.insertBefore(this.apiKeyCardTarget, anchor)
    if (!ok) {
      if (this.listening) this.stopRecognition()
      this.keyStatusTarget.textContent = this.apiKeyTarget.value.trim()
        ? "Tap Test to verify this key."
        : "Add your key to enable live analysis."
      this.keyStatusTarget.className = "text-xs mt-1 text-zinc-500 dark:text-zinc-400"
    }
  }

  toggleKeyVisibility() {
    this.apiKeyTarget.type = this.apiKeyTarget.type === "password" ? "text" : "password"
  }

  async testKey() {
    const key = this.apiKeyTarget.value.trim()
    if (!key) {
      this.keyStatusTarget.textContent = "Paste your key first."
      return
    }
    this.keyStatusTarget.textContent = "Testing…"
    try {
      const res = await this.postAnalyze("The Eiffel Tower is in Paris.", ["specificity"], key)
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        localStorage.setItem("syft_jev_key_ok", key)
        this.updateGate()
        this.keyStatusTarget.textContent = "✓ Key works."
        this.keyStatusTarget.className = "text-xs mt-1 text-emerald-600"
      } else {
        localStorage.removeItem("syft_jev_key_ok")
        this.updateGate()
        this.keyStatusTarget.textContent = `✗ ${this.upstreamError(data, res.status)}`
        this.keyStatusTarget.className = "text-xs mt-1 text-red-600"
      }
    } catch {
      this.keyStatusTarget.textContent = "✗ Could not reach the server."
      this.keyStatusTarget.className = "text-xs mt-1 text-red-600"
    }
  }

  // --- transcription (free, no key) ---------------------------------------
  toggleListening() {
    if (this.listening) {
      this.stopRecognition()
    } else {
      this.startRecognition()
    }
  }

  startRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      this.setStatus("Transcription not supported here — type below and Analyze now.")
      return
    }
    this.recognition = new SR()
    this.recognition.continuous = true
    this.recognition.interimResults = true
    this.recognition.lang = "en-US"

    this.recognition.onresult = (event) => {
      let interim = ""
      let heardSentence = false
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          this.finalText += transcript + " "
          heardSentence = true
        } else {
          interim += transcript
        }
      }
      this.transcriptFinalTarget.textContent = this.finalText
      this.transcriptInterimTarget.textContent = interim
      this.updateWordCount()
      if (heardSentence) this.analyzeNow()
    }
    this.recognition.onerror = (event) => {
      this.setStatus(`Mic error: ${event.error}`)
    }
    this.recognition.onend = () => {
      // Chrome stops after ~60s of silence; auto-restart while toggled on.
      if (this.listening) {
        try { this.recognition.start() } catch { /* already started */ }
      }
    }

    try {
      this.recognition.start()
      this.listening = true
      this.startTimer()
      this.setRecordingUI(true)
      this.setStatus("Listening… speak now.")
    } catch (e) {
      this.setStatus(`Could not start mic: ${e.message}`)
    }
  }

  stopRecognition() {
    this.listening = false
    this.stopTimer()
    this.setRecordingUI(false)
    if (this.recognition) {
      try { this.recognition.stop() } catch { /* ignore */ }
      this.recognition = null
    }
    this.setStatus("Idle")
    this.transcriptInterimTarget.textContent = ""
  }

  clearTranscript() {
    this.finalText = ""
    this.elapsedSeconds = 0
    this.updateTimer()
    this.transcriptFinalTarget.textContent = ""
    this.transcriptInterimTarget.textContent = ""
    this.manualTextTarget.value = ""
    this.updateWordCount()
    this.resetMetrics()
  }

  resetMetrics() {
    this.element.querySelectorAll("[data-metric-card]").forEach((card) => {
      card.querySelectorAll('[data-result="value"]').forEach((el) => {
        el.textContent = "—"
        el.className = el.className
          .replace("text-zinc-900", "text-zinc-300")
          .replace("dark:text-zinc-100", "dark:text-zinc-700")
      })
      card.querySelectorAll('[data-result="label"], [data-result="meta"]').forEach((el) => {
        el.textContent = ""
      })
      card.querySelectorAll('[data-result="bar"]').forEach((el) => {
        el.style.width = "0%"
      })
      card.querySelectorAll('[data-result="dist"], [data-result="flags"]').forEach((el) => {
        el.innerHTML = ""
      })
    })
    this.lastAnalyzedText = ""
  }

  useSample() {
    this.manualTextTarget.value =
      "Um, the Eiffel Tower is 330 meters tall and was completed in 1889, but honestly I feel like it might be the most overrated place on earth and it makes me kind of anxious, you know?"
    this.analyzeNow()
  }

  // --- analysis -------------------------------------------------------------
  currentText() {
    const manual = this.manualTextTarget.value.trim()
    if (manual) return manual
    return (this.finalText + " " + this.transcriptInterimTarget.textContent).trim()
  }

  async analyzeNow() {
    const metrics = this.enabledMetrics()
    const key = this.apiKeyTarget.value.trim()
    const state = this.currentText().slice(-1400)

    if (state.split(/\s+/).filter(Boolean).length < 3) return // too short
    if (!metrics.length) {
      this.setStatus("Enable at least one metric.")
      return
    }
    if (!key) {
      this.setStatus("Paste your Jev API key first.")
      return
    }
    if (this.analyzing || state === this.lastAnalyzedText) return
    this.analyzing = true
    this.setStatus("Analyzing…")

    try {
      const res = await this.postAnalyze(state, metrics, key)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 401) {
          // Key revoked or invalid — lock the interactive sections again.
          localStorage.removeItem("syft_jev_key_ok")
          this.updateGate()
          this.keyStatusTarget.textContent = "That key was rejected — check it and tap Test."
          this.keyStatusTarget.className = "text-xs mt-1 text-red-600"
        }
        this.setStatus(this.upstreamError(data, res.status))
        return
      }
      this.lastAnalyzedText = state
      this.renderAnswers(data.answers || {})
      const tokens = data.usage ? ` · ${data.usage.input_tokens} in-tokens` : ""
      this.setStatus(`Updated just now${tokens}`)
    } catch {
      this.setStatus("Analysis failed — check connection and try again.")
    } finally {
      this.analyzing = false
    }
  }

  postAnalyze(text, metrics, apiKey) {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content
    return fetch("/jev_analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ text, metrics, api_key: apiKey }),
    })
  }

  renderAnswers(answers) {
    if (answers.factual_claim) {
      this.renderNoul(this.cardFactualClaimTarget, answers.factual_claim,
        "States a checkable fact", "No checkable fact")
    }
    if (answers.specificity) this.renderScore(this.cardSpecificityTarget, answers.specificity, 4, this.SPECIFICITY_LABELS)
    if (answers.complexity) this.renderScore(this.cardComplexityTarget, answers.complexity, 4, this.COMPLEXITY_LABELS)
    if (answers.grammar) this.renderScore(this.cardGrammarTarget, answers.grammar, 3, this.GRAMMAR_LABELS)
    if (answers.emotion) this.renderChoice(this.cardEmotionTarget, answers.emotion)
    if (answers.filler || answers.hedging || answers.repetition || answers.question_asked) {
      this.renderHabits(this.cardHabitsTarget, answers)
    }
  }

  // Below 0.5 the model is guessing — show it muted and say so.
  setUncertain(card, uncertain, confidence) {
    card.querySelector('[data-result="meta"]').textContent =
      `confidence ${this.pct(confidence)}${uncertain ? " · uncertain" : ""}`
    return uncertain
  }

  valueClass(code) {
    return code
      ? "mt-1 text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100"
      : "mt-1 text-3xl font-semibold tabular-nums text-zinc-300 dark:text-zinc-700"
  }

  renderScore(card, answer, max, labels) {
    const score = Number(answer.score)
    const idx = Math.max(0, Math.min(max, Math.round(score)))
    const uncertain = (answer.confidence ?? 1) < 0.5
    card.querySelector('[data-result="value"]').textContent = score.toFixed(2)
    card.querySelector('[data-result="value"]').className = this.valueClass(!uncertain)
    card.querySelector('[data-result="label"]').textContent = labels[idx] || ""
    card.querySelector('[data-result="bar"]').style.width = `${(score / max) * 100}%`
    this.setUncertain(card, uncertain, answer.confidence)
  }

  renderNoul(card, answer, yesLabel, noLabel) {
    const p = Number(answer.noul)
    const yes = p >= 0.5
    const confidence = Math.abs(p - 0.5) * 2 // Nouls carry no confidence field
    const uncertain = confidence < 0.5
    card.querySelector('[data-result="value"]').textContent = yes ? "Yes" : "No"
    card.querySelector('[data-result="value"]').className = this.valueClass(!uncertain)
    card.querySelector('[data-result="label"]').textContent = yes ? yesLabel : noLabel
    card.querySelector('[data-result="bar"]').style.width = `${p * 100}%`
    this.setUncertain(card, uncertain, confidence)
  }

  renderHabits(card, answers) {
    const keys = Object.keys(this.HABIT_LABELS).filter((k) => answers[k])
    const flags = card.querySelector('[data-result="flags"]')
    flags.innerHTML = ""
    let n = 0
    keys.forEach((k) => {
      const p = Number(answers[k].noul)
      const yes = p >= 0.5
      if (yes) n += 1
      const row = document.createElement("div")
      row.className = "flex items-center gap-2"
      row.innerHTML =
        `<span class="flex-grow">${this.HABIT_LABELS[k]}</span>` +
        `<span class="font-medium ${yes ? "text-zinc-900 dark:text-zinc-100" : ""}">${yes ? "Yes" : "No"}</span>` +
        `<span class="w-10 text-right tabular-nums">${this.pct(Math.max(p, 1 - p))}</span>`
      flags.appendChild(row)
    })
    card.querySelector('[data-result="value"]').textContent = n ? `${n} flagged` : "None"
    card.querySelector('[data-result="value"]').className = this.valueClass(true)
    card.querySelector('[data-result="meta"]').textContent =
      keys.length ? `${n} of ${keys.length} habits flagged` : ""
  }

  renderChoice(card, answer) {
    const uncertain = (answer.confidence ?? 1) < 0.5
    card.querySelector('[data-result="value"]').textContent = answer.choice || "—"
    card.querySelector('[data-result="value"]').className =
      "mt-1 text-3xl font-semibold capitalize " +
      (uncertain ? "text-zinc-300 dark:text-zinc-700" : "text-zinc-900 dark:text-zinc-100")
    const dist = card.querySelector('[data-result="dist"]')
    dist.innerHTML = ""
    const probs = answer.probabilities || {}
    Object.entries(probs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .forEach(([label, p]) => {
        const row = document.createElement("div")
        row.className = "flex items-center gap-2"
        row.innerHTML =
          `<span class="w-20 capitalize">${label}</span>` +
          `<div class="flex-grow h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800"><div class="h-1.5 rounded-full bg-zinc-900 dark:bg-zinc-100" style="width:${p * 100}%"></div></div>` +
          `<span class="w-10 text-right tabular-nums">${this.pct(p)}</span>`
        dist.appendChild(row)
      })
    this.setUncertain(card, uncertain, answer.confidence)
  }

  // --- helpers ---------------------------------------------------------------
  // Jev error bodies carry the reason in `error` or `detail` (a 422's
  // validation messages live in `detail`) — surface it, don't swallow it.
  upstreamError(data, status) {
    if (data.error) return data.error
    if (data.detail !== undefined) {
      try {
        const text = JSON.stringify(data.detail)
        return text.length > 300 ? `${text.slice(0, 300)}…` : text
      } catch { /* fall through to generic message */ }
    }
    return `Jev error (HTTP ${status})`
  }

  setStatus(msg) {
    if (this.hasStatusTarget) this.statusTarget.textContent = msg
  }

  pct(x) {
    return x === undefined || x === null ? "—" : `${Math.round(Number(x) * 100)}%`
  }

  updateWordCount() {
    const n = this.currentText().split(/\s+/).filter(Boolean).length
    if (this.hasWordCountTarget) this.wordCountTarget.textContent = n ? `· ${n} words` : ""
  }
}
