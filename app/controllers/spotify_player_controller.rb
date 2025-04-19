class SpotifyPlayerController < ApplicationController
  before_action :require_spotify_login, except: [ :index ]

  def index
    if spotify_user_logged_in?
      @spotify_user = current_spotify_user.to_spotify_user
      # Always filter for playlists starting with "K:"
      @playlists = fetch_user_playlists("K:")
    end
  end

  def search
    query = params[:query].to_s.strip

    if query.present? && spotify_user_logged_in?
      # Use RSpotify to search for tracks
      spotify_user = current_spotify_user.to_spotify_user
      @tracks = RSpotify::Track.search(query, limit: 10, market: "US")

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
        # Log the attempt with more details
        Rails.logger.info "Attempting to play track #{track_uri} on device #{device_id} for user #{current_spotify_user.id}"

        url = "https://api.spotify.com/v1/me/player/play"
        url += "?device_id=#{device_id}" if device_id.present?

        # Build the payload for the API call
        payload = { uris: [ track_uri ] }.to_json

        # Make the API call to play the track
        begin
          # First check if the device is actually available
          devices_response = RestClient.get(
            "https://api.spotify.com/v1/me/player/devices",
            { Authorization: "Bearer #{current_spotify_user.access_token}" }
          )

          devices = JSON.parse(devices_response.body)
          device_exists = devices["devices"].any? { |d| d["id"] == device_id }

          unless device_exists
            Rails.logger.warn "Device #{device_id} not found in user's available devices"
            render json: {
              error: "Device not found",
              message: "The specified device was not found among your available devices.",
              devices: devices["devices"].map { |d| { id: d["id"], name: d["name"] } }
            }, status: 404
            return
          end

          # Then check if the track exists by getting its metadata
          begin
            track_id = track_uri.split(":").last
            track_response = RestClient.get(
              "https://api.spotify.com/v1/tracks/#{track_id}",
              { Authorization: "Bearer #{current_spotify_user.access_token}" }
            )
            track_info = JSON.parse(track_response.body)
            Rails.logger.info "Track found: #{track_info['name']} by #{track_info['artists'].map { |a| a['name'] }.join(', ')}"
          rescue RestClient::NotFound
            Rails.logger.warn "Track with URI #{track_uri} not found"
            render json: { error: "Track not found", message: "The specified track could not be found." }, status: 404
            return
          rescue => e
            Rails.logger.warn "Error checking track: #{e.message}"
            # Continue anyway, as this is just a validation step
          end

          # Now play the track
          response = RestClient.put(
            url,
            payload,
            {
              Authorization: "Bearer #{current_spotify_user.access_token}",
              'Content-Type': "application/json"
            }
          )

          Rails.logger.info "Successfully sent play request to Spotify API"
          render json: { success: true }
        rescue RestClient::NotFound => e
          Rails.logger.error "Spotify API 404 error: #{e.message}"
          render json: { error: "Not found", message: "The requested resource could not be found." }, status: 404
        rescue RestClient::Unauthorized => e
          Rails.logger.error "Spotify API auth error: #{e.message}"
          render json: { error: "Authorization failed", message: "Your Spotify session may have expired." }, status: 401
        rescue RestClient::Exception => e
          Rails.logger.error "Spotify API error: #{e.message}"
          Rails.logger.error "Response body: #{e.response.body}" if e.respond_to?(:response) && e.response
          status_code = e.respond_to?(:response) ? e.response.code : 500
          error_message = begin
            JSON.parse(e.response.body)["error"]["message"] rescue e.message
          end
          render json: { error: error_message }, status: status_code
        rescue => e
          Rails.logger.error "Error playing track: #{e.message}"
          render json: { error: e.message }, status: 500
        end
      else
        Rails.logger.warn "Missing track URI or device ID: uri=#{track_uri}, device_id=#{device_id}"
        render json: { error: "Missing track URI or device ID" }, status: 400
      end
    else
      render json: { error: "Not authenticated with Spotify" }, status: 401
    end
  end

  def play_playlist
    if spotify_user_logged_in?
      playlist_uri = params[:uri]
      device_id = params[:device_id]

      if playlist_uri.present? && device_id.present?
        # Log the attempt with more details
        Rails.logger.info "Attempting to play playlist #{playlist_uri} on device #{device_id} for user #{current_spotify_user.id}"

        url = "https://api.spotify.com/v1/me/player/play"
        url += "?device_id=#{device_id}" if device_id.present?

        # Build the payload for the API call - for playlists we use context_uri instead of uris array
        payload = { context_uri: playlist_uri }.to_json

        # Make the API call to play the playlist
        begin
          # First check if the device is actually available
          devices_response = RestClient.get(
            "https://api.spotify.com/v1/me/player/devices",
            { Authorization: "Bearer #{current_spotify_user.access_token}" }
          )

          devices = JSON.parse(devices_response.body)
          device_exists = devices["devices"].any? { |d| d["id"] == device_id }

          unless device_exists
            Rails.logger.warn "Device #{device_id} not found in user's available devices"
            render json: {
              error: "Device not found",
              message: "The specified device was not found among your available devices.",
              devices: devices["devices"].map { |d| { id: d["id"], name: d["name"] } }
            }, status: 404
            return
          end

          # Now play the playlist
          response = RestClient.put(
            url,
            payload,
            {
              Authorization: "Bearer #{current_spotify_user.access_token}",
              'Content-Type': "application/json"
            }
          )

          Rails.logger.info "Successfully sent play playlist request to Spotify API"
          render json: { success: true }
        rescue RestClient::NotFound => e
          Rails.logger.error "Spotify API 404 error: #{e.message}"
          render json: { error: "Not found", message: "The requested playlist could not be found." }, status: 404
        rescue RestClient::Unauthorized => e
          Rails.logger.error "Spotify API auth error: #{e.message}"
          render json: { error: "Authorization failed", message: "Your Spotify session may have expired." }, status: 401
        rescue RestClient::Exception => e
          Rails.logger.error "Spotify API error: #{e.message}"
          Rails.logger.error "Response body: #{e.response.body}" if e.respond_to?(:response) && e.response
          status_code = e.respond_to?(:response) ? e.response.code : 500
          error_message = begin
            JSON.parse(e.response.body)["error"]["message"] rescue e.message
          end
          render json: { error: error_message }, status: status_code
        rescue => e
          Rails.logger.error "Error playing playlist: #{e.message}"
          render json: { error: e.message }, status: 500
        end
      else
        Rails.logger.warn "Missing playlist URI or device ID: uri=#{playlist_uri}, device_id=#{device_id}"
        render json: { error: "Missing playlist URI or device ID" }, status: 400
      end
    else
      render json: { error: "Not authenticated with Spotify" }, status: 401
    end
  end

  private

  def fetch_user_playlists(filter = nil)
    begin
      spotify_user = current_spotify_user.to_spotify_user
      playlists = spotify_user.playlists(limit: 50)
      
      # Apply filter if provided
      if filter.present?
        playlists = playlists.select { |playlist| playlist.name.start_with?(filter) }
      end
      
      playlists
    rescue => e
      Rails.logger.error "Error fetching playlists: #{e.message}"
      []
    end
  end

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
