require 'rails_helper'
require 'net/http'

RSpec.describe "Input", type: :request do
  def stub_jev
    http = instance_double(Net::HTTP)
    upstream = instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
    allow(Net::HTTP).to receive(:new).and_return(http)
    allow(http).to receive(:use_ssl=)
    allow(http).to receive(:open_timeout=)
    allow(http).to receive(:read_timeout=)
    allow(http).to receive(:request).and_return(upstream)
    http
  end

  let(:pair) do
    [
      { "name" => "Subscribe", "type" => "yes_no", "required" => false, "options" => [] },
      { "name" => "Genre", "type" => "choice_single", "required" => true, "options" => %w[fiction scifi] }
    ]
  end

  describe "POST /jev_input" do
    it "rejects missing api key" do
      post "/jev_input", params: { step: "answer", transcript: "yes", fields: pair, api_key: "" }
      expect(response).to have_http_status(:unauthorized)
    end

    it "rejects unknown steps" do
      post "/jev_input", params: { step: "nope", api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "builds a plan_group noul for two closed types" do
      http = stub_jev
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["questions"]["ask_together"]["type"]).to eq("noul")
        expect(body["state"]["field_a"]).to eq("Subscribe")
        instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      end

      post "/jev_input", params: { step: "plan_group", fields: pair, api_key: "ts_test" }
      expect(response).to have_http_status(:success)
      expect(JSON.parse(response.body)["question_count"]).to eq(1)
    end

    it "refuses to group open types" do
      fields = [
        { "name" => "Name", "type" => "text", "required" => true, "options" => [] },
        { "name" => "Email", "type" => "email", "required" => true, "options" => [] }
      ]
      post "/jev_input", params: { step: "plan_group", fields: fields, api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "builds an answer batch: choice + noul + shared control" do
      http = stub_jev
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["state"]["transcript"]).to eq("yes, scifi")
        expect(body["questions"]["value"]["type"]).to eq("noul") # yes_no
        expect(body["questions"]["value_2"]["criteria"]).to include("fiction", "scifi")
        expect(body["questions"]["control"]["criteria"]).to include("answer", "skip", "finish_row")
        instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      end

      post "/jev_input", params: { step: "answer", transcript: "yes, scifi", fields: pair, api_key: "ts_test" }
      expect(response).to have_http_status(:success)
    end

    it "fans out one noul per option for choice_multiple" do
      http = stub_jev
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["questions"].keys).to include("pick_fiction", "pick_scifi", "control")
        instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      end

      fields = [ { "name" => "Tags", "type" => "choice_multiple", "required" => false, "options" => %w[fiction scifi] } ]
      post "/jev_input", params: { step: "answer", transcript: "fiction", fields: fields, api_key: "ts_test" }
      expect(response).to have_http_status(:success)
    end

    it "asks a validity noul for open types" do
      http = stub_jev
      allow(http).to receive(:request) do |req|
        body = JSON.parse(req.body)
        expect(body["questions"]["valid"]["type"]).to eq("noul")
        instance_double(Net::HTTPResponse, code: "200", body: { answers: {} }.to_json)
      end

      fields = [ { "name" => "Email", "type" => "email", "required" => true, "options" => [] } ]
      post "/jev_input", params: { step: "answer", transcript: "a@b.co", fields: fields, api_key: "ts_test" }
      expect(response).to have_http_status(:success)
    end

    it "rejects two open fields in one prompt" do
      fields = [
        { "name" => "Name", "type" => "text", "required" => false, "options" => [] },
        { "name" => "Email", "type" => "email", "required" => false, "options" => [] }
      ]
      post "/jev_input", params: { step: "answer", transcript: "x", fields: fields, api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "rejects choice fields without options" do
      fields = [ { "name" => "Genre", "type" => "choice_single", "required" => true, "options" => [] } ]
      post "/jev_input", params: { step: "answer", transcript: "fiction", fields: fields, api_key: "ts_test" }
      expect(response).to have_http_status(:bad_request)
    end

    it "returns bad gateway on Jev timeout" do
      http = instance_double(Net::HTTP)
      allow(Net::HTTP).to receive(:new).and_return(http)
      allow(http).to receive(:use_ssl=)
      allow(http).to receive(:open_timeout=)
      allow(http).to receive(:read_timeout=)
      allow(http).to receive(:request).and_raise(Net::ReadTimeout)

      post "/jev_input", params: { step: "answer", transcript: "yes", fields: pair, api_key: "ts_test" }
      expect(response).to have_http_status(:bad_gateway)
    end
  end
end
