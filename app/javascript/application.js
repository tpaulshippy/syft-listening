// Configure your import map in config/importmap.rb. Read more: https://github.com/rails/importmap-rails
import "@hotwired/turbo-rails"
import "controllers"


// Define the Spotify callback function in the global scope
// This MUST be defined before the Spotify SDK loads
window.onSpotifyWebPlaybackSDKReady = function() {
    console.log('Spotify Web Playback SDK Ready')
    document.dispatchEvent(new Event('spotify:sdk:ready'))
  }
