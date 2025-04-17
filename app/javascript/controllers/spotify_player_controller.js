import { Controller } from "@hotwired/stimulus"

// Spotify Player Controller
// This controller provides an interface for controlling Spotify playback
// throughout the application using Stimulus.
export default class extends Controller {
  static values = {
    token: String,
  }
  
  static targets = ["playButton", "status"]

  player = null
  deviceId = null
  
  connect() {
    console.log("Spotify Player Controller connected")
    
    // Check if we have a token value
    if (this.hasTokenValue) {
      this.initialize(this.tokenValue)
    }
    
    // Load Spotify Web Playback SDK if needed
    if (!window.Spotify) {
      this._loadSpotifyScript()
    }
  }
  
  disconnect() {
    this._disconnectPlayer()
  }
  
  // Initialize the player with the provided token
  initialize(token) {
    if (!token) {
      console.error('No Spotify access token provided')
      this._triggerEvent('error', { type: 'token_missing', message: 'No Spotify access token provided' })
      return false
    }

    this._token = token
    this.deviceId = localStorage.getItem('spotify_device_id')

    // Return early if we already have a device ID and player
    if (this.deviceId && this.player) {
      return true
    }

    // Check if Spotify Web Playback SDK is loaded
    if (window.Spotify) {
      this._setupPlayer()
    } else {
      // Wait for the Spotify SDK to load
      document.addEventListener('spotify:sdk:ready', () => {
        this._setupPlayer()
      }, { once: true })
      
      // If the Spotify SDK fails to load, we'll set up a timeout
      setTimeout(() => {
        if (!window.Spotify) {
          console.error('Spotify Web Playback SDK did not load within timeout period')
          this._triggerEvent('error', { 
            type: 'sdk_load', 
            message: 'Spotify Web Playback SDK failed to load' 
          })
        }
      }, 10000) // 10 second timeout
    }

    return true
  }
  
  // Media control methods - callable from action attributes
  resume() {
    if (this.player) {
      this.player.resume().then(() => {
        console.log('Playback resumed');
      }).catch(error => {
        console.error('Error resuming playback:', error);
      });
    } else {
      console.warn('Player not initialized');
    }
  }
  
  pause() {
    if (this.player) {
      this.player.pause().then(() => {
        console.log('Playback paused');
      }).catch(error => {
        console.error('Error pausing playback:', error);
      });
    } else {
      console.warn('Player not initialized');
    }
  }
  
  previousTrack() {
    if (this.player) {
      this.player.previousTrack().then(() => {
        console.log('Skipped to previous track');
      }).catch(error => {
        console.error('Error skipping to previous track:', error);
      });
    } else {
      console.warn('Player not initialized');
    }
  }
  
  nextTrack() {
    if (this.player) {
      this.player.nextTrack().then(() => {
        console.log('Skipped to next track');
      }).catch(error => {
        console.error('Error skipping to next track:', error);
      });
    } else {
      console.warn('Player not initialized');
    }
  }
  
  // Load the Spotify Web Playback SDK
  _loadSpotifyScript() {
    const script = document.createElement('script')
    script.src = 'https://sdk.scdn.co/spotify-player.js'
    script.async = true
    
    script.onload = () => {
      console.log('Spotify script loaded')
    }
    
    document.head.appendChild(script)
    
    // When the SDK is ready, it will trigger this event
    window.onSpotifyWebPlaybackSDKReady = () => {
      console.log('Spotify Web Playback SDK Ready')
      document.dispatchEvent(new Event('spotify:sdk:ready'))
    }
  }

