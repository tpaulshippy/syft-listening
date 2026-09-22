require "net/http"
require "uri"
require "json"

# Shared Jev (TypeSafe SystemOne) proxy for controllers.
#
# Consolidates the duplicated Net::HTTP boilerplate previously copied across
# Speech, Design, Input, and Studio controllers: endpoint constants,
# API-key resolution, upstream POST with timing, error logging, and response
# rendering, plus the Array-or-JSON-string param parsing those controllers
# all repeat.
module JevProxy
  extend ActiveSupport::Concern

  JEV_URL = "https://api.typesafe.ai/v1/systemone".freeze
  JEV_MODEL = "jev-latest".freeze
  JEV_OPEN_TIMEOUT = 10
  JEV_READ_TIMEOUT = 20

  private

  def jev_api_key
    params[:api_key].to_s.strip.presence || ENV["TYPESAFE_API_KEY"].to_s.strip.presence
  end

  # POSTs payload to Jev, renders the upstream body with its status, and
  # merges extras (e.g. question_count, step, schema) plus upstream_ms into
  # successful Hash responses. Callers with no extras (speech) get a plain
  # passthrough.
  def jev_post(payload, api_key, extras = {})
    uri = URI(JEV_URL)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.open_timeout = JEV_OPEN_TIMEOUT
    http.read_timeout = JEV_READ_TIMEOUT

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
    if parsed.is_a?(Hash) && upstream.code.to_i == 200 && extras.any?
      parsed["upstream_ms"] = elapsed_ms
      extras.each { |key, value| parsed[key.to_s] = value }
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

  # Parses an Array-or-JSON-string param. Returns the Array, or
  # { error: message } when empty, invalid, or not an array.
  def parse_json_array_param(raw, empty_message:, invalid_message:, not_array_message:)
    return { error: empty_message } if raw.to_s.strip.empty?

    begin
      parsed = JSON.parse(raw.to_s)
    rescue JSON::ParserError
      return { error: invalid_message }
    end
    return { error: not_array_message } unless parsed.is_a?(Array)

    parsed
  end

  # Normalizes an array of field hashes to [{ id:, name: }], capped at limit.
  def normalize_id_name_fields(parsed, limit)
    parsed.first(limit).map do |f|
      h = f.respond_to?(:to_unsafe_h) ? f.to_unsafe_h : f.to_h
      { id: h["id"].to_s.strip, name: h["name"].to_s.strip }
    end
  end
end
