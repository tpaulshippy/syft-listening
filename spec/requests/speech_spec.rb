require 'rails_helper'

RSpec.describe "Speech", type: :request do
  describe "GET /" do
    it "returns http success" do
      get "/"
      expect(response).to have_http_status(:success)
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
