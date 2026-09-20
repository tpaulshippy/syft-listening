import { Controller } from "@hotwired/stimulus"

// Voice UI builder: one Jev fan-out call -> deterministic render.
//
// Pattern (same as the demo): state = { request, tasks, calendar },
// questions = every UI decision enumerated up front. Jev answers them all in
// parallel; `renderSpecHtml` below is a pure function of (spec, dataset) — no
// LLM-generated code. When there is no key (or an answer is low-confidence),
// `inferSpecFromPrompt` provides the offline keyword fallback so the page
// still works and the renderer stays total.

// --- dataset (mirrors BuilderController::TASKS / ::CALENDAR) -----------------
export const TASKS = [
  { id: "launch_story", title: "Write launch story", minutes: 90, owner: "you", blocked: false, day: "thu" },
  { id: "retry_event", title: "Add retry event", minutes: 120, owner: "maya", blocked: false, day: "tue" },
  { id: "billing_edge", title: "Verify billing edge cases", minutes: 90, owner: "priya", blocked: true, day: "wed" },
  { id: "press_kit", title: "Polish press kit", minutes: 80, owner: "sam", blocked: false, day: "wed" },
  { id: "mobile_qa", title: "Mobile launch QA", minutes: 75, owner: "you", blocked: true, day: "thu" },
  { id: "launch_emails", title: "Schedule launch emails", minutes: 50, owner: "sam", blocked: true, day: "thu" },
  { id: "case_study", title: "Publish customer case study", minutes: 45, owner: "priya", blocked: true, day: "fri" },
  { id: "signoff", title: "Analytics sign-off", minutes: 45, owner: "maya", blocked: true, day: "tue" },
  { id: "pricing_copy", title: "Review pricing copy", minutes: 40, owner: "you", blocked: false, day: "wed" },
  { id: "status_page", title: "Prepare status page", minutes: 35, owner: "maya", blocked: false, day: "wed" },
  { id: "support_brief", title: "Send support brief", minutes: 30, owner: "priya", blocked: true, day: "thu" },
  { id: "press_briefing", title: "Send press briefing", minutes: 30, owner: "sam", blocked: true, day: "wed" },
  { id: "retro_prompts", title: "Draft retro prompts", minutes: 25, owner: "you", blocked: false, day: "fri" },
  { id: "demo_speakers", title: "Confirm demo speakers", minutes: 20, owner: "sam", blocked: false, day: "wed" },
]

export const CALENDAR = {
  tue: [{ title: "Priya 1:1", start: "10:30", finish: "11:00" }],
  wed: [
    { title: "Deep work hold", start: "9:00", finish: "10:00" },
    { title: "Go-to-market", start: "12:00", finish: "13:00" },
    { title: "Press check-in", start: "15:30", finish: "16:00" },
  ],
  thu: [
    { title: "Team planning", start: "10:00", finish: "11:00" },
    { title: "Support readiness", start: "13:00", finish: "13:30" },
    { title: "Launch review", start: "15:30", finish: "16:30" },
  ],
  fri: [{ title: "Launch room", start: "9:00", finish: "10:30" }],
}

export const SAMPLE_PROMPTS = [
  "Show open work as bubbles, coloured by owner. Flag blocked tasks.",
  "Put blocked work on the left and ready work on the right. Keep the bubbles.",
  "Switch to cards and add completion checkboxes.",
  "Find 90 minutes in my calendar for quiet reading time, and add 45 minutes of gym after.",
]

export const OWNER_COLORS = { you: "#a5b4fc", sam: "#fed7aa", maya: "#bbf7d0", priya: "#e9d5ff" }
export const OWNER_NAMES = { you: "You", sam: "Sam", maya: "Maya", priya: "Priya" }
const DAYS = ["tue", "wed", "thu", "fri"]
const DAY_LABELS = { tue: "Tue 9/15", wed: "Wed 9/16", thu: "Thu 9/17", fri: "Fri 9/18" }

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

export function noulConfidence(p) {
  return Math.abs(Number(p) - 0.5) * 2
}

export function bubbleDiameter(minutes, sizeBy) {
  if (sizeBy === "equal") return 84
  return Math.round(Math.min(150, Math.max(56, 44 + Number(minutes) * 0.72)))
}

