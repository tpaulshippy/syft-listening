require "net/http"
require "uri"
require "json"

# Data design interview — voice-driven, Jev-automated, no LLM text generation.
#
# The user provides all free text directly (field names, option names) via
# voice transcription or typing. Jev only classifies: field types, option /
# session intents, and required flags. It never invents names or options.
#
# Steps (frontend drives the state machine, backend builds the question set):
# - classify: state = { field_name } -> field_type choice + needs_options noul
# - option_intent: state = { transcript, field_name, options_so_far } ->
#   intent choice (add_option / done_options / remove_last)
# - required: state = { transcript, field_name } -> required noul
#   (kept for API compatibility; the UI now asks once at the end instead)
# - required_fields: state = { transcript, fields: [names] } -> one noul per
#   field (the fan-out that scales with schema width)
# - session_intent: state = { transcript, field_count } ->
#   intent choice (next_field / finished / edit_last / delete_last)
class DesignController < ApplicationController
  JEV_URL = "https://api.typesafe.ai/v1/systemone".freeze
  JEV_MODEL = "jev-latest".freeze

  FIELD_TYPES = %w[text number date time email yes_no choice_single choice_multiple].freeze
  MAX_NAME_CHARS = 60
  MAX_FIELDS = 20
  MAX_OPTIONS = 30

  def classify
    step = params[:step].to_s.strip.presence || "classify"
    api_key = params[:api_key].to_s.strip.presence || ENV["TYPESAFE_API_KEY"].to_s.strip.presence
    return render json: { error: "Missing Jev API key. Paste your TypeSafe key to design." }, status: :unauthorized if api_key.blank?

    built = build_for_step(step)
    return render json: { error: built[:error] }, status: :bad_request if built[:error]

    payload = { model: JEV_MODEL, state: built[:state], questions: built[:questions] }
    post_to_jev(payload, api_key, built[:questions].size, step)
  end

  private

  def build_for_step(step)
    case step
    when "classify" then build_classify
    when "option_intent" then build_option_intent
    when "required" then build_required
    when "required_fields" then build_required_fields
    when "session_intent" then build_session_intent
    when "edit_intent" then build_edit_intent
    when "change_type" then build_change_type
    else { error: "Unknown step (expected classify, option_intent, required, required_fields, session_intent, edit_intent, change_type)" }
    end
  end

  def build_classify
    name = params[:field_name].to_s.strip
    return { error: "No field name provided" } if name.blank?
    return { error: "Field name too long (max #{MAX_NAME_CHARS} chars)" } if name.length > MAX_NAME_CHARS

    {
      state: { field_name: name },
      questions: {
        "field_type" => {
          type: "choice",
          instructions: "What data type best fits a field named `field_name`?",
          criteria: field_type_criteria
        },
        "needs_options" => {
          type: "noul",
          instructions: "Does a field named `field_name` need a fixed list of options (a dropdown / multiple choice)?"
        }
      }
    }
  end

  def build_option_intent
    transcript = params[:transcript].to_s.strip
    return { error: "No transcript provided" } if transcript.blank?

    field_name = params[:field_name].to_s.strip
    options = Array(params[:options_so_far]).map(&:to_s).first(MAX_OPTIONS)
    {
      state: { transcript: transcript, field_name: field_name, options_so_far: options },
      questions: {
        "intent" => {
          type: "choice",
          instructions: "What does the speaker want in `transcript` while listing options for `field_name` (so far: `options_so_far`)?",
          criteria: {
            add_option: "Dictating a new option to add to the list",
            done_options: "Done listing options (done, finished, that's all, next)",
            remove_last: "Remove or undo the last option (remove, undo, delete that)"
          }
        }
      }
    }
  end

  def build_required
    transcript = params[:transcript].to_s.strip
    return { error: "No transcript provided" } if transcript.blank?

    {
      state: { transcript: transcript, field_name: params[:field_name].to_s.strip },
      questions: {
        "required" => {
          type: "noul",
          instructions: "Does the speaker say in `transcript` that `field_name` is required (yes / must fill / required) rather than optional?"
        }
      }
    }
  end

  # End-of-session: which of the finished fields are required? One noul per
  # field over the spoken answer ("email and birthday", "all of them", "none").
  def build_required_fields
    transcript = params[:transcript].to_s.strip
    return { error: "No transcript provided" } if transcript.blank?

    fields = required_field_list
    return { error: fields[:error] } if fields[:error]

    {
      state: { transcript: transcript, fields: fields[:fields].map { |f| f[:name] } },
      questions: fields[:fields].each_with_object({}) do |field, qs|
        qs["required_#{field[:id]}"] = {
          type: "noul",
          instructions: "Is #{field[:name]} required according to `transcript`? Answer yes if `transcript` names #{field[:name]} as required, or says all / every field / everything is required. Answer no if `transcript` says none / nothing is required, says #{field[:name]} is optional, or does not include #{field[:name]} as required."
        }
      end
    }
  end

  def required_field_list
    raw = params[:fields]
    parsed = raw.is_a?(Array) ? raw : parse_fields_json(raw.to_s)
    return parsed if parsed.is_a?(Hash) && parsed[:error]

    fields = parsed.first(MAX_FIELDS).map do |f|
      h = f.respond_to?(:to_unsafe_h) ? f.to_unsafe_h : f.to_h
      { id: h["id"].to_s.strip, name: h["name"].to_s.strip }
    end
    return { error: "No fields provided" } if fields.empty?
    return { error: "Fields need ids and names" } if fields.any? { |f| f[:id].empty? || f[:name].empty? }

    { fields: fields }
  end

  def parse_fields_json(raw)
    return { error: "No fields provided" } if raw.strip.empty?

    begin
      parsed = JSON.parse(raw)
    rescue JSON::ParserError
      return { error: "Fields must be a JSON array" }
    end
    return { error: "Fields must be an array" } unless parsed.is_a?(Array)

    parsed
  end

  def build_session_intent
    transcript = params[:transcript].to_s.strip
    return { error: "No transcript provided" } if transcript.blank?

    {
      state: { transcript: transcript, field_count: params[:field_count].to_i },
      questions: {
        "intent" => {
          type: "choice",
          instructions: "What does the speaker want in `transcript` (design session with `field_count` fields so far)?",
          criteria: {
            content: "Dictating the field name — any name, word, or phrase, not a session command",
            next_field: "Add another field next",
            finished: "Finished designing (done, finished, that's all)",
            edit_last: "Edit or rename the last field",
            delete_last: "Delete or remove the last field"
          }
        }
      }
    }
  end

  # Voice edit menu: which aspect of the tapped field does the speaker name?
  def build_edit_intent
    transcript = params[:transcript].to_s.strip
    return { error: "No transcript provided" } if transcript.blank?

    {
      state: { transcript: transcript, field_name: params[:field_name].to_s.strip },
      questions: {
        "intent" => {
          type: "choice",
          instructions: "Which part of `field_name` does the speaker want to change in `transcript`?",
          criteria: {
            name: "Rename the field (its name or title)",
            type: "Change the data type (saying \"type\" means this)",
            options: "Change the fixed list of options",
            required: "Change whether the field is required",
            remove: "Delete or remove the whole field",
            done: "Nothing more, stop, or cancel (done, finished, cancel, stop, never mind)"
          }
        }
      }
    }
  end

  # Voice retype: the speaker names a new data type for an existing field.
  def build_change_type
    transcript = params[:transcript].to_s.strip
    return { error: "No transcript provided" } if transcript.blank?

    {
      state: { transcript: transcript, field_name: params[:field_name].to_s.strip },
      questions: {
        "field_type" => {
          type: "choice",
          instructions: "What data type does the speaker want for `field_name` in `transcript`?",
          criteria: field_type_criteria
        }
      }
    }
  end

  def field_type_criteria
    {
      text: "Short or long free text (names, notes, descriptions)",
      number: "A numeric quantity (amount, count, price)",
      date: "A calendar date (birthday, due date)",
      time: "A time of day (alarm, meeting time)",
      email: "An email address",
      yes_no: "A yes/no or true/false answer",
      choice_single: "Pick one from a fixed list of options",
      choice_multiple: "Pick several from a fixed list of options"
    }
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
