class SpeechController < ApplicationController
  include JevProxy

  ALLOWED_METRICS = %w[factual_claim specificity complexity grammar emotion habits].freeze

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
    text = extract_text
    metrics = extract_metrics
    api_key = jev_api_key

    return render json: { error: "No text provided" }, status: :bad_request if text.blank?
    return render json: { error: "No metrics selected" }, status: :bad_request if metrics.empty?
    return render json: { error: "Missing Jev API key. Paste your TypeSafe key to analyze." }, status: :unauthorized if api_key.blank?

    payload = { model: JEV_MODEL, state: { transcript: text }, questions: build_questions(metrics) }
    jev_post(payload, api_key)
  end

  private

  def extract_text
    params[:text].to_s.strip
  end

  def extract_metrics
    Array(params[:metrics]).map(&:to_s) & ALLOWED_METRICS
  end

  def build_questions(metrics)
    builders = {
      "factual_claim" => method(:factual_claim_question),
      "specificity" => method(:specificity_question),
      "complexity" => method(:complexity_question),
      "grammar" => method(:grammar_question),
      "emotion" => method(:emotion_question),
      "habits" => method(:habit_questions)
    }
    metrics.each_with_object({}) do |metric, questions|
      builder = builders[metric]
      next unless builder

      result = builder.call
      result.is_a?(Array) ? result.each { |k, v| questions[k] = v } : questions[metric] = result
    end
  end

  def factual_claim_question
    {
      type: "noul",
      instructions: "Does `transcript` make at least one specific, verifiable factual claim about the world?",
      criteria: {
        true: "Names a checkable fact: a number, date, name, place, or event",
        false: "Pure opinion, feelings, or vague remarks with nothing checkable"
      }
    }
  end

  def specificity_question
    {
      type: "score",
      instructions: "How concrete and specific is `transcript`?",
      criteria: [
        "Entirely vague, no details at all",
        "Vague references with no specifics",
        "Some concrete details mixed with vagueness",
        "Mostly concrete: names, numbers, or specifics",
        "Highly specific and precise throughout"
      ]
    }
  end

  def complexity_question
    {
      type: "score",
      instructions: "How linguistically complex are the sentences in `transcript`?",
      criteria: [
        "Very simple: short, basic words, short sentences",
        "Simple everyday language",
        "Moderately complex: longer sentences, some subordinate clauses",
        "Complex: rich vocabulary, nested clauses",
        "Highly complex / academic: dense, sophisticated structure"
      ]
    }
  end

  def grammar_question
    {
      type: "score",
      instructions: "How grammatically correct is the speaker's language in `transcript`? Ignore likely speech-recognition mistakes (wrong homophones, missing punctuation) and judge the speaker.",
      criteria: [
        "Many grammar errors, hard to understand",
        "Several noticeable errors",
        "Mostly correct with minor slips",
        "Fully grammatically correct"
      ]
    }
  end

  def emotion_question
    {
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
    }
  end

  def habit_questions
    [
      [ "filler", { type: "noul", instructions: "Does `transcript` contain filler words or sounds (um, uh, er, like, you know, I mean)?" } ],
      [ "hedging", { type: "noul", instructions: "Does the speaker hedge in `transcript` (maybe, probably, sort of, kind of, I guess, I think)?" } ],
      [ "repetition", { type: "noul", instructions: "Does the speaker repeat a word, phrase, or idea in `transcript`?" } ],
      [ "question_asked", { type: "noul", instructions: "Does the speaker ask a question in `transcript`?" } ]
    ]
  end
end