  // Set up the Spotify Web Player
  _setupPlayer() {
    if (this.player) {
      console.log('Player already exists')
      return
    }
    
    if (!window.Spotify) {
      console.error('Spotify Web Playback SDK is not loaded')
      this._triggerEvent('error', { 
        type: 'sdk_missing', 
        message: 'Spotify Web Playback SDK is not available' 
      })
      return
    }

    console.log('Setting up Spotify Player with token', this._token ? '[token exists]' : '[no token]')
    
    this.player = new Spotify.Player({
      name: 'Syft Listening Player',
      getOAuthToken: cb => { cb(this._token) },
      volume: 0.5
    })

    // Error handling
    this.player.addListener('initialization_error', ({ message }) => {
      console.error('Spotify player initialization error:', message)
      this._triggerEvent('error', { type: 'initialization', message })
    })

    this.player.addListener('authentication_error', ({ message }) => {
      console.error('Spotify player authentication error:', message)
      this._triggerEvent('error', { type: 'authentication', message })
    })

    this.player.addListener('account_error', ({ message }) => {
      console.error('Spotify player account error:', message)
      this._triggerEvent('error', { type: 'account', message })
    })

    this.player.addListener('playback_error', ({ message }) => {
      console.error('Spotify player playback error:', message)
      this._triggerEvent('error', { type: 'playback', message })
    })

    // Playback status updates
    this.player.addListener('player_state_changed', state => {
      this._triggerEvent('playerStateChanged', state)
      this._updateStatusTarget(state)
    })

    // Ready
    this.player.addListener('ready', ({ device_id }) => {
      console.log('Spotify player ready with Device ID:', device_id)
      this.deviceId = device_id
      localStorage.setItem('spotify_device_id', device_id)
      this._triggerEvent('ready', { device_id })
    })

    // Not Ready
    this.player.addListener('not_ready', ({ device_id }) => {
      console.log('Spotify player device ID has gone offline:', device_id)
      this._triggerEvent('notReady', { device_id })
    })

    // Connect to the player!
    console.log('Connecting to Spotify player...')
    this.player.connect()
      .then(success => {
        if (success) {
          console.log('Successfully connected to Spotify!')
        } else {
          console.error('Failed to connect to Spotify')
          this._triggerEvent('error', { 
            type: 'connection', 
            message: 'Failed to connect to Spotify' 
          })
        }
      })
      .catch(error => {
        console.error('Error connecting to Spotify:', error)
        this._triggerEvent('error', { 
          type: 'connection', 
          message: 'Error connecting to Spotify' 
        })
      })
  }

  // Play a specific track (action method that can be called from HTML)
  playTrack(event) {
    event.preventDefault()
    
    const trackUri = event.currentTarget.dataset.trackUri
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content
    
    this._playTrackWithUri(trackUri, csrfToken)
  }
  
  // Internal method to play a track with the specified URI
  _playTrackWithUri(trackUri, csrfToken) {
    if (!this.deviceId) {
      console.error('No Spotify device ID available')
      this._triggerEvent('error', { 
        type: 'device', 
        message: 'No Spotify device ID available' 
      })
      return Promise.reject(new Error('No Spotify device ID available'))
    }

    console.log('Attempting to play track:', trackUri, 'on device:', this.deviceId)

    return fetch('/play_track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({
        uri: trackUri,
        device_id: this.deviceId
      })
    })
    .then(response => {
      console.log('Play track response status:', response.status)
      if (!response.ok) {
        return response.json().then(data => {
          throw new Error(data.error || `Error playing track (${response.status})`)
        })
      }
      return response.json()
    })
  }

  // Check if the device is still valid with Spotify
  checkDeviceStatus() {
    if (!this._token || !this.deviceId) {
      return Promise.reject(new Error('No token or device ID available'))
    }

    return fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: {
        'Authorization': `Bearer ${this._token}`
      }
    })
    .then(response => response.json())
    .then(data => {
      console.log('Available devices:', data)
      const deviceFound = data.devices && data.devices.some(device => device.id === this.deviceId)
      
      if (!deviceFound) {
        // Device not found, reset device ID and reinitialize
        console.log('Device not found among available devices, resetting')
        localStorage.removeItem('spotify_device_id')
        this.deviceId = null
        
        // If player exists, disconnect it
        this._disconnectPlayer()
        
        // Reinitialize the player
        if (this._token) {
          this._setupPlayer()
        }
        
        return { valid: false }
      }
      
      return { valid: true }
    })
  }
  
  // Update the status target if available
  _updateStatusTarget(state) {
    if (this.hasStatusTarget && state) {
      const { current_track, paused } = state
      if (current_track) {
        this.statusTarget.textContent = `${paused ? 'Paused:' : 'Playing:'} ${current_track.name} by ${current_track.artists[0].name}`
      } else {
        this.statusTarget.textContent = 'No track playing'
      }
    }
  }

  // Trigger a custom event on the element
  _triggerEvent(name, detail) {
    const event = new CustomEvent(`spotify:${name}`, { 
      bubbles: true, 
      detail 
    })
    this.element.dispatchEvent(event)
  }

  // Disconnect the player
  _disconnectPlayer() {
    if (this.player) {
      this.player.disconnect()
      this.player = null
    }
  }
  
  // Public methods that can be called by other controllers
  
  // Get the current device ID
  getDeviceId() {
    return this.deviceId
  }

  // Check if player is ready
  isReady() {
    return Boolean(this.deviceId && this.player)
  }
}