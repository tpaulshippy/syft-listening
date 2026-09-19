require "net/http"
require "uri"
require "json"

class SpeechController < ApplicationController
  # Public page — no login required
  def show
  end

  # POST /jev_analyze
  # Body: { text: "...", metrics: ["factual_claim","specificity","complexity","grammar","emotion","habits"], api_key: "ts_..." }
  # Proxies to https://api.typesafe.ai/v1/systemone so the browser avoids CORS
  # issues. The API key is forwarded, never stored or logged.
  # State is sent as a map ({ transcript: ... }) so questions reference the
  # material as `transcript`, per TypeSafe's state-vs-questions guidance.
  def analyze
    text = params[:text].to_s.strip
    metrics = Array(params[:metrics]).map(&:to_s) & %w[factual_claim specificity complexity grammar emotion habits]
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
    questions["factual_claim"] = {
      type: "noul",
      instructions: "Does `transcript` make at least one specific, verifiable factual claim about the world?",
      criteria: {
        true: "Names a checkable fact: a number, date, name, place, or event",
        false: "Pure opinion, feelings, or vague remarks with nothing checkable"
      }
    } if metrics.include?("factual_claim")

    questions["specificity"] = {
      type: "score",
      instructions: "How concrete and specific is `transcript`?",
      criteria: [
        "Entirely vague, no details at all",
        "Vague references with no specifics",
        "Some concrete details mixed with vagueness",
        "Mostly concrete: names, numbers, or specifics",
        "Highly specific and precise throughout"
      ]
    } if metrics.include?("specificity")

    questions["complexity"] = {
      type: "score",
      instructions: "How linguistically complex are the sentences in `transcript`?",
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
      instructions: "How grammatically correct is the speaker's language in `transcript`? Ignore likely speech-recognition mistakes (wrong homophones, missing punctuation) and judge the speaker.",
      criteria: [
        "Many grammar errors, hard to understand",
        "Several noticeable errors",
        "Mostly correct with minor slips",
        "Fully grammatically correct"
      ]
    } if metrics.include?("grammar")

    questions["emotion"] = {
      type: "choice",
      instructions: "What emotion does the speaker of `transcript` most likely feel?",
      criteria: {
        neutral: "Calm, matter-of-fact, no strong emotion",
        happy: "Content, pleased, positive",
        excited: "Enthusiastic, energetic, eager",
        anxious: "Worried, nervous, tense",
        frustrated: "Irritated, annoyed, impatient",
        sad: "Down, disappointed, gloomy",
        angry: "Hostile, furious, confrontational",
        other: "No clear emotion from these options"
      }
    } if metrics.include?("emotion")

    if metrics.include?("habits")
      questions["filler"] = {
        type: "noul",
        instructions: "Does `transcript` contain filler words or sounds (um, uh, er, like, you know, I mean)?"
      }
      questions["hedging"] = {
        type: "noul",
        instructions: "Does the speaker hedge in `transcript` (maybe, probably, sort of, kind of, I guess, I think)?"
      }
      questions["repetition"] = {
        type: "noul",
        instructions: "Does the speaker repeat a word, phrase, or idea in `transcript`?"
      }
      questions["question_asked"] = {
        type: "noul",
        instructions: "Does the speaker ask a question in `transcript`?"
      }
    end

    payload = { model: "jev-latest", state: { transcript: text }, questions: questions }

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
      # Log upstream rejections (body holds Jev's error detail, never the key)
      # so validation errors like HTTP 422 can be diagnosed from the message.
      unless upstream.code.to_i == 200
        Rails.logger.warn "Jev API error #{upstream.code}: #{body.truncate(500)}"
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