export function sortTasks(tasks, sortBy) {
  const arr = [...tasks]
  if (sortBy === "title") arr.sort((a, b) => a.title.localeCompare(b.title))
  else if (sortBy === "owner") arr.sort((a, b) => a.owner.localeCompare(b.owner))
  else if (sortBy === "day") arr.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day))
  else arr.sort((a, b) => b.minutes - a.minutes)
  return arr
}

export function visibleTasks(tasks, include) {
  if (!include) return tasks
  const scoped = tasks.filter((t) => include[t.id] !== false)
  return scoped.length ? scoped : tasks
}

// Offline keyword parse — fallback when there is no Jev key and safety net
// for low-confidence answers. Same spec shape as specFromAnswers.
export function inferSpecFromPrompt(prompt) {
  const p = (prompt || "").toLowerCase()
  const has = (...words) => words.some((w) => p.includes(w))
  const view = has("calendar", "gym", "reading time", "my calendar") ? "calendar"
    : has("card", "checkbox") ? "cards"
    : has("left", "right", "split", "blocked work on") ? "board"
    : has("list") ? "list" : "bubbles"
  return {
    view,
    groupBy: has("by owner", "coloured by owner", "colored by owner") ? "owner" : has("by day") ? "day" : has("blocked", "ready") ? "status" : "none",
    colorBy: has("coloured by owner", "colored by owner", "by owner") ? "owner" : has("blocked") ? "status" : "owner",
    sizeBy: has("same size", "equal") ? "equal" : "minutes",
    sortBy: "minutes_desc",
    split: has("left", "right", "split"),
    flagBlocked: has("block", "flag"),
    showEstimates: has("minute", "estimate", "bubble", "m ", "90m"),
    showOwner: has("owner", "bubble", "coloured", "colored"),
    checkboxes: has("checkbox", "check-box", "complete"),
    legend: view === "bubbles",
    dayHeaders: view === "cards" || has("by day"),
    totals: has("total", "card", "checkbox"),
    scheduleDay: has("fri") ? "fri" : has("thu") ? "thu" : has("tue") ? "tue" : "fri",
    addReading: has("reading"),
    addGym: has("gym"),
    readingMinutes: has("90") ? 90 : 60,
    gymMinutes: has("45") ? 45 : 30,
    highlightAdded: has("add"),
    onlyBlocked: has("blocked work on the left"),
    onlyReady: false,
    include: null,
    title: prompt,
  }
}

// Merge Jev answers with the offline fallback: any missing or
// low-confidence (< 0.5) answer falls back to the keyword parse.
export function specFromAnswers(answers, prompt) {
  const fb = inferSpecFromPrompt(prompt)
  const usedFallback = []
  const choice = (key, fallback, allowed) => {
    const a = answers?.[key]
    const conf = Number(a?.confidence ?? NaN)
    if (a?.choice && allowed.includes(a.choice) && conf >= 0.5) return a.choice
    usedFallback.push(key)
    return fallback
  }
  const noul = (key, fallback) => {
    const a = answers?.[key]
    if (a == null || a.noul == null) { usedFallback.push(key); return fallback }
    const p = Number(a.noul)
    if (noulConfidence(p) < 0.5) { usedFallback.push(key); return fallback }
    return p >= 0.5
  }
  const view = choice("view", fb.view, ["bubbles", "cards", "board", "calendar", "list"])
  return {
    spec: {
      view,
      groupBy: choice("group_by", view === "cards" ? "day" : fb.groupBy, ["none", "status", "owner", "day"]),
      colorBy: choice("color_by", fb.colorBy, ["owner", "status", "day", "none"]),
      sizeBy: choice("size_by", fb.sizeBy, ["minutes", "equal"]),
      sortBy: choice("sort_by", fb.sortBy, ["minutes_desc", "title", "owner", "day"]),
      scheduleDay: choice("schedule_day", fb.scheduleDay, ["tue", "wed", "thu", "fri"]),
      split: noul("split_blocked_ready", fb.split),
      flagBlocked: noul("flag_blocked", fb.flagBlocked),
      showEstimates: noul("show_estimates", fb.showEstimates),
      showOwner: noul("show_owner", fb.showOwner),
      checkboxes: noul("show_checkboxes", fb.checkboxes) || noul("switch_to_cards", false) || view === "cards",
      legend: noul("show_legend", fb.legend),
      dayHeaders: noul("show_day_headers", fb.dayHeaders),
      totals: noul("show_minutes_total", fb.totals),
      keepBubbles: noul("keep_bubbles", false),
      addReading: noul("calendar_add_reading", fb.addReading),
      addGym: noul("calendar_add_gym", fb.addGym),
      highlightAdded: noul("highlight_added", fb.highlightAdded),
      onlyBlocked: noul("filter_blocked_only", fb.onlyBlocked),
      onlyReady: noul("filter_ready_only", fb.onlyReady),
      readingMinutes: noul("reading_90m", fb.readingMinutes === 90) ? 90 : 60,
      gymMinutes: noul("gym_45m", fb.gymMinutes === 45) ? 45 : 30,
      include: null,
      title: prompt,
    },
    usedFallback,
  }
}

