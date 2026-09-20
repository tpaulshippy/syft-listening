require "rails_helper"

# Linter-like contract test for the main page: the ERB view and the
# Stimulus controller must agree, otherwise the page renders but
# silently does nothing (missing targets / actions fail at runtime,
# and neither rubocop nor brakeman catches that).
RSpec.describe "Speech main page Stimulus contract", type: :request do
  VIEW = Rails.root.join("app/views/speech/show.html.erb").read
  JS = Rails.root.join("app/javascript/controllers/speech_insights_controller.js").read

  def erb_targets
    VIEW.scan(/data-speech-insights-target="(\w+)"/).flatten.uniq
  end

  def js_targets
    block = JS[/static targets\s*=\s*\[(.*?)\]/m, 1] or return []
    block.scan(/["'](\w+)["']/).flatten.uniq
  end

  def erb_actions
    VIEW.scan(/speech-insights#(\w+)/).flatten.uniq
  end

  def js_methods
    JS.scan(/^\s*(?:async\s+)?(\w+)\s*\(/).flatten.uniq
  end

  it "declares every data-speech-insights-target used by the view" do
    missing = erb_targets - js_targets
    expect(missing).to be_empty,
      "view uses targets missing from static targets: #{missing.inspect}"
  end

  it "uses every declared Stimulus target in the view (no dead/renamed targets)" do
    unused = js_targets - erb_targets
    expect(unused).to be_empty,
      "controller declares targets missing from the view: #{unused.inspect}"
  end

  it "implements every data-action handler referenced by the view" do
    missing = erb_actions - js_methods
    expect(missing).to be_empty,
      "view references actions missing from the controller: #{missing.inspect}"
  end

  it "sends only metrics the Rails proxy accepts" do
    accepted = %w[factual_claim specificity complexity grammar emotion habits]
    toggles = VIEW.scan(/<input[^>]*type="checkbox"[^>]*value="(\w+)"/).flatten.uniq
    expect(toggles).to match_array(accepted),
      "metric toggles #{toggles.inspect} drifted from controller allowlist #{accepted.inspect}"
  end
end
