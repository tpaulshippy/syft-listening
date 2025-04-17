require 'rails_helper'

RSpec.describe "SpotifyAuths", type: :request do
  describe "GET /login" do
    it "returns http success" do
      get "/spotify_auth/login"
      expect(response).to have_http_status(:success)
    end
  end

  describe "GET /callback" do
    it "returns http success" do
      get "/spotify_auth/callback"
      expect(response).to have_http_status(:success)
    end
  end

  describe "GET /logout" do
    it "returns http success" do
      get "/spotify_auth/logout"
      expect(response).to have_http_status(:success)
    end
  end

end
