// Shared Spotify Player Module
// This module provides a single interface for controlling Spotify playback
// across different pages of the application.

const SpotifyPlayerManager = {
  player: null,
  deviceId: null,
  token: null,
  callbacks: {
    onReady: [],
    onNotReady: [],
    onPlayerStateChanged: [],
    onError: []
  },

  // Initialize the player
  initialize(token) {
    if (!token) {
      console.error('No Spotify access token provided');
      return false;
    }

    this.token = token;
    this.deviceId = localStorage.getItem('spotify_device_id');

    // Return early if we already have a device ID and player
    if (this.deviceId && this.player) {
      return true;
    }

    // Check if Spotify Web Playback SDK is loaded
    if (window.Spotify) {
      this._setupPlayer();
    } else {
      // Wait for the Spotify SDK to load
      document.addEventListener('spotify:sdk:ready', () => {
        this._setupPlayer();
      }, { once: true });
      
      // If the Spotify SDK fails to load, we'll set up a timeout
      setTimeout(() => {
        if (!window.Spotify) {
          console.error('Spotify Web Playback SDK did not load within timeout period');
          this._triggerCallbacks('onError', { type: 'sdk_load', message: 'Spotify Web Playback SDK failed to load' });
        }
      }, 10000); // 10 second timeout
    }

    return true;
  },

  // Set up the Spotify Web Player
  _setupPlayer() {
    if (this.player) {
      console.log('Player already exists');
      return;
    }
    
    if (!window.Spotify) {
      console.error('Spotify Web Playback SDK is not loaded');
      this._triggerCallbacks('onError', { type: 'sdk_missing', message: 'Spotify Web Playback SDK is not available' });
      return;
    }

    console.log('Setting up Spotify Player with token', this.token ? '[token exists]' : '[no token]');
    
    this.player = new Spotify.Player({
      name: 'Syft Listening Player',
      getOAuthToken: cb => { cb(this.token); },
      volume: 0.5
    });

    // Error handling
    this.player.addListener('initialization_error', ({ message }) => {
      console.error('Spotify player initialization error:', message);
      this._triggerCallbacks('onError', { type: 'initialization', message });
    });

    this.player.addListener('authentication_error', ({ message }) => {
      console.error('Spotify player authentication error:', message);
      this._triggerCallbacks('onError', { type: 'authentication', message });
    });

    this.player.addListener('account_error', ({ message }) => {
      console.error('Spotify player account error:', message);
      this._triggerCallbacks('onError', { type: 'account', message });
    });

    this.player.addListener('playback_error', ({ message }) => {
      console.error('Spotify player playback error:', message);
      this._triggerCallbacks('onError', { type: 'playback', message });
    });

    // Playback status updates
    this.player.addListener('player_state_changed', state => {
      this._triggerCallbacks('onPlayerStateChanged', state);
    });

    // Ready
    this.player.addListener('ready', ({ device_id }) => {
      console.log('Spotify player ready with Device ID:', device_id);
      this.deviceId = device_id;
      localStorage.setItem('spotify_device_id', device_id);
      this._triggerCallbacks('onReady', { device_id });
    });

    // Not Ready
    this.player.addListener('not_ready', ({ device_id }) => {
      console.log('Spotify player device ID has gone offline:', device_id);
      this._triggerCallbacks('onNotReady', { device_id });
    });

    // Connect to the player!
    console.log('Connecting to Spotify player...');
    this.player.connect()
      .then(success => {
        if (success) {
          console.log('Successfully connected to Spotify!');
        } else {
          console.error('Failed to connect to Spotify');
          this._triggerCallbacks('onError', { type: 'connection', message: 'Failed to connect to Spotify' });
        }
      })
      .catch(error => {
        console.error('Error connecting to Spotify:', error);
        this._triggerCallbacks('onError', { type: 'connection', message: 'Error connecting to Spotify' });
      });
  },

  // Play a specific track
  playTrack(trackUri, csrfToken) {
    if (!this.deviceId) {
      console.error('No Spotify device ID available');
      return Promise.reject(new Error('No Spotify device ID available'));
    }

    console.log('Attempting to play track:', trackUri, 'on device:', this.deviceId);

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
      console.log('Play track response status:', response.status);
      if (!response.ok) {
        return response.json().then(data => {
          throw new Error(data.error || `Error playing track (${response.status})`);
        });
      }
      return response.json();
    });
  },

  // Check if the device is still valid with Spotify
  checkDeviceStatus() {
    if (!this.token || !this.deviceId) {
      return Promise.reject(new Error('No token or device ID available'));
    }

    return fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    })
    .then(response => response.json())
    .then(data => {
      console.log('Available devices:', data);
      const deviceFound = data.devices && data.devices.some(device => device.id === this.deviceId);
      
      if (!deviceFound) {
        // Device not found, reset device ID and reinitialize
        console.log('Device not found among available devices, resetting');
        localStorage.removeItem('spotify_device_id');
        this.deviceId = null;
        
        // If player exists, disconnect it
        if (this.player) {
          this.player.disconnect();
          this.player = null;
        }
        
        // Reinitialize the player
        if (this.token) {
          this._setupPlayer();
        }
        
        return { valid: false };
      }
      
      return { valid: true };
    });
  },

  // Register event callbacks
  on(event, callback) {
    if (this.callbacks[event]) {
      this.callbacks[event].push(callback);
    }
  },

  // Trigger callbacks for an event
  _triggerCallbacks(event, data) {
    if (this.callbacks[event]) {
      this.callbacks[event].forEach(callback => callback(data));
    }
  },

  // Get the current device ID
  getDeviceId() {
    return this.deviceId;
  },

  // Check if player is ready
  isReady() {
    return Boolean(this.deviceId && this.player);
  },

  // Disconnect the player
  disconnect() {
    if (this.player) {
      this.player.disconnect();
      this.player = null;
    }
  }
};

export default SpotifyPlayerManager;