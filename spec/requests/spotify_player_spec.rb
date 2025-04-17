require 'rails_helper'

RSpec.describe "SpotifyPlayers", type: :request do
  describe "GET /index" do
    it "returns http success" do
      get "/spotify_player/index"
      expect(response).to have_http_status(:success)
    end
  end
end
