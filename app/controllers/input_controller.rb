require "net/http"
require "uri"
require "json"

# Data input — voice-driven row filling, Jev-automated, no LLM text.
#
# The user speaks every value verbatim. Jev only maps and validates:
# - choice_single: one `choice` over the field's enumerated options
#   (same guard as studio filter values — must name a real option)
# - choice_multiple: one noul per option (same fan-out as studio include_*)
# - yes_no: one noul
# - text/number/date/time/email: one `valid` noul per field (value itself is
#   the transcript, used verbatim)
# plus one shared `control` choice per prompt
# (answer / repeat / skip / edit_previous / finish_row).
#
# Grouping: open types are always solo (one transcript cannot be split into
# two free-text values without an LLM). Closed types (yes_no, choice_*) may
# be asked together — the backend proposes the next contiguous pair, Jev
# decides via the plan_group noul. Order is never reordered.
class InputController < ApplicationController
  JEV_URL = "https://api.typesafe.ai/v1/systemone".freeze
  JEV_MODEL = "jev-latest".freeze

  OPEN_TYPES = %w[text number date time email].freeze
  CLOSED_TYPES = %w[yes_no choice_single choice_multiple].freeze
  MAX_OPTIONS = 30
  MAX_FIELDS_PER_PROMPT = 2
  # Jev date parse: month/day/year choices (Jev can't emit free text, but
  # Choice supports up to 255 options, so years ride as enumerated options).
  DATE_MONTHS = %w[january february march april may june july august september october november december].freeze
  DATE_MIN_YEAR = 1930
  DATE_YEAR_HEADROOM = 10

  def resolve
    step = params[:step].to_s.strip.presence || "answer"
    api_key = params[:api_key].to_s.strip.presence || ENV["TYPESAFE_API_KEY"].to_s.strip.presence
    return render json: { error: "Missing Jev API key. Paste your TypeSafe key for input." }, status: :unauthorized if api_key.blank?

    built = build_for_step(step)
    return render json: { error: built[:error] }, status: :bad_request if built[:error]

    payload = { model: JEV_MODEL, state: built[:state], questions: built[:questions] }
    post_to_jev(payload, api_key, built[:questions].size, step)
  end

  private

  def build_for_step(step)
    case step
    when "plan_group" then build_plan_group
    when "answer" then build_answer
    when "row_intent" then build_row_intent
    when "edit_field" then build_edit_field
    else { error: "Unknown step (expected plan_group, answer, row_intent, edit_field)" }
    end
  end

  # Proposes the next two closed-type fields as one prompt; Jev confirms.
  def build_plan_group
    fields = input_fields
    return { error: fields[:error] } if fields[:error]
    return { error: "Need at least two fields to consider grouping" } if fields[:fields].size < 2

    a, b = fields[:fields].first(2)
    unless CLOSED_TYPES.include?(a[:type]) && CLOSED_TYPES.include?(b[:type])
      return { error: "Only closed types (yes_no, choice_*) can share a prompt" }
    end

    {
      state: { field_a: a[:name], type_a: a[:type], field_b: b[:name], type_b: b[:type] },
      questions: {
        "ask_together" => {
          type: "noul",
          instructions: "Can `field_a` (#{a[:type]}) and `field_b` (#{b[:type]}) be asked in a single spoken prompt, or should each be asked alone?"
        }
      }
    }
  end

  # One transcript mapped onto 1-2 fields in parallel, plus shared control.
  def build_answer
    transcript = params[:transcript].to_s.strip
    return { error: "No transcript provided" } if transcript.blank?

    fields = input_fields
    return { error: fields[:error] } if fields[:error]
    return { error: "Too many fields per prompt (max #{MAX_FIELDS_PER_PROMPT})" } if fields[:fields].size > MAX_FIELDS_PER_PROMPT

    field_list = fields[:fields]
    unless groupable?(field_list)
      return { error: "Only one open-type field per prompt, or up to two closed-type fields" }
    end

    state = { transcript: transcript, fields: field_list.map { |f| f.slice(:name, :type, :required) } }
    questions = { "control" => control_question }
    field_list.each_with_index do |field, i|
      suffix = i.zero? ? "" : "_2"
      state["options#{suffix}"] = field[:options] if field[:options]&.any?
      questions.merge!(answer_questions(field, suffix))
    end
    { state: state, questions: questions }
  end

  def groupable?(fields)
    return false if fields.empty?
    return true if fields.size == 1
    fields.size == MAX_FIELDS_PER_PROMPT && fields.all? { |f| CLOSED_TYPES.include?(f[:type]) }
  end

  def input_fields
    raw = params[:fields]
    parsed = raw.is_a?(Array) ? raw : parse_fields_json(raw.to_s)
    return parsed if parsed.is_a?(Hash) && parsed[:error]

    fields = parsed.first(20).map do |f|
      h = f.respond_to?(:to_unsafe_h) ? f.to_unsafe_h : f.to_h
      {
        name: h["name"].to_s.strip,
        type: h["type"].to_s.strip,
        required: h["required"] == true,
        options: Array(h["options"]).map(&:to_s).map(&:strip).reject(&:empty?).first(MAX_OPTIONS)
      }
    end
    return { error: "No fields provided" } if fields.empty?
    return { error: "Fields need names" } if fields.any? { |f| f[:name].empty? }

    bad = fields.find { |f| !(OPEN_TYPES + CLOSED_TYPES).include?(f[:type]) }
    return { error: "Unknown field type: #{bad[:type]}" } if bad

    missing = fields.select { |f| f[:type].start_with?("choice_") && f[:options].empty? }
    return { error: "Choice fields need options: #{missing.map { |f| f[:name] }.join(', ')}" } unless missing.empty?

    { fields: fields }
  end

  def parse_fields_json(raw)
    return { error: "No fields provided (design fields first)" } if raw.strip.empty?

    begin
      parsed = JSON.parse(raw)
    rescue JSON::ParserError
      return { error: "Fields must be a JSON array" }
    end
    return { error: "Fields must be an array of field objects" } unless parsed.is_a?(Array)

    parsed
  end

  def control_question
    {
      type: "choice",
      instructions: "What does the speaker want in `transcript`?",
      criteria: {
        answer: "Answering the question(s) asked",
        repeat: "Didn't hear or wants the question repeated",
        skip: "Skip this question (skip, next, don't answer)",
        edit_previous: "Go back and change the previous answer",
        finish_row: "Done with this row (finished, done, save it)"
      }
    }
  end

  # Voice field picker: which question does the speaker want to change?
  # One choice over field ids (names ride in plain quotes, never backticked,
  # so spaced names resolve). Unsure repeats the picker.
  def build_edit_field
    transcript = params[:transcript].to_s.strip
    return { error: "No transcript provided" } if transcript.blank?

    fields = edit_field_list
    return { error: fields[:error] } if fields[:error]

    {
      state: { transcript: transcript, fields: fields[:fields].map { |f| f[:name] } },
      questions: {
        "field" => {
          type: "choice",
          instructions: "Which field does the speaker want to change in `transcript`?",
          criteria: fields[:fields].each_with_object({}) { |f, h| h[f[:id]] = "`transcript` means the field \"#{f[:name]}\"" }
        }
      }
    }
  end

  def edit_field_list
    raw = params[:fields]
    parsed = raw.is_a?(Array) ? raw : parse_fields_json(raw.to_s)
    return parsed if parsed.is_a?(Hash) && parsed[:error]

    fields = parsed.first(20).map do |f|
      h = f.respond_to?(:to_unsafe_h) ? f.to_unsafe_h : f.to_h
      { id: h["id"].to_s.strip, name: h["name"].to_s.strip }
    end
    return { error: "No fields provided" } if fields.empty?
    return { error: "Fields need ids and names" } if fields.any? { |f| f[:id].empty? || f[:name].empty? }

    { fields: fields }
  end

  # Voice row menu: change the tapped row or delete it?
  def build_row_intent
    transcript = params[:transcript].to_s.strip
    return { error: "No transcript provided" } if transcript.blank?

    {
      state: { transcript: transcript },
      questions: {
        "intent" => {
          type: "choice",
          instructions: "What does the speaker want to do with the row in `transcript`?",
          criteria: {
            edit: "Change answers in the row (edit, change, update)",
            delete: "Remove the whole row (delete, remove)"
          }
        }
      }
    }
  end

  def answer_questions(field, suffix)
    label = field[:name]
    case field[:type]
    when "date"
      date_questions(field, suffix)
    when "choice_single"
      {
        "value#{suffix}" => {
          type: "choice",
          instructions: "Which option of #{label} (`options#{suffix}`) does `transcript` pick?",
          criteria: field[:options].each_with_object({}) { |o, h| h[o] = "`transcript` picks #{o}" }
        }
      }
    when "choice_multiple"
      field[:options].each_with_object({}) do |opt, qs|
        qs["pick#{suffix}_#{opt}"] = {
          type: "noul",
          instructions: "Does `transcript` select the option #{opt} for #{label}?"
        }
      end
    when "yes_no"
      {
        "value#{suffix}" => {
          type: "noul",
          instructions: "Does `transcript` answer yes (rather than no) for #{label}?"
        }
      }
    else
      {
        "valid#{suffix}" => {
          type: "noul",
          instructions: "Does `transcript` contain #{validity_check(field[:type])} for #{label} (not empty, not asking to skip)?"
        }
      }
    end
  end

  # Dates are parsed, not just validated: one choice each for month, day,
  # and year, composed into YYYY-MM-DD on the frontend. The field name is
  # interpolated directly (state carries the plural `fields` list, so a
  # singular `field` backtick would not resolve).
  def date_questions(field, suffix)
    label = field[:name]
    {
      "month#{suffix}" => {
        type: "choice",
        instructions: "Which month does `transcript` name for #{label}?",
        criteria: DATE_MONTHS.each_with_object({}) { |m, h| h[m] = "`transcript` names #{m.capitalize}" }
      },
      "day#{suffix}" => {
        type: "choice",
        instructions: "Which day of the month does `transcript` name for #{label} (1-31)?",
        criteria: (1..31).each_with_object({}) { |d, h| h[d.to_s] = "`transcript` names day #{d}" }
      },
      "year#{suffix}" => {
        type: "choice",
        instructions: "Which year does `transcript` name for #{label}?",
        criteria: (DATE_MIN_YEAR..date_max_year).each_with_object({}) { |y, h| h[y.to_s] = "`transcript` names #{y}" }
      }
    }
  end

  def date_max_year
    Time.current.year + DATE_YEAR_HEADROOM
  end

  # What Jev checks for the remaining open types (dates ride the month /
  # day / year choices above instead of a validity noul).
  def validity_check(type)
    case type
    when "time" then "a real time of day — an hour (0–23) and minutes (0–59)"
    when "number" then "a real number — digits, optionally negative or decimal"
    when "email" then "a real email address — a name, an @ sign, and a domain"
    else "a non-empty answer"
    end
  end

  def post_to_jev(payload, api_key, question_count, step)
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
      parsed["step"] = step
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
