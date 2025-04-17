class SpotifyPlayerController < ApplicationController
  before_action :require_spotify_login, except: [:index]
  
  def index
    if spotify_user_logged_in?
      @spotify_user = current_spotify_user.to_spotify_user
    end
  end
  
  def search
    query = params[:query].to_s.strip
    
    if query.present? && spotify_user_logged_in?
      # Use RSpotify to search for tracks
      spotify_user = current_spotify_user.to_spotify_user
      @tracks = RSpotify::Track.search(query, limit: 10, market: 'US')
      
      respond_to do |format|
        format.html { render :search }
        format.json { render json: @tracks }
      end
    else
      respond_to do |format|
        format.html { redirect_to player_path }
        format.json { render json: { error: "No search query provided" }, status: 400 }
      end
    end
  end
  
  def play_track
    if spotify_user_logged_in?
      track_uri = params[:uri]
      device_id = params[:device_id]
      
      if track_uri.present? && device_id.present?
        # Log the attempt
        Rails.logger.info "Attempting to play track #{track_uri} on device #{device_id}"
        
        url = "https://api.spotify.com/v1/me/player/play"
        url += "?device_id=#{device_id}" if device_id.present?
        
        # Build the payload for the API call
        payload = { uris: [track_uri] }.to_json
        
        # Make the API call to play the track
        begin
          response = RestClient.put(
            url,
            payload,
            { 
              Authorization: "Bearer #{current_spotify_user.access_token}",
              'Content-Type': 'application/json'
            }
          )
          
          Rails.logger.info "Successfully sent play request to Spotify API"
          render json: { success: true }
        rescue => e
          Rails.logger.error "Error playing track: #{e.message}"
          Rails.logger.error e.response if e.respond_to?(:response)
          render json: { error: e.message }, status: 422
        end
      else
        Rails.logger.warn "Missing track URI or device ID: uri=#{track_uri}, device_id=#{device_id}"
        render json: { error: "Missing track URI or device ID" }, status: 400
      end
    else
      render json: { error: "Not authenticated with Spotify" }, status: 401
    end
  end
  
  private
  
  def require_spotify_login
    unless spotify_user_logged_in?
      flash[:error] = "You need to log in with Spotify to access this feature."
      redirect_to root_path
    end
  end
  
  def spotify_user_logged_in?
    session[:spotify_user_id].present?
  end
  
  def current_spotify_user
    @current_spotify_user ||= SpotifyUser.find_by(id: session[:spotify_user_id])
  end
end
