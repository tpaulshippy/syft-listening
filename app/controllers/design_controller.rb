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
    when "session_intent" then build_session_intent
    else { error: "Unknown step (expected classify, option_intent, required, session_intent)" }
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
            next_field: "Add another field next",
            finished: "Finished designing (done, finished, that's all)",
            edit_last: "Edit or rename the last field",
            delete_last: "Delete or remove the last field"
          }
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
