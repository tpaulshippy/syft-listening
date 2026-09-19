require "net/http"
require "uri"
require "json"

class SpeechController < ApplicationController
  # Public page — no login required
  def show
  end

  # POST /jev_analyze
  # Body: { text: "...", metrics: ["factual","complexity","grammar","emotion"], api_key: "ts_..." }
  # Proxies to https://api.typesafe.ai/v1/systemone so the browser avoids CORS
  # issues. The API key is forwarded, never stored or logged.
  def analyze
    text = params[:text].to_s.strip
    metrics = Array(params[:metrics]).map(&:to_s) & %w[factual complexity grammar emotion]
    api_key = params[:api_key].to_s.strip.presence || ENV["TYPESAFE_API_KEY"].to_s.strip.presence

    if text.blank?
      return render json: { error: "No text provided" }, status: :bad_request
    end

    if metrics.empty?
      return render json: { error: "No metrics selected" }, status: :bad_request
    end

    if api_key.blank?
      return render json: { error: "Missing Jev API key. Paste your TypeSafe key to analyze." }, status: :unauthorized
    end

    questions = {}
    questions["factual"] = {
      type: "score",
      instructions: "How factual is this spoken statement?",
      criteria: [
        "Pure opinion, feelings, or made-up claims with no verifiable facts",
        "Mostly opinion with some vague factual references",
        "Mix of opinions and plausible factual claims",
        "Mostly specific, verifiable factual claims",
        "Highly factual, precise, verifiable statements"
      ]
    } if metrics.include?("factual")

    questions["complexity"] = {
      type: "score",
      instructions: "How linguistically complex are the sentences?",
      criteria: [
        "Very simple: short, basic words, short sentences",
        "Simple everyday language",
        "Moderately complex: longer sentences, some subordinate clauses",
        "Complex: rich vocabulary, nested clauses",
        "Highly complex / academic: dense, sophisticated structure"
      ]
    } if metrics.include?("complexity")

    questions["grammar"] = {
      type: "score",
      instructions: "How grammatically correct is this speech transcript?",
      criteria: [
        "Many grammar errors, hard to understand",
        "Several noticeable errors",
        "Mostly correct with minor slips",
        "Fully grammatically correct"
      ]
    } if metrics.include?("grammar")

    questions["emotion"] = {
      type: "choice",
      instructions: "What emotion does the speaker most likely feel?",
      criteria: {
        neutral: "Calm, matter-of-fact, no strong emotion",
        happy: "Content, pleased, positive",
        excited: "Enthusiastic, energetic, eager",
        anxious: "Worried, nervous, tense",
        frustrated: "Irritated, annoyed, impatient",
        sad: "Down, disappointed, gloomy",
        angry: "Hostile, furious, confrontational"
      }
    } if metrics.include?("emotion")

    payload = { model: "jev-latest", state: text, questions: questions }

    uri = URI("https://api.typesafe.ai/v1/systemone")
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.open_timeout = 10
    http.read_timeout = 20

    request = Net::HTTP::Post.new(uri.path, {
      "Authorization" => "Bearer #{api_key}",
      "Content-Type" => "application/json"
    })
    request.body = payload.to_json

    begin
      upstream = http.request(request)
      body = upstream.body.to_s
      parsed = begin
        JSON.parse(body)
      rescue JSON::ParserError
        { "raw" => body }
      end
      render json: parsed, status: upstream.code.to_i
    rescue Net::OpenTimeout, Net::ReadTimeout => e
      Rails.logger.warn "Jev API timeout: #{e.class}"
      render json: { error: "Jev API timed out, try again." }, status: :bad_gateway
    rescue => e
      Rails.logger.warn "Jev proxy error: #{e.class}"
      render json: { error: "Could not reach Jev API." }, status: :bad_gateway
    end
  end
end
