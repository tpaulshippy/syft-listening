import { Controller } from "@hotwired/stimulus"

// Tab bar for /studio: Design | Input | Visualize (progressive disclosure).
export default class extends Controller {
  static targets = ["tab", "panel"]

  connect() {
    this.show(this.tabTargets[0]?.dataset.tab || "design")
  }

  show(name) {
    const target = typeof name === "string" ? name : name.currentTarget?.dataset.tab
    for (const t of this.tabTargets) {
      const active = t.dataset.tab === target
      t.setAttribute("aria-selected", active ? "true" : "false")
      t.className = "rounded-full px-3 py-1 text-xs font-medium " + (active
        ? "bg-zinc-950 text-white dark:bg-zinc-50 dark:text-zinc-950"
        : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800")
    }
    for (const p of this.panelTargets) p.classList.toggle("hidden", p.dataset.panel !== target)
  }
}
