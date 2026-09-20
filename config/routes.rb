Rails.application.routes.draw do
  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  # Speech insights (Jev + Web Speech API transcription)
  get "/listen", to: redirect("/")
  post "/jev_analyze", to: "speech#analyze", as: "jev_analyze"

  # Generalized voice UI studio (schema-driven questions, Chart.js render)
  get "/studio", to: "studio#show", as: "studio"
  post "/jev_studio", to: "studio#analyze", as: "jev_studio"

  # Defines the root path route ("/")
  root "speech#show"
end
