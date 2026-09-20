require 'rails_helper'

RSpec.describe "Speech", type: :request do
  describe "GET / (main page)" do
    it "returns http success" do
      get "/"
      expect(response).to have_http_status(:success)
    end

    it "renders the speech-insights Stimulus root" do
      get "/"
      expect(response.body).to include('data-controller="speech-insights"')
    end

    it "renders the recorder" do
      get "/"
      body = response.body
      expect(body).to include('data-speech-insights-target="recordButton"')
      expect(body).to include('data-speech-insights-target="timer"')
      expect(body).to include('data-speech-insights-target="waveform"')
      expect(body).to include('data-speech-insights-target="miniTranscript"')
      expect(body).to include('data-speech-insights-target="supportWarning"')
      expect(body).to include("Tap to speak")
    end

    it "renders one card per metric with a toggle checkbox" do
      get "/"
      body = response.body
      %w[emotion habits grammar complexity specificity factual_claim].each do |metric|
        expect(body).to include(%(data-metric-card="#{metric}"))
      end
      %w[emotion habits grammar complexity specificity factual_claim].each do |metric|
        expect(body).to include(%(value="#{metric}"))
      end
    end

    it "renders transcript controls and analysis buttons" do
      get "/"
      body = response.body
      expect(body).to include('data-speech-insights-target="manualText"')
      expect(body).to include('data-speech-insights-target="wordInterval"')
      expect(body).to include('data-speech-insights-target="sentenceTrigger"')
      expect(body).to include('data-speech-insights-target="charsWindow"')
      expect(body).to include("Analyze now")
      expect(body).to include("Sample")
    end

    it "renders the API key gate" do
      get "/"
      body = response.body
      expect(body).to include('data-speech-insights-target="apiKey"')
      expect(body).to include('data-speech-insights-target="testButton"')
      expect(body).to include('data-speech-insights-target="keyStatus"')
      expect(body).to include("console.typesafe.ai/keys")
    end

    it "discloses how the key is handled" do
      get "/"
      expect(response.body).to include("How your key is handled")
    end
  end

  describe "GET /listen" do
    it "redirects to the home page" do
      get "/listen"
      expect(response).to redirect_to("/")
    end
  end

  describe "POST /jev_analyze" do
    it "rejects empty text" do
      post "/jev_analyze", params: { text: "", metrics: [ "specificity" ], api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "rejects missing metrics" do
      post "/jev_analyze", params: { text: "hello world here", metrics: [], api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "rejects missing api key" do
      post "/jev_analyze", params: { text: "hello world here", metrics: [ "specificity" ], api_key: "" }
      expect(response).to have_http_status(:unauthorized)
    end

    it "sends structured state and one question per metric" do
      http = instance_double(Net::HTTP)
      upstream = instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["state"]).to eq({ "transcript" => "the tower is 330 meters tall here" })
        expect(body["questions"].keys).to match_array(
          %w[factual_claim specificity complexity grammar emotion filler hedging repetition question_asked]
        )
        expect(body["questions"]["factual_claim"]["type"]).to eq("noul")
        expect(body["questions"]["filler"]["type"]).to eq("noul")
        expect(body["questions"]["emotion"]["criteria"]).to include("other")
        upstream
      end

      post "/jev_analyze", params: {
        text: "the tower is 330 meters tall here",
        metrics: %w[factual_claim specificity complexity grammar emotion habits bogus],
        api_key: "ts_test"
      }
      expect(response).to have_http_status(:success)
    end
  end
end
