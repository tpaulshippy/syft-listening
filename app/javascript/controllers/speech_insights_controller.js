import { Controller } from "@hotwired/stimulus"

// Speech Insights: free in-browser transcription (Web Speech API) +
// near-real-time Jev analysis via POST /jev_analyze (Rails proxy).
//
// - API key stored in localStorage ("syft_jev_key"); verified keys in "syft_jev_key_ok".
// - Each metric toggle maps to Jev questions ("habits" fans out to 4 nouls); disabled metrics are not sent.
// - Auto-analyze cadence is user-configurable: every N words (slider,
//   default 5) plus optionally every finalized sentence (checkbox).
//   Only the tail of the text is sent (window slider, default 350 chars)
//   to keep it fast/cheap.
// - Confidence < 0.5 renders as "uncertain" (nouls use distance from 0.5);
//   accents (border, bar, badge, value) fade to gray; vivid hues follow the
//   result value (emotion choice, score level, yes/no, habits flagged).
export default class extends Controller {
  static targets = [
    "apiKey", "apiKeyCard", "keyStatus", "testButton",
    "metric", "miniTranscript", "miniFinal", "miniInterim", "miniTail", "miniState", "supportWarning",
    "transcriptFinal", "transcriptInterim", "wordCount", "manualText",
    "wordInterval", "wordIntervalLabel", "sentenceTrigger",
    "charsWindow", "charsWindowLabel",
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
  EMOTION_EMOJI = {
    neutral: "😐",
    happy: "😊",
    excited: "🤩",
    anxious: "😟",
    frustrated: "😤",
    sad: "😢",
    angry: "😠",
    other: "❓",
  }
  // Accent hues per result value (inline styles so Tailwind's build-time
  // purge can't drop them). Certainty fades everything to MUTED gray.
  EMOTION_COLORS = {
    neutral: "#a1a1aa",
    happy: "#10b981",
    excited: "#ec4899",
    anxious: "#eab308",
    frustrated: "#f97316",
    sad: "#0ea5e9",
    angry: "#ef4444",
    other: "#a1a1aa",
  }
  MUTED = "#a1a1aa"
  // Mini transcript sizing: fixed non-scrolling height derived from the
  // configured analysis window. leading-6 = 24px per line; ~45 chars fit
  // per line at text-sm in the recorder card, so the box always fits the
  // whole window tail with no internal scroll.
  MINI_LINE_HEIGHT = 24
  MINI_CHARS_PER_LINE = 45

  connect() {
    this.listening = false
    this.recognition = null
    this.finalText = ""
    this.interimText = ""
    this.lastStatus = "Idle"
    this.analyzing = false
    this.lastAnalyzedText = ""
    this.lastAnalyzedEnd = null
    this.analyzingEnd = null
    this.lastErrorEnd = null
    this.lastTriggerWords = 0
    this.elapsedSeconds = 0
    this.timerInterval = null

    this.apiKeyTarget.value = localStorage.getItem("syft_jev_key") || ""
    this.restoreToggles()
    this.restoreCadence()
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
    this.updateMiniTranscript()
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

  metricsChanged() {
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

  // --- cadence ------------------------------------------------------------
  wordInterval() {
    const n = parseInt(this.wordIntervalTarget.value, 10)
    return Number.isFinite(n) && n > 0 ? n : 5
  }

  sentenceTriggerOn() {
    return this.sentenceTriggerTarget.checked
  }

  windowChars() {
    const n = parseInt(this.charsWindowTarget.value, 10)
    return Number.isFinite(n) && n > 0 ? n : 350
  }

  cadenceChanged() {
    const n = this.wordInterval()
    if (this.hasWordIntervalLabelTarget) {
      this.wordIntervalLabelTarget.textContent = `${n} word${n === 1 ? "" : "s"}`
    }
    const c = this.windowChars()
    if (this.hasCharsWindowLabelTarget) {
      this.charsWindowLabelTarget.textContent = `${c} chars (~${Math.round(c / 6)} words)`
    }
    try {
      localStorage.setItem("syft_jev_cadence",
        JSON.stringify({ words: n, sentence: this.sentenceTriggerTarget.checked, chars: c }))
    } catch { /* private mode etc. — cadence just won't persist */ }
    this.updateMiniHeight()
    this.updateMiniTranscript()
  }

  restoreCadence() {
    try {
      const prefs = JSON.parse(localStorage.getItem("syft_jev_cadence") || "{}")
      if (prefs.words !== undefined) {
        this.wordIntervalTarget.value = Math.min(30, Math.max(1, parseInt(prefs.words, 10) || 5))
      }
      if (prefs.sentence !== undefined) this.sentenceTriggerTarget.checked = !!prefs.sentence
      if (prefs.chars !== undefined) {
        this.charsWindowTarget.value = Math.min(1400, Math.max(100, parseInt(prefs.chars, 10) || 350))
      }
    } catch { /* keep defaults */ }
    this.cadenceChanged()
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
      this.interimText = interim
      this.updateWordCount()
      this.updateMiniTranscript()
      const words = this.currentText().split(/\s+/).filter(Boolean).length
      const interval = this.wordInterval()
      const crossed = Math.floor(words / interval) !== Math.floor(this.lastTriggerWords / interval)
      if ((heardSentence && this.sentenceTriggerOn()) || crossed) {
        this.analyzeNow()
      }
      this.lastTriggerWords = words
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
    this.interimText = ""
    this.updateMiniTranscript()
  }

  clearTranscript() {
    this.finalText = ""
    this.interimText = ""
    this.lastAnalyzedEnd = null
    this.analyzingEnd = null
    this.lastErrorEnd = null
    this.setStatus("Idle")
    this.elapsedSeconds = 0
    this.lastTriggerWords = 0
    this.updateTimer()
    this.transcriptFinalTarget.textContent = ""
    this.transcriptInterimTarget.textContent = ""
    this.manualTextTarget.value = ""
    this.fitManualText()
    this.updateWordCount()
    this.resetMetrics()
  }

  resetMetrics() {
    this.element.querySelectorAll("[data-metric-card]").forEach((card) => {
      card.style.borderTopColor = ""
      card.querySelectorAll('[data-result="value"]').forEach((el) => {
        el.textContent = "—"
        el.style.color = ""
        el.className = el.className
          .replace("text-zinc-900", "text-zinc-300")
          .replace("dark:text-zinc-100", "dark:text-zinc-700")
      })
      card.querySelectorAll('[data-result="label"], [data-result="meta"]').forEach((el) => {
        el.textContent = ""
      })
      card.querySelectorAll('[data-result="bar"]').forEach((el) => {
        el.style.width = "0%"
        el.style.backgroundColor = ""
      })
      card.querySelectorAll('[data-result="dist"], [data-result="flags"]').forEach((el) => {
        el.innerHTML = ""
      })
      card.querySelectorAll('[data-result="emoji"]').forEach((el) => {
        el.textContent = "😐"
        el.style.backgroundColor = ""
      })
    })
    this.lastAnalyzedText = ""
    this.lastAnalyzedEnd = null
    this.analyzingEnd = null
    this.lastErrorEnd = null
    this.updateMiniTranscript()
  }

  // Grow the manual textbox to fit its content (CSS max-height caps it).
  fitManualText() {
    const el = this.manualTextTarget
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`
    this.updateWordCount()
    this.updateMiniTranscript()
  }

  useSample() {
    this.manualTextTarget.value =
      "Um, the Eiffel Tower is 330 meters tall and was completed in 1889, but honestly I feel like it might be the most overrated place on earth and it makes me kind of anxious, you know?"
    this.fitManualText()
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
    const full = this.currentText()
    const state = full.slice(-this.windowChars())

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
    this.analyzingEnd = full.length
    this.lastErrorEnd = null
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
        this.analyzing = false
        this.lastErrorEnd = this.analyzingEnd
        this.analyzingEnd = null
        this.setStatus(this.upstreamError(data, res.status))
        return
      }
      this.lastAnalyzedText = state
      this.analyzing = false
      this.lastAnalyzedEnd = this.analyzingEnd
      this.analyzingEnd = null
      this.lastErrorEnd = null
      this.renderAnswers(data.answers || {})
      this.setStatus(`Analyzed: “${state.replace(/\s+/g, " ").trim()}”`)
    } catch {
      this.analyzing = false
      this.lastErrorEnd = this.analyzingEnd
      this.analyzingEnd = null
      this.setStatus("Analysis failed — check connection and try again.")
    } finally {
      this.analyzing = false
      this.analyzingEnd = null
      this.updateMiniTranscript()
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
    if (answers.specificity) this.renderScore(this.cardSpecificityTarget, answers.specificity, 4, this.SPECIFICITY_LABELS, "sky")
    if (answers.complexity) this.renderScore(this.cardComplexityTarget, answers.complexity, 4, this.COMPLEXITY_LABELS, "violet")
    if (answers.grammar) this.renderScore(this.cardGrammarTarget, answers.grammar, 3, this.GRAMMAR_LABELS, "quality")
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

  hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "")
    if (!m) return hex
    const n = parseInt(m[1], 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
  }

  // Paints a card's accents (top border, bars, emoji badge, value text)
  // in `hex` when vivid, or fades them to MUTED gray when uncertain.
  // Toggles are controls, not results, so they keep their fixed hue.
  paintCard(card, hex, vivid) {
    const color = vivid ? hex : this.MUTED
    card.style.borderTopColor = color
    card.querySelectorAll('[data-result="bar"]').forEach((el) => {
      el.style.backgroundColor = color
    })
    card.querySelectorAll('[data-result="emoji"]').forEach((el) => {
      el.style.backgroundColor = this.hexToRgba(color, 0.16)
    })
    const value = card.querySelector('[data-result="value"]')
    if (value) value.style.color = vivid ? hex : ""
  }

  // Quality scale for grammar (a judgmental metric): red → amber → green.
  qualityColor(fraction) {
    if (fraction < 0.34) return "#ef4444"
    if (fraction < 0.67) return "#f59e0b"
    return "#10b981"
  }

  renderScore(card, answer, max, labels, scale) {
    const score = Number(answer.score)
    const idx = Math.max(0, Math.min(max, Math.round(score)))
    const uncertain = (answer.confidence ?? 1) < 0.5
    const fraction = max ? score / max : 0
    let hex = this.MUTED
    if (scale === "quality") hex = this.qualityColor(fraction)
    else if (scale === "sky") hex = fraction < 0.34 ? this.MUTED : fraction < 0.67 ? "#38bdf8" : "#0284c7"
    else if (scale === "violet") hex = fraction < 0.34 ? this.MUTED : fraction < 0.67 ? "#a78bfa" : "#7c3aed"
    card.querySelector('[data-result="value"]').textContent = score.toFixed(2)
    card.querySelector('[data-result="value"]').className = this.valueClass(!uncertain)
    card.querySelector('[data-result="label"]').textContent = labels[idx] || ""
    card.querySelector('[data-result="bar"]').style.width = `${fraction * 100}%`
    this.paintCard(card, hex, !uncertain)
    this.setUncertain(card, uncertain, answer.confidence)
  }

  renderNoul(card, answer, yesLabel, noLabel) {
    const p = Number(answer.noul)
    const yes = p >= 0.5
    const confidence = Math.abs(p - 0.5) * 2 // Nouls carry no confidence field
    const uncertain = confidence < 0.5
    const vivid = !uncertain && yes // confident "No" stays neutral gray
    card.querySelector('[data-result="value"]').textContent = yes ? "Yes" : "No"
    card.querySelector('[data-result="value"]').className = this.valueClass(!uncertain)
    card.querySelector('[data-result="label"]').textContent = yes ? yesLabel : noLabel
    card.querySelector('[data-result="bar"]').style.width = `${p * 100}%`
    this.paintCard(card, "#f97316", vivid)
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
    this.paintCard(card, n === 0 ? "#10b981" : n === 1 ? "#f59e0b" : "#f43f5e", true)
    card.querySelector('[data-result="meta"]').textContent =
      keys.length ? `${n} of ${keys.length} habits flagged` : ""
  }

  renderChoice(card, answer) {
    const choice = (answer.choice || "").toLowerCase()
    const uncertain = (answer.confidence ?? 1) < 0.5
    const hex = this.EMOTION_COLORS[choice] || this.MUTED
    const emojiEl = card.querySelector('[data-result="emoji"]')
    if (emojiEl) emojiEl.textContent = this.EMOTION_EMOJI[choice] || "❓"
    card.querySelector('[data-result="value"]').textContent = answer.choice || "—"
    card.querySelector('[data-result="value"]').className =
      "mt-1 text-3xl font-semibold capitalize " +
      (uncertain ? "text-zinc-300 dark:text-zinc-700" : "text-zinc-900 dark:text-zinc-100")
    const dist = card.querySelector('[data-result="dist"]')
    dist.innerHTML = ""
    const probs = answer.probabilities || {}
    const barColor = uncertain ? this.MUTED : hex
    Object.entries(probs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .forEach(([label, p]) => {
        const row = document.createElement("div")
        row.className = "flex items-center gap-2"
        const emoji = this.EMOTION_EMOJI[String(label).toLowerCase()] || ""
        row.innerHTML =
          `<span class="w-28 shrink-0 capitalize">${emoji ? `${emoji} ` : ""}${label}</span>` +
          `<div class="flex-grow h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800"><div class="h-1.5 rounded-full" style="width:${p * 100}%;background-color:${barColor}"></div></div>` +
          `<span class="w-10 text-right tabular-nums">${this.pct(p)}</span>`
        dist.appendChild(row)
      })
    this.paintCard(card, hex, !uncertain)
    // paintCard already colored the value text; the dist rows carry their own bar color above.
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

  // Mini transcript under the record button mirrors the full transcript
  // live (final + muted interim, left-aligned via markup) but shows only
  // the analysis window tail — the start is trimmed once text exceeds it.
  // The box has a fixed height derived from the configured window size
  // (see updateMiniHeight) with no internal scroll, so the whole window
  // tail is always visible.
  // Analysis state is an inline emoji sitting right after the last word
  // of the window being analyzed (⏳ while a request is in flight, ✅ at
  // the last analyzed word, ⚠️ at the failed window end). Words spoken
  // after that boundary render after the emoji in miniTail/miniInterim.
  // Anything else (Idle, Listening…, mic errors) shows as muted
  // placeholder text when there is no transcript yet.
  updateMiniTranscript() {
    if (!this.hasMiniFinalTarget || !this.hasMiniInterimTarget) return
    const marker = this.markerForStatus()
    if (this.hasMiniStateTarget) {
      this.miniStateTarget.textContent = marker.emoji
      this.miniStateTarget.title = this.lastStatus || "Idle"
    }
    const text = this.currentText()
    if (!text) {
      this.miniFinalTarget.textContent = this.lastStatus || "Idle"
      this.miniFinalTarget.style.opacity = "0.6"
      if (this.hasMiniTailTarget) this.miniTailTarget.textContent = ""
      this.miniInterimTarget.textContent = ""
    } else {
      const window = this.windowChars()
      const windowStart = Math.max(0, text.length - window)
      const trimmed = windowStart > 0
      const manual = this.manualTextTarget.value.trim()
      let interim = manual ? "" : (this.interimText || "")
      let interimLen = 0
      if (interim && text.endsWith(interim)) {
        interimLen = interim.length
      } else {
        interim = ""
      }
      const finalEnd = text.length - interimLen
      this.miniFinalTarget.style.opacity = ""
      if (!marker.emoji || marker.pos == null) {
        const finalPart = text.slice(windowStart, finalEnd)
        this.miniFinalTarget.textContent = (trimmed ? "… " : "") + finalPart
        if (this.hasMiniTailTarget) this.miniTailTarget.textContent = ""
        this.miniInterimTarget.textContent = interim
      } else {
        // Clamp to the visible final tail so the marker never splits the
        // live interim string; newer words render after the emoji.
        const clamped = Math.min(Math.max(marker.pos, windowStart), finalEnd)
        const before = text.slice(windowStart, clamped)
        const after = text.slice(clamped, finalEnd)
        this.miniFinalTarget.textContent = (trimmed ? "… " : "") + before
        if (this.hasMiniTailTarget) this.miniTailTarget.textContent = after
        this.miniInterimTarget.textContent = interim
      }
    }
  }

  // Fixed (non-scrolling) height for the mini transcript, sized to fit
  // the configured analysis window: one leading-6 line per
  // MINI_CHARS_PER_LINE chars. Called from cadenceChanged, so it runs on
  // boot (via restoreCadence) and whenever the window slider moves.
  updateMiniHeight() {
    if (!this.hasMiniTranscriptTarget) return
    const lines = Math.max(1, Math.ceil(this.windowChars() / this.MINI_CHARS_PER_LINE))
    this.miniTranscriptTarget.style.height = `${lines * this.MINI_LINE_HEIGHT}px`
  }

  // Emoji + character offset (in currentText()) where it belongs. A null
  // pos means "no inline boundary" — the emoji still shows in its slot,
  // which trails the final text when there is no newer remainder.
  markerForStatus() {
    const msg = this.lastStatus || "Idle"
    if (msg === "Analyzing…") {
      return { emoji: "⏳", pos: this.analyzingEnd }
    } else if (msg.startsWith("Analyzed")) {
      return { emoji: "✅", pos: this.lastAnalyzedEnd }
    } else if (msg === "Idle" || msg === "Listening… speak now.") {
      return { emoji: "", pos: null }
    }
    return { emoji: "⚠️", pos: this.lastErrorEnd }
  }

  setStatus(msg) {
    this.lastStatus = msg
    this.updateMiniTranscript()
  }

  pct(x) {
    return x === undefined || x === null ? "—" : `${Math.round(Number(x) * 100)}%`
  }

  updateWordCount() {
    const n = this.currentText().split(/\s+/).filter(Boolean).length
    if (this.hasWordCountTarget) this.wordCountTarget.textContent = n ? `· ${n} words` : ""
  }
}
