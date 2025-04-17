Rails.application.routes.draw do
  get "spotify_player/index"
  get "spotify_auth/login"
  get "spotify_auth/callback"
  get "spotify_auth/logout"
  # Define your application routes per the DSL in https://guides.rubyonrails.org/routing.html

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  # Spotify authentication routes
  get "/auth/spotify/callback", to: "spotify_auth#callback"
  get "/login", to: "spotify_auth#login", as: "login"
  get "/logout", to: "spotify_auth#logout", as: "logout"

  # Spotify player routes
  get "/player", to: "spotify_player#index"
  get "/search", to: "spotify_player#search", as: "search"
  post "/play_track", to: "spotify_player#play_track", as: "play_track"
  post "/play_playlist", to: "spotify_player#play_playlist", as: "play_playlist"

  # Defines the root path route ("/")
  root "spotify_player#index"
end
