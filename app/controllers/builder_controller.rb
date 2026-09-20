require "net/http"
require "uri"
require "json"

# Voice UI builder — the "153 multiple-choice questions" pattern from the demo.
#
# How the demo works (reverse-engineered): one Jev SystemOne call per user
# request. State = { request, tasks, calendar }. Questions = every UI decision
# the renderer can express, enumerated up front as typed questions (choice /
# noul / score). Jev answers them all in parallel (~70-500ms model time); the
# frontend then renders deterministically from the answers — no LLM-generated
# code, so no hallucinated components and every decision carries a confidence.
# The demo's ~153 questions is the same pattern scaled up with per-task /
# per-field flags; this controller ships the core decision space (~45
# questions: 7 choices + detail score + ~24 feature nouls + one include flag
# per task) and the renderer ignores answers it doesn't need (speculative
# fan-out).
class BuilderController < ApplicationController
  JEV_URL = "https://api.typesafe.ai/v1/systemone".freeze
  JEV_MODEL = "jev-latest".freeze

  # Demo dataset mirroring the Tempo screenshots: open launch work with an
  # owner, an estimate, a blocked flag, and a due day.
  TASKS = [
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
    { id: "demo_speakers", title: "Confirm demo speakers", minutes: 20, owner: "sam", blocked: false, day: "wed" }
  ].freeze

  # Existing calendar blocks (Tue 9/15 - Fri 9/18) from the demo's 4th shot.
  CALENDAR = {
    "tue" => [ { title: "Priya 1:1", start: "10:30", finish: "11:00" } ],
    "wed" => [
      { title: "Deep work hold", start: "9:00", finish: "10:00" },
      { title: "Go-to-market", start: "12:00", finish: "13:00" },
      { title: "Press check-in", start: "15:30", finish: "16:00" }
    ],
    "thu" => [
      { title: "Team planning", start: "10:00", finish: "11:00" },
      { title: "Support readiness", start: "13:00", finish: "13:30" },
      { title: "Launch review", start: "15:30", finish: "16:30" }
    ],
    "fri" => [ { title: "Launch room", start: "9:00", finish: "10:30" } ]
  }.freeze

  def show
  end

  # POST /jev_build — Body: { prompt: "...", api_key: "ts_..." }
  # State (request + dataset) lives server-side so the client only sends the
  # prompt; the key is forwarded, never stored or logged.
  def analyze
    prompt = params[:prompt].to_s.strip
    api_key = params[:api_key].to_s.strip.presence || ENV["TYPESAFE_API_KEY"].to_s.strip.presence

    return render json: { error: "No request provided" }, status: :bad_request if prompt.blank?
    return render json: { error: "Missing Jev API key. Paste your TypeSafe key to build." }, status: :unauthorized if api_key.blank?

    questions = build_questions
    payload = {
      model: JEV_MODEL,
      state: { request: prompt, tasks: TASKS, calendar: CALENDAR },
      questions: questions
    }
    post_to_jev(payload, api_key, questions.size)
  end

  private

  def build_questions
    {
      "view" => {
        type: "choice",
        instructions: "Which view does `request` ask for over `tasks` / `calendar`?",
        criteria: {
          bubbles: "Sized bubbles / bubble chart, area from estimates",
          cards: "Task cards with checkboxes, grouped by day",
          board: "Split board (e.g. blocked left, ready right)",
          calendar: "Week calendar, possibly finding/adding time",
          list: "Plain list or anything not covered above"
        }
      },
      "group_by" => {
        type: "choice",
        instructions: "How should `request` group the tasks?",
        criteria: {
          none: "One flat group, no grouping",
          status: "By blocked vs ready / open vs done",
          owner: "By owner (you, sam, maya, priya)",
          day: "By day (tue, wed, thu, fri)"
        }
      },
      "color_by" => {
        type: "choice",
        instructions: "What should drive bubble/card colour in `request`?",
        criteria: {
          owner: "Coloured by owner",
          status: "Coloured by blocked vs ready",
          day: "Coloured by day",
          none: "No data-driven colouring"
        }
      },
      "size_by" => {
        type: "choice",
        instructions: "What should drive bubble area in `request`?",
        criteria: {
          minutes: "Area from estimated minutes",
          equal: "All bubbles the same size"
        }
      },
      "sort_by" => {
        type: "choice",
        instructions: "How should items be ordered for `request`?",
        criteria: {
          minutes_desc: "Largest estimate first",
          title: "Alphabetical by title",
          owner: "Grouped/ordered by owner",
          day: "Ordered by day tue-fri"
        }
      },
      "schedule_day" => {
        type: "choice",
        instructions: "If `request` schedules calendar time, on which day?",
        criteria: {
          tue: "Tuesday 9/15",
          wed: "Wednesday 9/16",
          thu: "Thursday 9/17",
          fri: "Friday 9/18"
        }
      },
      "density" => {
        type: "choice",
        instructions: "How dense should the layout for `request` be?",
        criteria: {
          comfortable: "Roomy cards and bubbles",
          compact: "Dense, many items visible at once"
        }
      },
      "detail" => {
        type: "score",
        instructions: "How much detail should each item show for `request`?",
        criteria: [
          "Titles only",
          "Titles plus estimates",
          "Titles plus estimates plus owners and status"
        ]
      }
    }.merge(feature_questions).merge(task_questions)
  end

  def feature_questions
    {
      "split_blocked_ready" => noul("Does `request` ask to split blocked vs ready work (e.g. blocked left, ready right)?"),
      "flag_blocked" => noul("Does `request` ask to flag or highlight blocked tasks?"),
      "show_estimates" => noul("Should estimates/minutes be shown (`request` mentions time, size, or estimates)?"),
      "show_owner" => noul("Should the owner be shown on each item for `request`?"),
      "show_checkboxes" => noul("Does `request` ask for completion checkboxes?"),
      "show_legend" => noul("Should a legend (owner colours, blocked marker) be shown for `request`?"),
      "show_day_headers" => noul("Should day headers (tue/wed/thu/fri) be shown for `request`?"),
      "show_minutes_total" => noul("Should a total-minutes summary be shown for `request`?"),
      "keep_bubbles" => noul("Does `request` say to keep the bubble style?"),
      "filter_blocked_only" => noul("Does `request` ask to show blocked work only?"),
      "filter_ready_only" => noul("Does `request` ask to show ready/open work only?"),
      "exclude_blocked" => noul("Does `request` ask to hide or exclude blocked tasks?"),
      "calendar_find_slot" => noul("Does `request` ask to find free time in `calendar`?"),
      "calendar_add_reading" => noul("Does `request` ask to add quiet reading time?"),
      "calendar_add_gym" => noul("Does `request` ask to add gym time?"),
      "reading_90m" => noul("Does `request` specify 90 minutes of reading?"),
      "gym_45m" => noul("Does `request` specify 45 minutes of gym?"),
      "highlight_added" => noul("Should newly added calendar blocks be highlighted for `request`?"),
      "switch_to_cards" => noul("Does `request` ask to switch to cards?"),
      "mark_complete" => noul("Does `request` ask to mark anything complete or checked off?"),
      "mention_quiet" => noul("Does `request` mention quiet or focus time?"),
      "mention_after" => noul("Does `request` ask to place one block after another?"),
      "mention_open_work" => noul("Does `request` mention open work or the backlog?"),
      "mention_launch" => noul("Does `request` mention the launch?")
    }
  end

  def task_questions
    # Per-task include flags — this fan-out is what scales the demo to ~153
    # questions: one cheap noul per item the renderer may need.
    TASKS.each_with_object({}) do |task, questions|
      questions["include_#{task[:id]}"] = noul(
        "Is the task `#{task[:title]}` (#{task[:minutes]}m, owner #{task[:owner]}" \
        "#{task[:blocked] ? ', blocked' : ', ready'}, due #{task[:day]}) in scope for `request`?"
      )
    end
  end

  def noul(instructions)
    { type: "noul", instructions: instructions }
  end

  def post_to_jev(payload, api_key, question_count)
    uri = URI(JEV_URL)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.open_timeout = 10
    http.read_timeout = 20

    request = Net::HTTP::Post.new(uri.path, {
                                    "Authorization" => "Bearer #{api_key}",
                                    "Content-Type" => "application/json"
                                  })
    request.body = payload.to_json

    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    upstream = http.request(request)
    elapsed_ms = ((Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000).round

    body = upstream.body.to_s
    parsed = parse_upstream_body(body)
    Rails.logger.warn "Jev API error #{upstream.code}: #{body.truncate(500)}" unless upstream.code.to_i == 200
    if parsed.is_a?(Hash) && upstream.code.to_i == 200
      parsed["question_count"] = question_count
      parsed["upstream_ms"] = elapsed_ms
    end
    render json: parsed, status: upstream.code.to_i
  rescue Net::OpenTimeout, Net::ReadTimeout => e
    Rails.logger.warn "Jev API timeout: #{e.class}"
    render json: { error: "Jev API timed out, try again." }, status: :bad_gateway
  rescue StandardError => e
    Rails.logger.warn "Jev proxy error: #{e.class}"
    render json: { error: "Could not reach Jev API." }, status: :bad_gateway
  end

  def parse_upstream_body(body)
    JSON.parse(body)
  rescue JSON::ParserError
    { "raw" => body }
  end
end
