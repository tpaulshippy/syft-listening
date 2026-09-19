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
      post "/jev_analyze", params: { text: "", metrics: ["factual"], api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "rejects missing metrics" do
      post "/jev_analyze", params: { text: "hello world here", metrics: [], api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "rejects missing api key" do
      post "/jev_analyze", params: { text: "hello world here", metrics: ["factual"], api_key: "" }
      expect(response).to have_http_status(:unauthorized)
    end
  end
end