function bubbleHtml(task, spec) {
  const d = bubbleDiameter(task.minutes, spec.sizeBy)
  const bg = spec.colorBy === "status"
    ? (task.blocked ? "#fecaca" : "#bbf7d0")
    : (OWNER_COLORS[task.owner] || "#e4e4e7")
  const flagged = spec.flagBlocked && task.blocked
  return `<div title="${escapeHtml(task.title)} · ${task.minutes}m · ${OWNER_NAMES[task.owner]}${task.blocked ? " · blocked" : ""}" ` +
    `style="width:${d}px;height:${d}px;background:${bg};` +
    `${flagged ? "border:2px dashed #dc2626;" : "border:2px solid rgba(0,0,0,0.08);"}` +
    `border-radius:9999px;display:flex;flex-direction:column;align-items:center;justify-content:center;` +
    `text-align:center;padding:6px;font-size:11px;line-height:1.2;">` +
    `<span style="font-weight:600;">${escapeHtml(task.title)}</span>` +
    `${spec.showEstimates ? `<span style="font-weight:700;">${task.minutes}m</span>` : ""}` +
    `${flagged ? `<span style="font-size:10px;">⛔ blocked</span>` : ""}</div>`
}

function legendHtml(spec) {
  if (!spec.legend) return ""
  const owners = Object.entries(OWNER_NAMES).map(([k, v]) =>
    `<span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;border-radius:9999px;background:${OWNER_COLORS[k]};display:inline-block;"></span>${v}</span>`).join(" ")
  return `<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:#71717a;margin-bottom:8px;">${owners}` +
    `${spec.flagBlocked ? `<span>⛔ Blocked</span>` : ""}<span>Area = estimated minutes</span></div>`
}

function tasksFor(spec) {
  let tasks = visibleTasks(TASKS, spec.include)
  if (spec.onlyBlocked) tasks = tasks.filter((t) => t.blocked)
  if (spec.onlyReady) tasks = tasks.filter((t) => !t.blocked)
  return sortTasks(tasks, spec.sortBy)
}

function bubblesViewHtml(spec) {
  const tasks = tasksFor(spec)
  return `<h3 style="font-size:12px;color:#71717a;margin-bottom:6px;">Task bubbles</h3>` +
    legendHtml(spec) +
    `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">${tasks.map((t) => bubbleHtml(t, spec)).join("")}</div>` +
    totalsHtml(tasks, spec)
}

function boardViewHtml(spec) {
  const tasks = tasksFor(spec)
  const blocked = tasks.filter((t) => t.blocked)
  const ready = tasks.filter((t) => !t.blocked)
  const col = (title, items) =>
    `<div style="flex:1;min-width:220px;border:1px solid #e4e4e7;border-radius:12px;padding:10px;">` +
    `<h4 style="font-size:12px;font-weight:700;margin-bottom:8px;">${title} (${items.length})</h4>` +
    `<div style="display:flex;flex-wrap:wrap;gap:8px;">${items.map((t) => bubbleHtml(t, spec)).join("")}</div></div>`
  return legendHtml(spec) + `<div style="display:flex;gap:10px;flex-wrap:wrap;">${col("Blocked", blocked)}${col("Ready", ready)}</div>`
}

