require 'rails_helper'
require 'net/http'

RSpec.describe "Design", type: :request do
  def stub_jev(body = { answers: {} })
    http = instance_double(Net::HTTP)
    upstream = instance_double(Net::HTTPResponse, code: "200", body: body.to_json)
    allow(Net::HTTP).to receive(:new).and_return(http)
    allow(http).to receive(:use_ssl=)
    allow(http).to receive(:open_timeout=)
    allow(http).to receive(:read_timeout=)
    allow(http).to receive(:request).and_return(upstream)
    http
  end

  describe "POST /jev_design" do
    it "rejects missing api key" do
      post "/jev_design", params: { step: "classify", field_name: "Birthday", api_key: "" }
      expect(response).to have_http_status(:unauthorized)
    end

    it "rejects unknown steps" do
      post "/jev_design", params: { step: "nope", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "rejects empty field name on classify" do
      post "/jev_design", params: { step: "classify", field_name: "", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "rejects overlong field names" do
      post "/jev_design", params: { step: "classify", field_name: "x" * 61, api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "builds classify questions over the 8-type registry" do
      http = stub_jev
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["state"]["field_name"]).to eq("Birthday")
        criteria = body["questions"]["field_type"]["criteria"]
        expect(criteria.keys.sort).to eq(%w[choice_multiple choice_single date email number text time yes_no])
        expect(body["questions"]["needs_options"]["type"]).to eq("noul")
        instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      end

      post "/jev_design", params: { step: "classify", field_name: "Birthday", api_key: "ts_test" }
      expect(response).to have_http_status(:success)
      parsed = JSON.parse(response.body)
      expect(parsed["question_count"]).to eq(2)
      expect(parsed["step"]).to eq("classify")
    end

    it "builds option intent questions" do
      http = stub_jev
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["state"]["transcript"]).to eq("done")
        expect(body["questions"]["intent"]["criteria"]).to include("add_option", "done_options", "remove_last")
        instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      end

      post "/jev_design", params: { step: "option_intent", transcript: "done", field_name: "Genre", api_key: "ts_test" }
      expect(response).to have_http_status(:success)
    end

    it "builds required + session intent questions" do
      stub_jev
      post "/jev_design", params: { step: "required", transcript: "yes required", field_name: "Email", api_key: "ts_test" }
      expect(response).to have_http_status(:success)

      post "/jev_design", params: { step: "session_intent", transcript: "finished", field_count: 3, api_key: "ts_test" }
      expect(response).to have_http_status(:success)
    end

    it "offers a content bucket on the session intent so names are never forced into commands" do
      http = stub_jev
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["questions"]["intent"]["criteria"]).to include("content", "finished", "edit_last", "delete_last")
        instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      end

      post "/jev_design", params: { step: "session_intent", transcript: "Testing 123", field_count: 0, api_key: "ts_test" }
      expect(response).to have_http_status(:success)
    end

    it "builds one required noul per finished field" do      http = stub_jev
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["state"]["transcript"]).to eq("email and birthday")
        expect(body["questions"]["required_f1"]["type"]).to eq("noul")
        expect(body["questions"].keys).to include("required_f1", "required_f2")
        instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      end

      post "/jev_design", params: {
        step: "required_fields", transcript: "email and birthday",
        fields: [ { id: "f1", name: "Email" }, { id: "f2", name: "Birthday" } ],
        api_key: "ts_test"
      }
      expect(response).to have_http_status(:success)
      expect(JSON.parse(response.body)["question_count"]).to eq(2)
    end

    it "rejects empty transcripts on intent steps" do
      post "/jev_design", params: { step: "required", transcript: "", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "builds an edit intent choice for the voice edit menu" do
      http = stub_jev
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["state"]["transcript"]).to eq("change the name")
        criteria = body["questions"]["intent"]["criteria"]
        expect(criteria).to include("name", "type", "options", "required", "remove", "done")
        # Bare "type" must route to retype, and cancel/stop must exit —
        # never delete the field.
        expect(criteria["type"]).to include("type")
        expect(criteria["done"]).to include("cancel")
        instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      end

      post "/jev_design", params: { step: "edit_intent", transcript: "change the name", field_name: "Genre", api_key: "ts_test" }
      expect(response).to have_http_status(:success)
    end

    it "builds a change_type choice over the 8-type registry" do
      http = stub_jev
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["questions"]["field_type"]["criteria"]).to include("number", "email", "choice_multiple")
        instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      end

      post "/jev_design", params: { step: "change_type", transcript: "make it a number", field_name: "Age", api_key: "ts_test" }
      expect(response).to have_http_status(:success)
    end

    it "returns bad gateway on Jev timeout" do
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_raise(Net::ReadTimeout)

      post "/jev_design", params: { step: "classify", field_name: "Birthday", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_gateway)
    end
  end
end
