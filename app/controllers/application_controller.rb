class ApplicationController < ActionController::Base
  # Only allow modern browsers supporting webp images, web push, badges, import maps, CSS nesting, and CSS :has.
  allow_browser versions: :modern

  helper_method :current_spotify_user, :spotify_user_logged_in?
  
  private
  
  def current_spotify_user
    @current_spotify_user ||= SpotifyUser.find_by(id: session[:spotify_user_id])
  end
  
  def spotify_user_logged_in?
    current_spotify_user.present?
  end
  
  def require_spotify_login
    unless spotify_user_logged_in?
      flash[:error] = "You need to log in with Spotify to access this feature."
      redirect_to root_path
    end
  end
end
