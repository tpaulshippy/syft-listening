import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Application } from "@hotwired/stimulus"
import SpeechInsightsController from "../app/javascript/controllers/speech_insights_controller.js"

document.head.innerHTML = '<meta name="csrf-token" content="test-csrf" />'

const METRICS = ["emotion", "habits", "grammar", "complexity", "specificity", "factual_claim"]

function scoreCard(metric, target) {
  return `<div data-metric-card="${metric}" data-speech-insights-target="${target}">
    <p data-result="value">—</p><p data-result="label"></p>
    <div><div data-result="bar" style="width:0%"></div></div>
    <p data-result="meta"></p></div>`
}

const FIXTURE = `
<div data-controller="speech-insights">
  <div data-speech-insights-target="recorderCard">
    <p data-speech-insights-target="timer">00:00</p>
    <div data-speech-insights-target="waveform"></div>
    <button data-speech-insights-target="recordButton" aria-label="Start speaking">
      <span data-speech-insights-target="iconMic">mic</span>
      <span data-speech-insights-target="iconStop" class="hidden">stop</span>
    </button>
    <p data-speech-insights-target="caption">Tap to speak</p>
    <div data-speech-insights-target="miniTranscript"><span data-speech-insights-target="miniFinal"></span><span data-speech-insights-target="miniState"></span><span data-speech-insights-target="miniTail"></span><span data-speech-insights-target="miniInterim"></span></div>
    <p data-speech-insights-target="supportWarning" class="hidden">unsupported</p>
  </div>
  <div data-speech-insights-target="metricsGrid">
    ${METRICS.map((m) => `<label><input type="checkbox" value="${m}" checked data-speech-insights-target="metric" /></label>`).join("")}
    <div data-metric-card="emotion" data-speech-insights-target="cardEmotion">
      <span data-result="emoji">😐</span>
      <p data-result="value">—</p><div data-result="dist"></div><p data-result="meta"></p>
    </div>
    <div data-metric-card="habits" data-speech-insights-target="cardHabits">
      <p data-result="value">—</p><div data-result="flags"></div><p data-result="meta"></p>
    </div>
    ${scoreCard("grammar", "cardGrammar")}
    ${scoreCard("complexity", "cardComplexity")}
    ${scoreCard("specificity", "cardSpecificity")}
    ${scoreCard("factual_claim", "cardFactualClaim")}
  </div>
  <div data-speech-insights-target="transcriptCard">
    <span data-speech-insights-target="wordCount"></span>
    <span data-speech-insights-target="transcriptFinal"></span><span data-speech-insights-target="transcriptInterim"></span>
    <textarea data-speech-insights-target="manualText"></textarea>
    <input data-speech-insights-target="wordInterval" type="range" min="1" max="30" value="5" />
    <span data-speech-insights-target="wordIntervalLabel">5 words</span>
    <input data-speech-insights-target="sentenceTrigger" type="checkbox" checked />
    <input data-speech-insights-target="charsWindow" type="range" min="100" max="1400" value="350" />
    <span data-speech-insights-target="charsWindowLabel">350 chars</span>
  </div>
  <div data-speech-insights-target="apiKeyCard">
    <input data-speech-insights-target="apiKey" type="password" />
    <button data-speech-insights-target="testButton">Test</button>
    <p data-speech-insights-target="keyStatus"></p>
  </div>
  <p data-speech-insights-target="footerNote">note</p>
</div>`

