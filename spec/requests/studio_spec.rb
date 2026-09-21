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

    it "renders the studio root with dataset + voice command targets" do
      get "/studio"
      body = response.body
      expect(body).to include('data-controller="studio"')
      expect(body).to include('data-controller="studio-command"')
      expect(body).to include('data-studio-command-target="micButton"')
      expect(body).to include('data-studio-target="dataset"')
      expect(body).not_to include('data-studio-target="prompt"')
      expect(body).not_to include("studio#usePrompt")
      expect(body).to include('data-studio-target="canvas"')
      expect(body).to include('data-api-key-target="input"')
      expect(body).not_to include('data-studio-target="apiKey"')
      expect(body).not_to include('role="tablist"')
      expect(body).to include('data-panel="design"')
      expect(body).to include('data-panel="visualize"')
      expect(body).to include('id="api-key-bottom"')
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

    it "rejects a non-JSON dataset string" do
      post "/jev_studio", params: { prompt: "Bar chart", dataset: "genre,units\nscifi,35\n", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
      expect(JSON.parse(response.body)["error"]).to include("JSON")
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
        names = schema["columns"].map { |c| c["name"] }
        expect(names).to include("genre", "revenue", "month")
        expect(schema["columns"].first.keys).to eq([ "name" ])

        questions = body["questions"]
        expect(questions["view"]["criteria"]).to include("bar", "table", "kpi")
        # Field bindings are positional refs over every column…
        expect(questions["y_field"]["criteria"].keys).to include("col0", "col1", "col2", "col3", "col4")
        expect(questions["x_field"]["criteria"]).to include("col1", "col4")
        # …with real names plus sample values as evidence for Jev…
        expect(questions["y_field"]["criteria"]["col3"]).to include("revenue", "665.0")
        expect(questions["x_field"]["criteria"]["col1"]).to include("genre", "scifi")
        # …plus the fixed sentinels, and one include flag per column
        expect(questions["y_field"]["criteria"]).to include("count_rows")
        expect(questions["color_field"]["criteria"]).to include("none")
        %w[col0 col1 col2 col3 col4].each do |ref|
          expect(questions.keys).to include("include_#{ref}")
        end
        # …plus the dashboard fan-out: layout, count, per-panel bindings
        expect(questions["layout"]["criteria"]).to include("single", "stack", "side_by_side", "grid")
        expect(questions["panel_count"]["criteria"]).to include("one", "two", "three")
        %w[view_2 x_field_2 y_field_2 color_field_2 aggregation_2 sort_by_2
           view_3 x_field_3 y_field_3 color_field_3 aggregation_3 sort_by_3].each do |key|
          expect(questions.keys).to include(key)
        end
        expect(questions["view_2"]["criteria"]).to include("bar", "table", "kpi")
        expect(questions["y_field_3"]["criteria"]).to include("col3", "count_rows")
        # …plus the Jev-native row filter: column + op + value enums
        expect(questions["filter_column"]["criteria"]).to include("col1", "col3", "none")
        expect(questions["filter_op"]["criteria"]).to include("equals", "contains", "starts_with", "ends_with")
        expect(questions["filter_negate"]["type"]).to eq("noul")
        expect(questions["filter_value_col1"]["criteria"]).to include("scifi", "nonfiction")
        expect(questions["filter_value_col3"]["criteria"]).to include("665.0", "522.0")
        upstream
      end

      post "/jev_studio", params: { prompt: "Bar chart of revenue by genre", dataset: bookstore, api_key: "ts_test" }
      expect(response).to have_http_status(:success)
      parsed = JSON.parse(response.body)
      # 2 dashboard + 10 panel-1 + 12 panels 2-3 + filter_column/filter_op/
      # filter_negate + one value enum per low-cardinality column (5 here) +
      # one flag per column
      expect(parsed["question_count"]).to eq(27 + 2 * parsed["schema"]["columns"].size)
      expect(parsed["upstream_ms"]).to be_a(Integer)
    end

    it "skips filter value enums for unique and long columns" do
      rows = (1..31).map { |i| { "id" => "INC-#{i}", "status" => i.even? ? "open" : "resolved", "notes" => "x" * 80 } }
      sent = nil
      http = instance_double(Net::HTTP)
      upstream = instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request) do |req|
        sent = JSON.parse(req.body)["questions"]
        upstream
      end

      post "/jev_studio", params: { prompt: "Table of incidents", dataset: rows, api_key: "ts_test" }
      expect(response).to have_http_status(:success)
      expect(sent["filter_value_col1"]["criteria"]).to include("open", "resolved")
      expect(sent.keys).not_to include("filter_value_col0") # 31 distinct > cap
      expect(sent.keys).not_to include("filter_value_col2") # long values
      expect(sent["filter_column"]["criteria"]).to include("col1", "none")
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

  describe "POST /jev_command" do
    it "rejects empty transcript" do
      post "/jev_command", params: { transcript: "", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "rejects missing api key" do
      post "/jev_command", params: { transcript: "create a new field", api_key: "" }
      expect(response).to have_http_status(:unauthorized)
    end

    it "rejects an unknown current tab" do
      post "/jev_command", params: { transcript: "create a new field", current_tab: "nope", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "builds the Jev-only router questions from fields and row count" do
      http = instance_double(Net::HTTP)
      upstream = instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["model"]).to eq("jev-latest")
        expect(body["state"]["transcript"]).to include("third row")
        expect(body["state"]["current_tab"]).to eq("input")
        questions = body["questions"]
        expect(questions["destination"]["criteria"]).to include("design", "input", "visualize")
        expect(questions["design_target"]["criteria"]).to include("new_field", "none", "f1")
        expect(questions["design_target"]["criteria"]["f1"]).to include("Name")
        expect(questions["row_target"]["criteria"]).to include("new_row", "none", "row_1", "row_3")
        expect(questions["row_target"]["criteria"]).not_to include("row_4")
        expect(questions.keys).to contain_exactly("destination", "design_target", "row_target")
        upstream
      end

      post "/jev_command", params: {
        transcript: "edit the third row",
        current_tab: "input",
        fields: [ { id: "f1", name: "Name" } ],
        row_count: 3,
        columns: [ "Name" ],
        api_key: "ts_test"
      }
      expect(response).to have_http_status(:success)
      parsed = JSON.parse(response.body)
      expect(parsed["question_count"]).to eq(3)
    end

    it "returns bad gateway on Jev timeout" do
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_raise(Net::ReadTimeout)

      post "/jev_command", params: { transcript: "visualize totals by day", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_gateway)
    end
  end
end
