// Configure your import map in config/importmap.rb. Read more: https://github.com/rails/importmap-rails
import "@hotwired/turbo-rails"
import "controllers"

import 'spotify-player'

// Define the Spotify callback function in the global scope
window.onSpotifyWebPlaybackSDKReady = function() {
  console.log('Spotify Web Playback SDK Ready')
  window.spotifySDKLoaded = true
  document.dispatchEvent(new Event('spotify:sdk:ready'))
}