function cardsViewHtml(spec) {
  const tasks = tasksFor(spec)
  const byDay = DAYS.map((d) => [d, tasks.filter((t) => t.day === d)]).filter(([, items]) => items.length)
  const cols = byDay.map(([day, items]) => {
    const total = items.reduce((s, t) => s + t.minutes, 0)
    return `<div style="flex:1;min-width:150px;border:1px solid #e4e4e7;border-radius:12px;padding:8px;">` +
      `<h4 style="font-size:12px;font-weight:700;">${DAY_LABELS[day]}</h4>` +
      `<p style="font-size:11px;color:#71717a;margin-bottom:6px;">${(total / 60).toFixed(1)} hours</p>` +
      items.map((t) =>
        `<label style="display:flex;gap:6px;align-items:flex-start;border:1px solid #f4f4f5;border-radius:8px;padding:6px;margin-bottom:6px;font-size:12px;cursor:pointer;">` +
        `${spec.checkboxes ? `<input type="checkbox" style="margin-top:2px;" />` : ""}` +
        `<span><span style="font-weight:600;">${escapeHtml(t.title)}</span><br/>` +
        `<span style="color:#71717a;">${t.minutes}m · ${OWNER_NAMES[t.owner]}${t.blocked ? " · ⛔ blocked" : ""}</span></span></label>`).join("") +
      `</div>`
  }).join("")
  return `<h3 style="font-size:12px;color:#71717a;margin-bottom:6px;">Tasks</h3>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cols}</div>` + totalsHtml(tasks, spec)
}

function calendarViewHtml(spec, calendar = CALENDAR) {
  const day = DAYS.includes(spec.scheduleDay) ? spec.scheduleDay : "fri"
  const added = []
  if (spec.addReading) added.push({ title: `Added · quiet reading time`, start: "10:30", finish: "12:00", added: true })
  if (spec.addGym) added.push({ title: `Added · gym`, start: "12:00", finish: "12:45", added: true })
  const cols = DAYS.map((d) => {
    const blocks = [...(calendar[d] || []), ...(d === day ? added : [])]
    return `<div style="flex:1;min-width:140px;border:1px solid #e4e4e7;border-radius:12px;padding:8px;">` +
      `<h4 style="font-size:12px;font-weight:700;margin-bottom:6px;">${DAY_LABELS[d]}</h4>` +
      (blocks.map((b) =>
        `<div style="border-radius:6px;padding:6px;margin-bottom:6px;font-size:11px;` +
        `${b.added && spec.highlightAdded ? "background:#dcfce7;border:2px solid #16a34a;" : "background:#f4f4f5;border-left:3px solid #a5b4fc;"}">` +
        `<div style="font-weight:600;">${escapeHtml(b.start)} - ${escapeHtml(b.finish)}</div><div>${escapeHtml(b.title)}</div></div>`).join("") || `<p style="font-size:11px;color:#a1a1aa;">Free</p>`) +
      `</div>`
  }).join("")
  return `<h3 style="font-size:12px;color:#71717a;margin-bottom:6px;">Week calendar</h3>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cols}</div>`
}

function listViewHtml(spec) {
  const tasks = tasksFor(spec)
  return `<ul style="font-size:13px;">` + tasks.map((t) =>
    `<li style="padding:6px 0;border-bottom:1px solid #f4f4f5;">${spec.checkboxes ? `<input type="checkbox" /> ` : ""}` +
    `<strong>${escapeHtml(t.title)}</strong> <span style="color:#71717a;">${t.minutes}m · ${OWNER_NAMES[t.owner]}${t.blocked ? " · ⛔ blocked" : ""}</span></li>`).join("") + `</ul>` +
    totalsHtml(tasks, spec)
}

function totalsHtml(tasks, spec) {
  if (!spec.totals) return ""
  const total = tasks.reduce((s, t) => s + t.minutes, 0)
  return `<p style="font-size:11px;color:#71717a;margin-top:8px;">${tasks.length} tasks · ${total}m (${(total / 60).toFixed(1)}h)</p>`
}

// Pure render entry point — tested with Vitest.
export function renderSpecHtml(spec, calendar = CALENDAR) {
  const s = { legend: true, showEstimates: true, highlightAdded: true, ...spec }
  if (s.view === "board" || s.split) return boardViewHtml({ ...s, view: "board" })
  if (s.view === "cards") return cardsViewHtml(s)
  if (s.view === "calendar") return calendarViewHtml(s, calendar)
  if (s.view === "list") return listViewHtml(s)
  return bubblesViewHtml(s)
}

