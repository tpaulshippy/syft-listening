class SpotifyAuthController < ApplicationController
  def login
    redirect_to '/auth/spotify'
  end

  def callback
    auth_hash = request.env['omniauth.auth']
    
    if auth_hash.present?
      spotify_user = SpotifyUser.from_omniauth(auth_hash)
      session[:spotify_user_id] = spotify_user.id
      
      flash[:success] = "Successfully signed in with Spotify!"
      redirect_to player_path
    else
      flash[:error] = "Authentication failed. Please try again."
      redirect_to root_path
    end
  end

  def logout
    session[:spotify_user_id] = nil
    flash[:notice] = "Logged out of Spotify."
    redirect_to root_path
  end
end
