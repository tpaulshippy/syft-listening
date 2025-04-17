import { Controller } from "@hotwired/stimulus"

// Note: onSpotifyWebPlaybackSDKReady is now defined in application.js

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
  currentTrackInfo = null
  
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
    const trackName = event.currentTarget.dataset.trackName
    const artistName = event.currentTarget.dataset.artistName
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content
    
    // Store track info to update status display
    if (trackName && artistName) {
      this.currentTrackInfo = { name: trackName, artist: artistName }
    }
    
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
          // Handle 404 errors specifically
          if (response.status === 404) {
            console.error('Track not found or device not available (404)')
            // Try to refresh the device connection
            this.player.disconnect().then(() => {
              setTimeout(() => {
                this.player.connect()
              }, 1000)
            })
            throw new Error('The track could not be played. The device may need reconnecting or the track is unavailable.')
          }
          // Handle 401 errors (token expired)
          else if (response.status === 401) {
            console.error('Authentication error (401)')
            // Trigger a token refresh
            this._triggerEvent('tokenExpired', {})
            throw new Error('Your Spotify session has expired. Please refresh the page.')
          }
          throw new Error(data.error || `Error playing track (${response.status})`)
        })
      }
      
      // Update the status with track info after successful playback
      if (this.currentTrackInfo && this.hasStatusTarget) {
        this.statusTarget.textContent = `Playing: ${this.currentTrackInfo.name} by ${this.currentTrackInfo.artist}`
      }
      
      // Fetch current playback to get complete track details
      this._fetchCurrentPlayback()
      
      return response.json()
    })
  }

  // Fetch current playback state from Spotify API
  _fetchCurrentPlayback() {
    if (!this._token) return
    
    fetch('https://api.spotify.com/v1/me/player', {
      headers: {
        'Authorization': `Bearer ${this._token}`
      }
    })
    .then(response => {
      if (response.status === 204) {
        return null // No content
      }
      return response.json()
    })
    .then(data => {
      if (!data) return
      
      if (data.item && this.hasStatusTarget) {
        const track = data.item
        const artists = track.artists.map(a => a.name).join(', ')
        const isPlaying = data.is_playing
        
        // Update the currentTrackInfo with complete details
        this.currentTrackInfo = { name: track.name, artist: artists }
        
        // Update status display
        this.statusTarget.textContent = `${isPlaying ? 'Playing:' : 'Paused:'} ${track.name} by ${artists}`
        
        // Trigger an event for other components that might need this info
        this._triggerEvent('trackChanged', {
          name: track.name,
          artists: artists,
          albumName: track.album?.name,
          albumImage: track.album?.images?.[0]?.url,
          duration: track.duration_ms,
          isPlaying: data.is_playing
        })
      }
    })
    .catch(error => {
      console.error('Error fetching current playback:', error)
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
    // Update status from WebSDK player state
    if (this.hasStatusTarget && state) {
      const { current_track, paused } = state
      if (current_track) {
        this.statusTarget.textContent = `${paused ? 'Paused:' : 'Playing:'} ${current_track.name} by ${current_track.artists[0].name}`
        // Store track info in case we need it later
        this.currentTrackInfo = { name: current_track.name, artist: current_track.artists[0].name }
      } else if (this.currentTrackInfo) {
        // If no current track but we have stored track info, keep showing that
        this.statusTarget.textContent = `${paused ? 'Paused:' : 'Playing:'} ${this.currentTrackInfo.name} by ${this.currentTrackInfo.artist}`
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