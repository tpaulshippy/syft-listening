import { Controller } from "@hotwired/stimulus"

// The studio's single Jev key input. The key lives in localStorage
// ("syft_jev_key"); every tab reads it fresh at session start, so this
// card is the only writer — and the only verifier (Test pings Jev).
export default class extends Controller {
  static targets = ["input", "status"]

  connect() {
    this.inputTarget.value = localStorage.getItem("syft_jev_key") || ""
    this.inputTarget.addEventListener("input", () => {
      localStorage.setItem("syft_jev_key", this.inputTarget.value.trim())
      this.updateStatus()
    })
    this.inputTarget.addEventListener("paste", () => {
      setTimeout(() => {
        localStorage.setItem("syft_jev_key", this.inputTarget.value.trim())
        this.test()
      }, 0)
    })
    this.updateStatus()
  }

  updateStatus() {
    const key = this.inputTarget.value.trim()
    const ok = key.length > 0 && localStorage.getItem("syft_jev_key_ok") === key
    this.statusTarget.textContent = ok ? "✓ Key works — Jev answers every question."
      : key ? "Tap Test to verify this key."
      : "Add your key — every request here is answered by Jev."
    this.statusTarget.className = "mt-1 text-xs " + (ok ? "text-emerald-600" : "text-zinc-500 dark:text-zinc-400")
  }

  toggleVisibility() {
    this.inputTarget.type = this.inputTarget.type === "password" ? "text" : "password"
  }

  async test() {
    const key = this.inputTarget.value.trim()
    if (!key) { this.statusTarget.textContent = "Paste your key first."; return }
    this.statusTarget.textContent = "Testing…"
    try {
      const res = await fetch("/jev_analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content },
        body: JSON.stringify({ text: "The Eiffel Tower is in Paris.", metrics: ["specificity"], api_key: key }),
      })
      if (res.ok) {
        localStorage.setItem("syft_jev_key_ok", key)
        this.updateStatus()
      } else {
        localStorage.removeItem("syft_jev_key_ok")
        this.statusTarget.textContent = "✗ Key rejected — check it and try again."
        this.statusTarget.className = "mt-1 text-xs text-red-600"
      }
    } catch {
      this.statusTarget.textContent = "✗ Could not reach the server."
      this.statusTarget.className = "mt-1 text-xs text-red-600"
    }
  }
}
