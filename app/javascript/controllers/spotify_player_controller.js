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
  currentTrackInfo = null
  
  connect() {
    console.log("Spotify Player Controller connected")
    
    // Add a global listener for Spotify API errors
    this._errorListener = this._handleGlobalSpotifyError.bind(this)
    document.addEventListener('spotify:api:error', this._errorListener)
    
    // Wait for proper initialization before configuring the player
    if (window.spotifySDKLoaded && window.Spotify) {
      // SDK already loaded
      if (this.hasTokenValue) {
        this.initialize(this.tokenValue)
      }
    } else {
      // Listen for the SDK to be fully ready
      document.addEventListener('spotify:sdk:ready', () => {
        console.log('Spotify SDK ready event received')
        // Give a short delay to ensure SDK is fully initialized
        setTimeout(() => {
          if (this.hasTokenValue) {
            this.initialize(this.tokenValue)
          }
        }, 300)
      }, { once: true })
    }
  }
  
  disconnect() {
    // Remove the error listener when disconnecting
    document.removeEventListener('spotify:api:error', this._errorListener)
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
      try {
        this._setupPlayer()
      } catch (error) {
        console.error('Error setting up player:', error)
        this._triggerEvent('error', { 
          type: 'initialization', 
          message: 'Error setting up Spotify player: ' + error.message 
        })
      }
    } else {
      console.error('Spotify Web Playback SDK is not loaded')
      this._triggerEvent('error', { 
        type: 'sdk_missing', 
        message: 'Spotify Web Playback SDK is not available' 
      })
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
    
    try {
      // Create the player instance
      this.player = new Spotify.Player({
        name: 'Syft Listening Player',
        getOAuthToken: cb => { cb(this._token) },
        volume: 0.5
      })
      
      // Check if the player was created properly
      if (!this.player) {
        throw new Error("Failed to create Spotify player instance")
      }
      
      // Safely add event listeners one by one with checks
      if (typeof this.player.addListener === 'function') {
        // Error handling
        this._safeAddListener('initialization_error', ({ message }) => {
          console.error('Spotify player initialization error:', message)
          this._triggerEvent('error', { type: 'initialization', message })
          this._reconnectPlayer()
        })

        this._safeAddListener('authentication_error', ({ message }) => {
          console.error('Spotify player authentication error:', message)
          this._triggerEvent('error', { type: 'authentication', message })
          this._triggerEvent('tokenExpired', {})
        })

        this._safeAddListener('account_error', ({ message }) => {
          console.error('Spotify player account error:', message)
          this._triggerEvent('error', { type: 'account', message })
        })

        this._safeAddListener('playback_error', ({ message }) => {
          console.error('Spotify player playback error:', message)
          this._triggerEvent('error', { type: 'playback', message })
          
          if (message && message.includes('404') && message.includes('cpapi.spotify.com')) {
            console.warn('Detected cpapi.spotify.com 404 error, attempting to reconnect player')
            this._reconnectPlayer()
          }
        })

        // Player state changes
        this._safeAddListener('player_state_changed', state => {
          this._triggerEvent('playerStateChanged', state)
          this._updateStatusTarget(state)
        })

        // Ready
        this._safeAddListener('ready', ({ device_id }) => {
          console.log('Spotify player ready with Device ID:', device_id)
          this.deviceId = device_id
          localStorage.setItem('spotify_device_id', device_id)
          this._triggerEvent('ready', { device_id })
        })

        // Not Ready
        this._safeAddListener('not_ready', ({ device_id }) => {
          console.log('Spotify player device ID has gone offline:', device_id)
          this._triggerEvent('notReady', { device_id })
        })
      } else {
        console.error('Spotify player missing addListener method')
        this._triggerEvent('error', { 
          type: 'initialization', 
          message: 'Spotify player API does not have required methods' 
        })
        return
      }

      // Connect to the player if connect method exists
      if (typeof this.player.connect === 'function') {
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
              message: 'Error connecting to Spotify: ' + error.message 
            })
          })
      } else {
        console.error('Spotify player missing connect method')
        this._triggerEvent('error', { 
          type: 'initialization', 
          message: 'Spotify player API does not have required methods' 
        })
      }
    } catch (error) {
      console.error('Error during Spotify player setup:', error)
      this._triggerEvent('error', { 
        type: 'initialization', 
        message: 'Error during player setup: ' + error.message 
      })
    }
  }

  // Safely add listener with error handling
  _safeAddListener(eventName, callback) {
    try {
      this.player.addListener(eventName, callback)
    } catch (error) {
      console.error(`Error adding listener for ${eventName}:`, error)
    }
  }

  // Reconnect the player when experiencing errors
  _reconnectPlayer() {
    console.log('Attempting to reconnect the Spotify player')
    if (this.player) {
      try {
        if (typeof this.player.disconnect === 'function') {
          this.player.disconnect().then(() => {
            console.log('Player disconnected, reconnecting after delay')
            localStorage.removeItem('spotify_device_id')
            this.deviceId = null
            this.player = null
            
            // Wait briefly before reconnecting
            setTimeout(() => {
              if (this._token) {
                this._setupPlayer()
              }
            }, 3000)
          }).catch(error => {
            console.error('Error disconnecting player:', error)
            // Force reset and try again
            this.player = null
            this.deviceId = null
            localStorage.removeItem('spotify_device_id')
            
            setTimeout(() => {
              if (this._token) {
                this._setupPlayer()
              }
            }, 3000)
          })
        } else {
          // Player doesn't have disconnect method, just reset
          this.player = null
          this.deviceId = null
          localStorage.removeItem('spotify_device_id')
          
          setTimeout(() => {
            if (this._token) {
              this._setupPlayer()
            }
          }, 3000)
        }
      } catch (error) {
        console.error('Error during player reconnect:', error)
        // Force reset and try again
        this.player = null
        this.deviceId = null
        localStorage.removeItem('spotify_device_id')
        
        setTimeout(() => {
          if (this._token) {
            this._setupPlayer()
          }
        }, 3000)
      }
    } else {
      // If no player exists, just try setting up a new one
      if (this._token) {
        setTimeout(() => {
          this._setupPlayer()
        }, 3000)
      }
    }
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
  
  // Play a playlist (action method that can be called from HTML)
  playPlaylist(event) {
    event.preventDefault()
    
    const playlistUri = event.currentTarget.dataset.playlistUri
    const playlistName = event.currentTarget.dataset.playlistName
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content
    
    // Update status display
    if (playlistName && this.hasStatusTarget) {
      this.statusTarget.textContent = `Loading playlist: ${playlistName}...`
    }
    
    this._playPlaylistWithUri(playlistUri, csrfToken)
  }
  
  // Internal method to play a playlist with the specified URI
  _playPlaylistWithUri(playlistUri, csrfToken) {
    if (!this.deviceId) {
      console.error('No Spotify device ID available')
      this._triggerEvent('error', { 
        type: 'device', 
        message: 'No Spotify device ID available' 
      })
      return Promise.reject(new Error('No Spotify device ID available'))
    }

    console.log('Attempting to play playlist:', playlistUri, 'on device:', this.deviceId)

    return fetch('/play_playlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({
        uri: playlistUri,
        device_id: this.deviceId
      })
    })
    .then(response => {
      console.log('Play playlist response status:', response.status)
      if (!response.ok) {
        return response.json().then(data => {
          // Handle 404 errors specifically
          if (response.status === 404) {
            console.error('Playlist not found or device not available (404)')
            // Try to refresh the device connection
            this.player.disconnect().then(() => {
              setTimeout(() => {
                this.player.connect()
              }, 1000)
            })
            throw new Error('The playlist could not be played. The device may need reconnecting or the playlist is unavailable.')
          }
          // Handle 401 errors (token expired)
          else if (response.status === 401) {
            console.error('Authentication error (401)')
            // Trigger a token refresh
            this._triggerEvent('tokenExpired', {})
            throw new Error('Your Spotify session has expired. Please refresh the page.')
          }
          throw new Error(data.error || `Error playing playlist (${response.status})`)
        })
      }
      
      // Fetch current playback to get complete track details after a short delay
      // to allow Spotify to start playing the playlist
      setTimeout(() => {
        this._fetchCurrentPlayback()
      }, 1000)
      
      return response.json()
    })
    .catch(error => {
      console.error('Error playing playlist:', error)
      if (this.hasStatusTarget) {
        this.statusTarget.textContent = `Error: ${error.message}`
      }
      return Promise.reject(error)
    })
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

  // Handle global Spotify API errors
  _handleGlobalSpotifyError(event) {
    const { message, type } = event.detail
    
    if (type === 'cpapi' && this.player) {
      console.warn('Handling cpapi.spotify.com error via global listener')
      this._reconnectPlayer()
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
      try {
        if (typeof this.player.disconnect === 'function') {
          this.player.disconnect().catch(error => {
            console.error('Error disconnecting player:', error)
          })
        }
      } catch (error) {
        console.error('Error during player disconnect:', error)
      }
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