const okRes = (body = { answers: {} }, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

let app = null

async function boot() {
  app = Application.start()
  app.register("speech-insights", SpeechInsightsController)
  for (let i = 0; i < 50 && !controller(); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  return controller()
}

function controller() {
  const el = document.querySelector('[data-controller="speech-insights"]')
  return app?.getControllerForElementAndIdentifier(el, "speech-insights")
}

function metricBox(c, value) {
  return c.metricTargets.find((box) => box.value === value)
}

beforeEach(() => {
  document.body.innerHTML = FIXTURE
  localStorage.clear()
  vi.stubGlobal("fetch", vi.fn(async () => okRes()))
})

afterEach(() => {
  app?.stop()
  app = null
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("pure helpers", () => {
  it("pct formats proportions and blanks nullish input", async () => {
    const c = await boot()
    expect(c.pct(0.456)).toBe("46%")
    expect(c.pct(0)).toBe("0%")
    expect(c.pct(1)).toBe("100%")
    expect(c.pct(null)).toBe("—")
    expect(c.pct(undefined)).toBe("—")
  })

  it("hexToRgba converts 6-digit hex and passes garbage through", async () => {
    const c = await boot()
    expect(c.hexToRgba("#ff0000", 0.5)).toBe("rgba(255,0,0,0.5)")
    expect(c.hexToRgba("00ff00", 0.16)).toBe("rgba(0,255,0,0.16)")
    expect(c.hexToRgba("not-a-color", 0.5)).toBe("not-a-color")
    expect(c.hexToRgba("", 0.5)).toBe("")
  })

  it("qualityColor goes red -> amber -> green", async () => {
    const c = await boot()
    expect(c.qualityColor(0)).toBe("#ef4444")
    expect(c.qualityColor(0.33)).toBe("#ef4444")
    expect(c.qualityColor(0.34)).toBe("#f59e0b")
    expect(c.qualityColor(0.5)).toBe("#f59e0b")
    expect(c.qualityColor(0.67)).toBe("#10b981")
    expect(c.qualityColor(1)).toBe("#10b981")
  })

  it("upstreamError prefers error, then detail, then HTTP status", async () => {
    const c = await boot()
    expect(c.upstreamError({ error: "boom" }, 422)).toBe("boom")
    expect(c.upstreamError({ detail: "oops" }, 422)).toBe('"oops"')
    expect(c.upstreamError({ detail: { loc: ["x"] } }, 422)).toContain("x")
    expect(c.upstreamError({}, 500)).toBe("Jev error (HTTP 500)")
  })

  it("upstreamError truncates huge detail payloads", async () => {
    const c = await boot()
    const msg = c.upstreamError({ detail: { blob: "x".repeat(500) } }, 422)
    expect(msg.length).toBeLessThanOrEqual(301)
    expect(msg.endsWith("…")).toBe(true)
  })
})

describe("constants stay in sync with the Rails proxy", () => {
  it("habit labels cover the four habits questions", async () => {
    const c = await boot()
    expect(Object.keys(c.HABIT_LABELS).sort()).toEqual(
      ["filler", "hedging", "question_asked", "repetition"].sort(),
    )
  })

  it("every emotion color has an emoji", async () => {
    const c = await boot()
    for (const key of Object.keys(c.EMOTION_COLORS)) {
      expect(c.EMOTION_EMOJI[key]).toBeTruthy()
    }
  })

  it("score label counts match the server-side criteria lists", async () => {
    const c = await boot()
    expect(c.SPECIFICITY_LABELS).toHaveLength(5)
    expect(c.COMPLEXITY_LABELS).toHaveLength(5)
    expect(c.GRAMMAR_LABELS).toHaveLength(4)
  })

  it("waveform has a deterministic level per bar", async () => {
    const c = await boot()
    expect(c.WAVE_LEVELS.length).toBeGreaterThan(0)
    expect(Math.max(...c.WAVE_LEVELS)).toBeLessThanOrEqual(1)
    expect(Math.min(...c.WAVE_LEVELS)).toBeGreaterThan(0)
  })
})

describe("metrics toggles", () => {
  it("all six metrics are enabled by default", async () => {
    const c = await boot()
    expect(c.enabledMetrics().sort()).toEqual([...METRICS].sort())
  })

  it("metricsChanged persists prefs and dims the disabled card", async () => {
    const c = await boot()
    c.manualTextTarget.value = "one two three four five"
    metricBox(c, "habits").checked = false
    c.metricsChanged()
    expect(JSON.parse(localStorage.getItem("syft_jev_metrics")).habits).toBe(false)
    expect(c.cardHabitsTarget.style.opacity).toBe("0.35")
    expect(c.cardEmotionTarget.style.opacity).toBe("1")
  })

  it("restoreToggles honors stored prefs on boot", async () => {
    localStorage.setItem("syft_jev_metrics", JSON.stringify({ emotion: false }))
    const c = await boot()
    expect(metricBox(c, "emotion").checked).toBe(false)
    expect(metricBox(c, "habits").checked).toBe(true)
    expect(c.cardEmotionTarget.style.opacity).toBe("0.35")
  })
})

describe("cadence controls", () => {
  it("falls back to defaults on garbage input", async () => {
    const c = await boot()
    // Range inputs sanitize non-numeric strings, so exercise the
    // parsers directly for the NaN path.
    const proto = Object.getPrototypeOf(c)
    expect(proto.wordInterval.call({ wordIntervalTarget: { value: "abc" } })).toBe(5)
    expect(proto.wordInterval.call({ wordIntervalTarget: { value: "0" } })).toBe(5)
    expect(proto.windowChars.call({ charsWindowTarget: { value: "-3" } })).toBe(350)
    expect(proto.windowChars.call({ charsWindowTarget: { value: "" } })).toBe(350)
    expect(c.sentenceTriggerOn()).toBe(true)
  })

  it("updates labels with singular/plural and persists", async () => {
    const c = await boot()
    c.wordIntervalTarget.value = "1"
    c.charsWindowTarget.value = "600"
    c.cadenceChanged()
    expect(c.wordIntervalLabelTarget.textContent).toBe("1 word")
    expect(c.charsWindowLabelTarget.textContent).toBe("600 chars (~100 words)")
    expect(JSON.parse(localStorage.getItem("syft_jev_cadence"))).toEqual(
      { words: 1, sentence: true, chars: 600 },
    )
  })

  it("restoreCadence clamps stored values into range", async () => {
    localStorage.setItem(
      "syft_jev_cadence",
      JSON.stringify({ words: 99, sentence: false, chars: 5 }),
    )
    const c = await boot()
    expect(c.wordIntervalTarget.value).toBe("30")
    expect(c.sentenceTriggerTarget.checked).toBe(false)
    expect(c.charsWindowTarget.value).toBe("100")
  })

  it("sizes the mini transcript height from the window chars", async () => {
    const c = await boot()
    const lines = (chars) => Math.max(1, Math.ceil(chars / c.MINI_CHARS_PER_LINE))
    expect(c.miniTranscriptTarget.style.height).toBe(`${lines(350) * c.MINI_LINE_HEIGHT}px`)
    c.charsWindowTarget.value = "100"
    c.cadenceChanged()
    expect(c.miniTranscriptTarget.style.height).toBe(`${lines(100) * c.MINI_LINE_HEIGHT}px`)
    c.charsWindowTarget.value = "1400"
    c.cadenceChanged()
    expect(c.miniTranscriptTarget.style.height).toBe(`${lines(1400) * c.MINI_LINE_HEIGHT}px`)
  })
})

describe("API key gate", () => {
  it("locks the interactive sections until the key is verified", async () => {
    const c = await boot()
    expect(c.isKeyVerified()).toBe(false)
    expect(c.recorderCardTarget.classList.contains("hidden")).toBe(true)
    expect(c.metricsGridTarget.classList.contains("hidden")).toBe(true)
    expect(c.transcriptCardTarget.classList.contains("hidden")).toBe(true)
    expect(c.keyStatusTarget.textContent).toContain("Add your key")
    expect(c.apiKeyCardTarget.nextElementSibling).toBe(c.recorderCardTarget)
  })

  it("unlocks when the exact key was verified", async () => {
    const c = await boot()
    c.apiKeyTarget.value = "ts_abc"
    localStorage.setItem("syft_jev_key_ok", "ts_abc")
    c.updateGate()
    expect(c.isKeyVerified()).toBe(true)
    expect(c.recorderCardTarget.classList.contains("hidden")).toBe(false)
    expect(c.apiKeyCardTarget.nextElementSibling).toBe(c.footerNoteTarget)
  })

  it("editing the key re-locks the gate", async () => {
    const c = await boot()
    c.apiKeyTarget.value = "ts_abc"
    localStorage.setItem("syft_jev_key_ok", "ts_abc")
    c.updateGate()
    c.apiKeyTarget.value = "ts_other"
    c.updateGate()
    expect(c.isKeyVerified()).toBe(false)
    expect(c.keyStatusTarget.textContent).toContain("Tap Test")
  })

  it("toggleKeyVisibility flips password visibility", async () => {
    const c = await boot()
    expect(c.apiKeyTarget.type).toBe("password")
    c.toggleKeyVisibility()
    expect(c.apiKeyTarget.type).toBe("text")
    c.toggleKeyVisibility()
    expect(c.apiKeyTarget.type).toBe("password")
  })

  it("testKey verifies a working key", async () => {
    const c = await boot()
    c.apiKeyTarget.value = "ts_good"
    await c.testKey()
    expect(localStorage.getItem("syft_jev_key_ok")).toBe("ts_good")
    expect(c.keyStatusTarget.textContent).toBe("✓ Key works.")
    expect(c.recorderCardTarget.classList.contains("hidden")).toBe(false)
  })

  it("testKey rejects a bad key without storing it", async () => {
    fetch.mockResolvedValue(okRes({ error: "unauthorized" }, 401))
    const c = await boot()
    c.apiKeyTarget.value = "ts_bad"
    await c.testKey()
    expect(localStorage.getItem("syft_jev_key_ok")).toBeNull()
    expect(c.keyStatusTarget.textContent).toContain("✗")
  })

  it("testKey reports network failures", async () => {
    fetch.mockRejectedValue(new Error("down"))
    const c = await boot()
    c.apiKeyTarget.value = "ts_x"
    await c.testKey()
    expect(c.keyStatusTarget.textContent).toBe("✗ Could not reach the server.")
  })

  it("testKey asks for a key when empty and never fetches", async () => {
    const c = await boot()
    c.apiKeyTarget.value = ""
    await c.testKey()
    expect(c.keyStatusTarget.textContent).toBe("Paste your key first.")
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("postAnalyze", () => {
  it("POSTs JSON with CSRF header to the Rails proxy", async () => {
    const c = await boot()
    await c.postAnalyze("hi there world", ["specificity"], "ts_k")
    expect(fetch).toHaveBeenCalledOnce()
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe("/jev_analyze")
    expect(opts.method).toBe("POST")
    expect(opts.headers["Content-Type"]).toBe("application/json")
    expect(opts.headers["X-CSRF-Token"]).toBe("test-csrf")
    expect(JSON.parse(opts.body)).toEqual(
      { text: "hi there world", metrics: ["specificity"], api_key: "ts_k" },
    )
  })
})

describe("analyzeNow", () => {
  async function readyController(overrides = {}) {
    const c = await boot()
    c.manualTextTarget.value = overrides.text ?? "one two three four five six"
    c.apiKeyTarget.value = overrides.key ?? "ts_test"
    if (overrides.metrics === "none") {
      c.metricTargets.forEach((box) => { box.checked = false })
    }
    return c
  }

  it("skips text shorter than three words", async () => {
    const c = await readyController({ text: "hi there" })
    await c.analyzeNow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("asks for at least one metric", async () => {
    const c = await readyController({ metrics: "none" })
    await c.analyzeNow()
    expect(fetch).not.toHaveBeenCalled()
    expect(c.miniStateTarget.title).toBe("Enable at least one metric.")
  })

  it("asks for the API key", async () => {
    const c = await readyController({ key: "" })
    await c.analyzeNow()
    expect(fetch).not.toHaveBeenCalled()
    expect(c.miniStateTarget.title).toBe("Paste your Jev API key first.")
  })

  it("analyzes once per unique text", async () => {
    const c = await readyController()
    await c.analyzeNow()
    expect(fetch).toHaveBeenCalledOnce()
    fetch.mockClear()
    await c.analyzeNow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("renders answers and marks the status analyzed", async () => {
    fetch.mockResolvedValue(okRes({ answers: { specificity: { score: 3, confidence: 0.95 } } }))
    const c = await readyController()
    await c.analyzeNow()
    expect(c.cardSpecificityTarget.querySelector('[data-result="value"]').textContent).toBe("3.00")
    expect(c.miniStateTarget.textContent).toBe("✅")
    expect(c.miniStateTarget.title.startsWith("Analyzed")).toBe(true)
  })

  it("a 401 un-verifies the key and surfaces the error", async () => {
    fetch.mockResolvedValue(okRes({ error: "bad key" }, 401))
    const c = await readyController()
    localStorage.setItem("syft_jev_key_ok", "ts_test")
    await c.analyzeNow()
    expect(localStorage.getItem("syft_jev_key_ok")).toBeNull()
    expect(c.miniStateTarget.title).toBe("bad key")
    expect(c.recorderCardTarget.classList.contains("hidden")).toBe(true)
  })

  it("a network failure sets a retry status", async () => {
    fetch.mockRejectedValue(new Error("down"))
    const c = await readyController()
    await c.analyzeNow()
    expect(c.miniStateTarget.title).toContain("check connection")
  })
})

describe("renderers", () => {
  it("renderScore paints vivid when confident and mutes when uncertain", async () => {
    const c = await boot()
    c.renderScore(c.cardSpecificityTarget, { score: 4, confidence: 0.9 }, 4, c.SPECIFICITY_LABELS, "sky")
    const card = c.cardSpecificityTarget
    expect(card.querySelector('[data-result="value"]').textContent).toBe("4.00")
    expect(card.querySelector('[data-result="label"]').textContent).toBe("Highly specific")
    expect(card.querySelector('[data-result="bar"]').style.width).toBe("100%")
    expect(card.querySelector('[data-result="value"]').className).toContain("text-zinc-900")

    c.renderScore(card, { score: 1, confidence: 0.1 }, 4, c.SPECIFICITY_LABELS, "sky")
    expect(card.querySelector('[data-result="value"]').className).toContain("text-zinc-300")
    expect(card.querySelector('[data-result="meta"]').textContent).toContain("uncertain")
  })

  it("renderNoul says Yes/No with noul-derived confidence", async () => {
    const c = await boot()
    const card = c.cardFactualClaimTarget
    c.renderNoul(card, { noul: 0.9 }, "States a checkable fact", "No checkable fact")
    expect(card.querySelector('[data-result="value"]').textContent).toBe("Yes")
    expect(card.querySelector('[data-result="bar"]').style.width).toBe("90%")

    c.renderNoul(card, { noul: 0.1 }, "States a checkable fact", "No checkable fact")
    expect(card.querySelector('[data-result="value"]').textContent).toBe("No")

    c.renderNoul(card, { noul: 0.5 }, "States a checkable fact", "No checkable fact")
    expect(card.querySelector('[data-result="meta"]').textContent).toContain("uncertain")
  })

  it("renderHabits counts flags and escalates green -> amber -> rose", async () => {
    const c = await boot()
    const card = c.cardHabitsTarget
    c.renderHabits(card, { filler: { noul: 0.1 }, hedging: { noul: 0.2 } })
    expect(card.querySelector('[data-result="value"]').textContent).toBe("None")
    expect(card.style.borderTopColor).toBe("rgb(16, 185, 129)")

    c.renderHabits(card, { filler: { noul: 0.9 }, hedging: { noul: 0.2 } })
    expect(card.querySelector('[data-result="value"]').textContent).toBe("1 flagged")
    expect(card.style.borderTopColor).toBe("rgb(245, 158, 11)")

    c.renderHabits(card, { filler: { noul: 0.9 }, hedging: { noul: 0.9 } })
    expect(card.querySelector('[data-result="value"]').textContent).toBe("2 flagged")
    expect(card.style.borderTopColor).toBe("rgb(244, 63, 94)")
    expect(card.querySelector('[data-result="meta"]').textContent).toBe("2 of 2 habits flagged")
  })

  it("renderChoice shows the top emotions with emoji", async () => {
    const c = await boot()
    const card = c.cardEmotionTarget
    c.renderChoice(card, {
      choice: "Happy",
      confidence: 0.9,
      probabilities: { happy: 0.7, neutral: 0.2, sad: 0.05, angry: 0.03, excited: 0.02 },
    })
    expect(card.querySelector('[data-result="value"]').textContent).toBe("Happy")
    expect(card.querySelector('[data-result="emoji"]').textContent).toBe("😊")
    const rows = card.querySelector('[data-result="dist"]').children
    expect(rows).toHaveLength(4)
    expect(rows[0].textContent).toContain("happy")

    c.renderChoice(card, { choice: "Sad", confidence: 0.1, probabilities: {} })
    expect(card.querySelector('[data-result="value"]').className).toContain("text-zinc-300")
    expect(card.querySelector('[data-result="meta"]').textContent).toContain("uncertain")
  })

  it("resetMetrics restores placeholders", async () => {
    const c = await boot()
    c.renderScore(c.cardSpecificityTarget, { score: 4, confidence: 0.9 }, 4, c.SPECIFICITY_LABELS, "sky")
    c.clearTranscript()
    expect(c.cardSpecificityTarget.querySelector('[data-result="value"]').textContent).toBe("—")
    expect(c.cardSpecificityTarget.querySelector('[data-result="bar"]').style.width).toBe("0%")
    expect(c.cardEmotionTarget.querySelector('[data-result="emoji"]').textContent).toBe("😐")
    expect(c.timerTarget.textContent).toBe("00:00")
  })
})

describe("transcript + status", () => {
  it("currentText prefers the manual box over speech", async () => {
    const c = await boot()
    c.finalText = "spoken words here"
    c.manualTextTarget.value = "typed words here now"
    expect(c.currentText()).toBe("typed words here now")
    c.manualTextTarget.value = ""
    c.transcriptInterimTarget.textContent = "live bit"
    expect(c.currentText()).toBe("spoken words here live bit")
  })

  it("setStatus maps states to mini emoji with tooltip", async () => {
    const c = await boot()
    c.setStatus("Analyzing…")
    expect(c.miniStateTarget.textContent).toBe("⏳")
    c.setStatus("Analyzed: “hello world”")
    expect(c.miniStateTarget.textContent).toBe("✅")
    expect(c.miniStateTarget.title).toBe("Analyzed: “hello world”")
    c.setStatus("Idle")
    expect(c.miniStateTarget.textContent).toBe("")
    c.setStatus("Mic error: nope")
    expect(c.miniStateTarget.textContent).toBe("⚠️")
  })

  it("updateMiniTranscript trims to the analysis window", async () => {
    const c = await boot()
    c.charsWindowTarget.value = "100"
    c.manualTextTarget.value = `${"word ".repeat(60)}tail here now`
    c.updateMiniTranscript()
    expect(c.miniFinalTarget.textContent.startsWith("… ")).toBe(true)
    expect(c.miniFinalTarget.textContent.length).toBeLessThanOrEqual(102)
  })

  it("✅ sits after the last analyzed word with newer words after it", async () => {
    fetch.mockResolvedValue(okRes({ answers: {} }))
    const c = await boot()
    c.apiKeyTarget.value = "ts_test"
    c.manualTextTarget.value = "one two three four five six"
    await c.analyzeNow()
    expect(c.miniStateTarget.textContent).toBe("✅")
    expect(c.miniFinalTarget.textContent).toContain("six")
    expect(c.miniTailTarget.textContent).toBe("")
    // New words spoken after the analysis render after the checkmark.
    c.manualTextTarget.value = "one two three four five six seven eight"
    c.updateMiniTranscript()
    expect(c.miniStateTarget.textContent).toBe("✅")
    expect(c.miniFinalTarget.textContent).toContain("six")
    expect(c.miniFinalTarget.textContent).not.toContain("seven")
    expect(c.miniTailTarget.textContent).toContain("seven eight")
  })

  it("⏳ sits at the end of the window being analyzed", async () => {
    let release
    fetch.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const c = await boot()
    c.apiKeyTarget.value = "ts_test"
    c.manualTextTarget.value = "one two three four five six"
    const pending = c.analyzeNow()
    expect(c.miniStateTarget.textContent).toBe("⏳")
    // Speech continues while the request is in flight: the hourglass
    // stays at the analyzed window end, newer words follow it.
    c.manualTextTarget.value = "one two three four five six seven eight"
    c.updateMiniTranscript()
    expect(c.miniStateTarget.textContent).toBe("⏳")
    expect(c.miniFinalTarget.textContent).toContain("six")
    expect(c.miniFinalTarget.textContent).not.toContain("seven")
    expect(c.miniTailTarget.textContent).toContain("seven eight")
    release(okRes({ answers: {} }))
    await pending
    expect(c.miniStateTarget.textContent).toBe("✅")
  })

  it("updateWordCount counts words", async () => {
    const c = await boot()
    c.manualTextTarget.value = "one two three"
    c.updateWordCount()
    expect(c.wordCountTarget.textContent).toBe("· 3 words")
    c.manualTextTarget.value = ""
    c.updateWordCount()
    expect(c.wordCountTarget.textContent).toBe("")
  })

  it("useSample fills the box and analyzes", async () => {
    const c = await boot()
    c.apiKeyTarget.value = "ts_test"
    c.useSample()
    await new Promise((r) => setTimeout(r, 0))
    expect(c.manualTextTarget.value).toContain("Eiffel Tower")
    expect(fetch).toHaveBeenCalled()
  })
})

describe("recorder UI", () => {
  it("updateTimer formats mm:ss", async () => {
    const c = await boot()
    c.elapsedSeconds = 65
    c.updateTimer()
    expect(c.timerTarget.textContent).toBe("01:05")
  })

  it("buildWaveform renders one bar per level", async () => {
    const c = await boot()
    expect(c.waveformTarget.children.length).toBe(c.WAVE_LEVELS.length)
    expect(c.waveformTarget.children[0].style.height).toBe("35%")
  })

  it("setRecordingUI toggles icons, caption, and aria label", async () => {
    const c = await boot()
    c.setRecordingUI(true)
    expect(c.captionTarget.textContent).toBe("Tap to stop")
    expect(c.recordButtonTarget.getAttribute("aria-label")).toBe("Stop speaking")
    expect(c.iconMicTarget.classList.contains("hidden")).toBe(true)
    expect(c.iconStopTarget.classList.contains("hidden")).toBe(false)
    c.setRecordingUI(false)
    expect(c.captionTarget.textContent).toBe("Tap to speak")
    expect(c.recordButtonTarget.getAttribute("aria-label")).toBe("Start speaking")
  })
})
