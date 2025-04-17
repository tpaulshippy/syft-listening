require 'rspotify/oauth'

# Configure OmniAuth middleware
if ENV['SPOTIFY_CLIENT_ID'].present? && ENV['SPOTIFY_CLIENT_SECRET'].present?
  # Configure RSpotify
  RSpotify.authenticate(ENV['SPOTIFY_CLIENT_ID'], ENV['SPOTIFY_CLIENT_SECRET'])
else
  Rails.logger.warn "Spotify credentials not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your .env file."
end

# Set OmniAuth path prefix
OmniAuth.config.path_prefix = '/auth'

# Protect from CSRF attacks but allow GET requests for convenience
OmniAuth.config.allowed_request_methods = [:post, :get]

# Remove the request_phase CSRF protection since we're using POST
OmniAuth.config.silence_get_warning = true

# OmniAuth setup
Rails.application.config.middleware.use OmniAuth::Builder do
  provider :spotify, ENV['SPOTIFY_CLIENT_ID'], ENV['SPOTIFY_CLIENT_SECRET'], 
    scope: 'user-read-email user-read-private user-read-playback-state user-modify-playback-state streaming user-library-read user-read-currently-playing'
end