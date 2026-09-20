require 'rails_helper'
require 'net/http'

RSpec.describe "Studio", type: :request do
  let(:bookstore) do
    [
      { "title" => "Dune", "genre" => "scifi", "units" => 35, "revenue" => 665.0, "month" => "2026-06" },
      { "title" => "Sapiens", "genre" => "nonfiction", "units" => 29, "revenue" => 522.0, "month" => "2026-07" }
    ]
  end

  describe "GET /studio" do
    it "returns http success" do
      get "/studio"
      expect(response).to have_http_status(:success)
    end

    it "renders the studio root with dataset + voice prompt targets" do
      get "/studio"
      body = response.body
      expect(body).to include('data-controller="studio"')
      expect(body).to include('data-studio-target="dataset"')
      expect(body).to include('data-studio-target="prompt"')
      expect(body).to include('data-studio-target="micButton"')
      expect(body).to include('data-studio-target="canvas"')
      expect(body).to include('data-studio-target="apiKey"')
    end
  end

  describe "POST /jev_studio" do
    it "rejects empty prompt" do
      post "/jev_studio", params: { prompt: "", dataset: bookstore, api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "rejects invalid dataset JSON" do
      post "/jev_studio", params: { prompt: "Bar chart", dataset: "nope", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "rejects a non-array dataset" do
      post "/jev_studio", params: { prompt: "Bar chart", dataset: { a: 1 }, api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "accepts a sample name instead of pasted JSON" do
      http = instance_double(Net::HTTP)
      upstream = instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(upstream)

      post "/jev_studio", params: { prompt: "Bar chart", sample: "bookstore", api_key: "ts_test" }
      expect(response).to have_http_status(:success)
    end

    it "rejects missing api key" do
      post "/jev_studio", params: { prompt: "Bar chart", dataset: bookstore, api_key: "" }
      expect(response).to have_http_status(:unauthorized)
    end

    it "builds schema-driven questions from the dataset's own columns" do
      http = instance_double(Net::HTTP)
      upstream = instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["model"]).to eq("jev-latest")
        schema = body["state"]["schema"]
        slugs = schema["columns"].map { |c| c["slug"] }
        expect(slugs).to include("genre", "revenue", "month")
        genre = schema["columns"].find { |c| c["slug"] == "genre" }
        expect(genre["type"]).to eq("categorical")
        revenue = schema["columns"].find { |c| c["slug"] == "revenue" }
        expect(revenue["type"]).to eq("numeric")

        questions = body["questions"]
        expect(questions["view"]["criteria"]).to include("bar", "table", "kpi")
        # Field bindings offer the dataset's own columns…
        expect(questions["y_field"]["criteria"]).to include("revenue", "units")
        expect(questions["x_field"]["criteria"]).to include("genre", "month")
        # …plus the fixed sentinels, and one include flag per column
        expect(questions["y_field"]["criteria"]).to include("count_rows")
        expect(questions["color_field"]["criteria"]).to include("none")
        %w[title genre units revenue month].each do |slug|
          expect(questions.keys).to include("include_#{slug}")
        end
        # …plus the dashboard fan-out: layout, count, per-panel bindings
        expect(questions["layout"]["criteria"]).to include("single", "stack", "side_by_side", "grid")
        expect(questions["panel_count"]["criteria"]).to include("one", "two", "three")
        %w[view_2 x_field_2 y_field_2 color_field_2 aggregation_2 sort_by_2
           view_3 x_field_3 y_field_3 color_field_3 aggregation_3 sort_by_3].each do |key|
          expect(questions.keys).to include(key)
        end
        expect(questions["view_2"]["criteria"]).to include("bar", "table", "kpi")
        expect(questions["y_field_3"]["criteria"]).to include("revenue", "count_rows")
        upstream
      end

      post "/jev_studio", params: { prompt: "Bar chart of revenue by genre", dataset: bookstore, api_key: "ts_test" }
      expect(response).to have_http_status(:success)
      parsed = JSON.parse(response.body)
      # 2 dashboard + 10 panel-1 + 12 panels 2-3 + one flag per column
      expect(parsed["question_count"]).to eq(24 + parsed["schema"]["columns"].size)
      expect(parsed["upstream_ms"]).to be_a(Integer)
    end

    it "builds one panel per voice clause for multi-view prompts" do
      http = instance_double(Net::HTTP)
      upstream = instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["state"]["request"]).to include("KPI")
        upstream
      end

      post "/jev_studio", params: {
        prompt: "Bar chart of revenue by genre with KPI totals",
        dataset: bookstore, api_key: "ts_test"
      }
      expect(response).to have_http_status(:success)
    end

    it "forwards upstream errors with their status" do
      http = instance_double(Net::HTTP)
      upstream = instance_double(Net::HTTPResponse, code: "422", body: { detail: "bad question" }.to_json)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_return(upstream)

      post "/jev_studio", params: { prompt: "Bar chart", dataset: bookstore, api_key: "ts_test" }
      expect(response).to have_http_status(422)
    end

    it "returns bad gateway on Jev timeout" do
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_raise(Net::ReadTimeout)

      post "/jev_studio", params: { prompt: "Bar chart", dataset: bookstore, api_key: "ts_test" }
      expect(response).to have_http_status(:bad_gateway)
    end
  end
end
