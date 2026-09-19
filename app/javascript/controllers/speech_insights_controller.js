import { Controller } from "@hotwired/stimulus"

// Speech Insights: free in-browser transcription (Web Speech API) +
// near-real-time Jev analysis via POST /jev_analyze (Rails proxy).
//
// - API key stored in localStorage ("syft_jev_key"), never in the DB.
// - Each metric toggle maps to one Jev question; disabled metrics are not sent.
// - Auto-analyzes every time a sentence is finalized (last ~1400 chars only, keeps it fast/cheap).
export default class extends Controller {
  static targets = [
    "apiKey", "apiKeyCard", "keyStatus", "testButton",
    "metric", "status", "supportWarning",
    "transcriptFinal", "transcriptInterim", "wordCount", "manualText",
    "cardFactual", "cardComplexity", "cardGrammar", "cardEmotion",
    "timer", "waveform", "recordButton", "iconMic", "iconStop",
    "caption", "recorderCard", "footerNote",
  ]

  // Deterministic bar heights for the equalizer (fraction of full height).
  WAVE_LEVELS = [
    0.35, 0.6, 0.9, 0.5, 0.75, 0.4, 1.0, 0.55, 0.8, 0.35, 0.65, 0.95, 0.45,
    0.7, 0.5, 0.85, 0.4, 0.6, 1.0, 0.5, 0.75, 0.35, 0.65, 0.9, 0.45,
  ]

  FACTUAL_LABELS = [
    "Pure opinion / no verifiable facts",
    "Mostly opinion, vague facts",
    "Mix of opinion and plausible facts",
    "Mostly specific, verifiable claims",
    "Highly factual and precise",
  ]
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
      this.placeKeyCard()
    })
    this.placeKeyCard()
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
    ;["Factual", "Complexity", "Grammar", "Emotion"].forEach((name) => {
      const card = this[`card${name}Target`]
      if (!card) return
      card.style.opacity = on.has(name.toLowerCase()) ? "1" : "0.35"
    })
  }

  // --- key ----------------------------------------------------------------
  // No key yet: pin the key card to the top so it's the first thing you see.
  // Once a key is entered, tuck it back down above the footer.
  placeKeyCard() {
    const hasKey = this.apiKeyTarget.value.trim().length > 0
    const anchor = hasKey ? this.footerNoteTarget : this.recorderCardTarget
    this.element.insertBefore(this.apiKeyCardTarget, anchor)
    if (!hasKey) this.keyStatusTarget.textContent = "Add your key to enable live analysis."
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
      const res = await this.postAnalyze("The Eiffel Tower is in Paris.", ["factual"], key)
      if (res.ok) {
        this.keyStatusTarget.textContent = "✓ Key works."
        this.keyStatusTarget.className = "text-xs mt-1 text-emerald-600"
      } else {
        const data = await res.json().catch(() => ({}))
        this.keyStatusTarget.textContent = `✗ ${data.error || `HTTP ${res.status}`}`
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
  }

  useSample() {
    this.manualTextTarget.value =
        "The Eiffel Tower is 330 meters tall and was completed in 1889, but honestly I feel like it might be the most overrated place on earth and it makes me kind of anxious."
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
        this.setStatus(data.error || `Jev error (HTTP ${res.status})`)
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
    if (answers.factual) this.renderScore(this.cardFactualTarget, answers.factual, 4, this.FACTUAL_LABELS)
    if (answers.complexity) this.renderScore(this.cardComplexityTarget, answers.complexity, 4, this.COMPLEXITY_LABELS)
    if (answers.grammar) this.renderScore(this.cardGrammarTarget, answers.grammar, 3, this.GRAMMAR_LABELS)
    if (answers.emotion) this.renderChoice(this.cardEmotionTarget, answers.emotion)
  }

  renderScore(card, answer, max, labels) {
    const score = Number(answer.score)
    const idx = Math.max(0, Math.min(max, Math.round(score)))
    card.querySelector('[data-result="value"]').textContent = score.toFixed(2)
    card.querySelector('[data-result="value"]').className =
      "mt-1 text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100"
    card.querySelector('[data-result="label"]').textContent = labels[idx] || ""
    card.querySelector('[data-result="bar"]').style.width = `${(score / max) * 100}%`
    card.querySelector('[data-result="meta"]').textContent =
      `confidence ${this.pct(answer.confidence)}`
  }

  renderChoice(card, answer) {
    card.querySelector('[data-result="value"]').textContent = answer.choice || "—"
    card.querySelector('[data-result="value"]').className =
      "mt-1 text-3xl font-semibold capitalize text-zinc-900 dark:text-zinc-100"
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
    card.querySelector('[data-result="meta"]').textContent =
      `confidence ${this.pct(answer.confidence)}`
  }

  // --- helpers ---------------------------------------------------------------
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
