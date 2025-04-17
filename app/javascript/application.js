// Configure your import map in config/importmap.rb. Read more: https://github.com/rails/importmap-rails
import "@hotwired/turbo-rails"
import "controllers"
import SpotifyPlayerManager from "spotify_player"

// Make the Spotify player manager available globally
window.SpotifyPlayerManager = SpotifyPlayerManager;

// Set up the Spotify Web Playback SDK ready callback
window.onSpotifyWebPlaybackSDKReady = () => {
  console.log('Spotify Web Playback SDK ready');
  // The SpotifyPlayerManager will check for this in its initialize method
  window.spotifySDKLoaded = true;
  
  // Dispatch an event that our components can listen for
  document.dispatchEvent(new CustomEvent('spotify:sdk:ready'));
};
