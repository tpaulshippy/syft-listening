require 'rails_helper'

RSpec.describe "Builder", type: :request do
  describe "GET /build" do
    it "returns http success" do
      get "/build"
      expect(response).to have_http_status(:success)
    end

    it "renders the builder Stimulus root with voice prompt bar" do
      get "/build"
      body = response.body
      expect(body).to include('data-controller="builder"')
      expect(body).to include('data-builder-target="prompt"')
      expect(body).to include('data-builder-target="micButton"')
      expect(body).to include('data-builder-target="canvas"')
    end

    it "renders the API key input reusing the Jev key" do
      get "/build"
      expect(response.body).to include('data-builder-target="apiKey"')
    end
  end

  describe "POST /jev_build" do
    it "rejects empty prompt" do
      post "/jev_build", params: { prompt: "", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "rejects missing api key" do
      post "/jev_build", params: { prompt: "Show open work as bubbles", api_key: "" }
      expect(response).to have_http_status(:unauthorized)
    end

    it "sends request+dataset state and the full UI question set in one call" do
      http = instance_double(Net::HTTP)
      upstream = instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["model"]).to eq("jev-latest")
        expect(body["state"]["request"]).to eq("Show open work as bubbles")
        expect(body["state"]["tasks"]).to be_an(Array)
        expect(body["state"]["calendar"]).to be_a(Hash)
        questions = body["questions"]
        expect(questions["view"]["type"]).to eq("choice")
        expect(questions["view"]["criteria"]).to include("bubbles", "cards", "board", "calendar")
        expect(questions["flag_blocked"]["type"]).to eq("noul")
        expect(questions["detail"]["type"]).to eq("score")
        expect(questions.keys).to include(*BuilderController::TASKS.map { |t| "include_#{t[:id]}" })
        expect(questions.size).to be >= 40
        upstream
      end

      post "/jev_build", params: { prompt: "Show open work as bubbles", api_key: "ts_test" }
      expect(response).to have_http_status(:success)
      parsed = JSON.parse(response.body)
      expect(parsed["question_count"]).to be >= 40
      expect(parsed["upstream_ms"]).to be_a(Integer)
    end

    it "forwards upstream errors with their status" do
      http = instance_double(Net::HTTP)
      upstream = instance_double(Net::HTTPResponse, code: "422", body: { detail: "bad question" }.to_json)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(upstream)

      post "/jev_build", params: { prompt: "Show open work as bubbles", api_key: "ts_test" }
      expect(response).to have_http_status(422)
    end

    it "returns bad gateway on Jev timeout" do
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_raise(Net::ReadTimeout)

      post "/jev_build", params: { prompt: "Show open work as bubbles", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_gateway)
    end

    it "falls back to TYPESAFE_API_KEY when the client sends none" do
      http = instance_double(Net::HTTP)
      upstream = instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request) do |req|
        expect(req["Authorization"]).to eq("Bearer ts_env")
        upstream
      end

      prev = ENV["TYPESAFE_API_KEY"]
      ENV["TYPESAFE_API_KEY"] = "ts_env"
      begin
        post "/jev_build", params: { prompt: "Show open work as bubbles", api_key: "" }
        expect(response).to have_http_status(:success)
      ensure
        ENV["TYPESAFE_API_KEY"] = prev
      end
    end
  end
end
