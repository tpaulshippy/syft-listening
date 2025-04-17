class SpotifyUser < ApplicationRecord
  validates :uid, presence: true, uniqueness: true
  
  # Find or create a user from Spotify auth hash
  def self.from_omniauth(auth_hash)
    spotify_user = find_or_initialize_by(uid: auth_hash.uid)
    
    spotify_user.access_token = auth_hash.credentials.token
    spotify_user.refresh_token = auth_hash.credentials.refresh_token
    spotify_user.token_expiry = Time.at(auth_hash.credentials.expires_at).to_datetime
    
    spotify_user.save!
    spotify_user
  end
  
  # Check if the token is expired
  def token_expired?
    token_expiry < Time.now
  end
  
  # Get a refreshed access token if necessary
  def fresh_access_token
    refresh_access_token! if token_expired?
    access_token
  end
  
  # Refresh the access token
  def refresh_access_token!
    if refresh_token.present?
      client_id = ENV['SPOTIFY_CLIENT_ID']
      client_secret = ENV['SPOTIFY_CLIENT_SECRET']
      
      spotify_client = OAuth2::Client.new(
        client_id,
        client_secret,
        site: 'https://accounts.spotify.com',
        token_url: '/api/token'
      )
      
      new_token = spotify_client.client_credentials.get_token(
        refresh_token: refresh_token,
        grant_type: 'refresh_token'
      )
      
      update(
        access_token: new_token.token,
        token_expiry: Time.now + new_token.expires_in.seconds
      )
    end
  end
  
  # Return a RSpotify user instance for API interactions
  def to_spotify_user
    RSpotify::User.new({
      'credentials' => {
        'token' => fresh_access_token,
        'refresh_token' => refresh_token
      },
      'id' => uid
    })
  end
end