export function datasetHtml() {
  return `<table style="width:100%;border-collapse:collapse;font-size:12px;">` +
    `<thead><tr style="text-align:left;color:#71717a;"><th>Task</th><th>Min</th><th>Owner</th><th>Status</th><th>Day</th></tr></thead><tbody>` +
    TASKS.map((t) => `<tr style="border-top:1px solid #f4f4f5;"><td>${escapeHtml(t.title)}</td><td>${t.minutes}</td>` +
      `<td>${OWNER_NAMES[t.owner]}</td><td>${t.blocked ? "⛔ blocked" : "ready"}</td><td>${t.day}</td></tr>`).join("") +
    `</tbody></table>`
}

// --- Stimulus controller (voice + Jev call + DOM wiring) ---------------------
export default class extends Controller {
  static targets = [
    "prompt", "micButton", "askButton", "canvas", "latency", "questionCount",
    "inspector", "dataset", "apiKey", "keyStatus", "testButton", "status",
    "voiceStatus", "supportWarning", "headline",
  ]

  connect() {
    this.recognition = null
    this.listening = false
    this.apiKeyTarget.value = localStorage.getItem("syft_jev_key") || ""
    this.apiKeyTarget.addEventListener("input", () => {
      localStorage.setItem("syft_jev_key", this.apiKeyTarget.value.trim())
      this.updateKeyStatus()
    })
    this.apiKeyTarget.addEventListener("paste", () => {
      setTimeout(() => {
        localStorage.setItem("syft_jev_key", this.apiKeyTarget.value.trim())
        this.testKey()
      }, 0)
    })
    this.updateKeyStatus()
    this.datasetTarget.innerHTML = datasetHtml()
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) this.supportWarningTarget.classList.remove("hidden")
  }

  disconnect() {
    try { this.recognition?.stop() } catch { /* ignore */ }
  }

  // --- key (shared with the Listening page) ---------------------------------
  updateKeyStatus() {
    const key = this.apiKeyTarget.value.trim()
    const ok = key.length > 0 && localStorage.getItem("syft_jev_key_ok") === key
    this.keyStatusTarget.textContent = ok ? "✓ Key works — Jev will answer the full question set."
      : key ? "Tap Test to verify this key. Without a key, the offline parse renders instead."
      : "Add your key for the full parallel Jev pass — or just Ask and the offline parse renders."
    this.keyStatusTarget.className = "mt-1 text-xs " + (ok ? "text-emerald-600" : "text-zinc-500 dark:text-zinc-400")
  }

  toggleKeyVisibility() {
    this.apiKeyTarget.type = this.apiKeyTarget.type === "password" ? "text" : "password"
  }

  async testKey() {
    const key = this.apiKeyTarget.value.trim()
    if (!key) { this.keyStatusTarget.textContent = "Paste your key first."; return }
    this.keyStatusTarget.textContent = "Testing…"
    try {
      const res = await fetch("/jev_analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
        body: JSON.stringify({ text: "The Eiffel Tower is in Paris.", metrics: ["specificity"], api_key: key }),
      })
      if (res.ok) {
        localStorage.setItem("syft_jev_key_ok", key)
        this.keyStatusTarget.textContent = "✓ Key works."
        this.keyStatusTarget.className = "text-xs mt-1 text-emerald-600"
      } else {
        localStorage.removeItem("syft_jev_key_ok")
        this.keyStatusTarget.textContent = "✗ Key rejected — check it and try again."
        this.keyStatusTarget.className = "text-xs mt-1 text-red-600"
      }
    } catch {
      this.keyStatusTarget.textContent = "✗ Could not reach the server."
      this.keyStatusTarget.className = "text-xs mt-1 text-red-600"
    }
  }

  // --- voice -----------------------------------------------------------------
  toggleVoice() {
    if (this.listening) { try { this.recognition?.stop() } catch { /* ignore */ } return }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      this.voiceStatusTarget.textContent = "Voice not supported here — type your request instead."
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
      this.promptTarget.value = (finalText + interim).trim()
      this.voiceStatusTarget.textContent = interim ? `Hearing: “${interim}…”` : `Heard: “${finalText.trim()}”`
    }
    this.recognition.onerror = (event) => {
      this.listening = false
      this.voiceStatusTarget.textContent = `Mic error: ${event.error} — you can type instead.`
    }
    this.recognition.onend = () => {
      this.listening = false
      this.micButtonTarget.style.background = ""
      const heard = this.promptTarget.value.trim()
      if (heard) {
        // Hands-free: a finished utterance builds immediately.
        this.voiceStatusTarget.textContent = `Heard: “${heard}” — building…`
        this.ask()
      } else {
        this.voiceStatusTarget.textContent = "Didn't catch that — try again or type."
      }
    }
    try {
      this.recognition.start()
      this.listening = true
      this.micButtonTarget.style.background = "#dc2626"
      this.voiceStatusTarget.textContent = "Listening… speak your interface (“Show open work as bubbles…”)."
    } catch (e) {
      this.voiceStatusTarget.textContent = `Could not start mic: ${e.message}`
    }
  }

  promptKeydown(event) {
    if (event.key === "Enter") this.ask()
  }

  promptInput() {
    this.headlineTarget.textContent = this.promptTarget.value.trim() || "Describe the interface you want — speak it or type it."
  }

  useSample(event) {
    const prompt = SAMPLE_PROMPTS[Number(event.currentTarget.dataset.sample)] || SAMPLE_PROMPTS[0]
    this.promptTarget.value = prompt
    this.promptInput()
    this.ask()
  }

  // --- build -------------------------------------------------------------------
  async ask() {
    const prompt = this.promptTarget.value.trim()
    if (!prompt) { this.statusTarget.textContent = "Describe the interface first — speak or type."; return }
    const t0 = performance.now()
    this.headlineTarget.textContent = prompt
    this.askButtonTarget.disabled = true
    this.statusTarget.textContent = "Asking Jev the UI questions in parallel…"
    try {
      const key = this.apiKeyTarget.value.trim()
      if (!key) {
        this.renderOffline(prompt, t0, "no key — offline keyword parse")
        return
      }
      const res = await fetch("/jev_build", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
        body: JSON.stringify({ prompt, api_key: key }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 401) {
        localStorage.removeItem("syft_jev_key_ok")
        this.updateKeyStatus()
        this.renderOffline(prompt, t0, "key rejected — offline keyword parse")
        return
      }
      if (!res.ok || !data.answers) {
        this.renderOffline(prompt, t0, `Jev error (HTTP ${res.status}) — offline keyword parse`)
        return
      }
      const { spec, usedFallback } = specFromAnswers(data.answers || {}, prompt)
      this.renderResult(spec, prompt, t0, {
        count: data.question_count ?? Object.keys(data.answers).length,
        model: data.model || "jev-latest",
        answers: data.answers,
        usedFallback,
      })
    } catch {
      this.renderOffline(prompt, t0, "connection failed — offline keyword parse")
    } finally {
      this.askButtonTarget.disabled = false
    }
  }

  renderOffline(prompt, t0, reason) {
    const spec = inferSpecFromPrompt(prompt)
    this.renderResult(spec, prompt, t0, { count: 0, model: "offline parse", answers: {}, usedFallback: ["all"], offlineReason: reason })
  }

  renderResult(spec, prompt, t0, meta) {
    const ms = Math.round(performance.now() - t0)
    this.canvasTarget.innerHTML = renderSpecHtml(spec)
    this.latencyTarget.textContent = `${ms.toLocaleString()} ms`
    this.questionCountTarget.textContent = meta.count
      ? `${meta.count} multiple-choice answers in parallel · ${meta.model}`
      : `offline parse · ${meta.offlineReason}`
    const conf = (a) => {
      if (a?.confidence != null) return Number(a.confidence)
      if (a?.noul != null) return noulConfidence(a.noul)
      return null
    }
    const rows = Object.entries(meta.answers || {}).slice(0, 60).map(([k, a]) => {
      const val = a?.choice ?? (a?.noul != null ? (Number(a.noul) >= 0.5 ? "yes" : "no") : (a?.score != null ? Number(a.score).toFixed(2) : "?"))
      const c = conf(a)
      const fb = meta.usedFallback?.includes(k) ? " · fallback" : ""
      return `<div>${escapeHtml(k)} = <strong>${escapeHtml(val)}</strong> <span style="color:#a1a1aa;">${c == null ? "" : `conf ${c.toFixed(2)}`}${escapeHtml(fb)}</span></div>`
    })
    this.inspectorTarget.innerHTML = rows.join("") || `<div style="color:#a1a1aa;">offline parse — no Jev answers for this render.</div>`
    this.statusTarget.textContent = `Rendered “${prompt}” as ${spec.view}.` +
      (meta.usedFallback?.length ? ` ${meta.usedFallback.length} answer(s) fell back to keywords.` : " All answers from Jev.")
  }
}
