import { Controller } from "@hotwired/stimulus"

// Playlist Tracks Controller
// This controller manages the display and interaction with tracks in a playlist
export default class extends Controller {
  static targets = ["container", "title", "trackTemplate", "trackNumber", "trackImage", "imageContainer", "trackTitle", "trackArtist", "trackDuration"]
  static values = { 
    currentTrackId: String,
    playlistName: String 
  }

  connect() {
    console.log("Playlist Tracks Controller connected")
  }

  // This method is called from the spotify_player_controller to update the tracks
  updateTracks(tracks, currentTrackId, playlistName) {
    if (!this.hasContainerTarget || !this.hasTrackTemplateTarget) {
      console.log("Missing required targets for playlist tracks", {
        hasContainerTarget: this.hasContainerTarget,
        hasTrackTemplateTarget: this.hasTrackTemplateTarget
      })
      return
    }
    
    // Update the playlist name
    if (this.hasTitleTarget && playlistName) {
      this.playlistNameValue = playlistName
      this.titleTarget.textContent = `${playlistName} - ${tracks.length} tracks`
      this.titleTarget.classList.remove('hidden')
    }
    
    // Clear existing tracks
    this.containerTarget.innerHTML = ''
    
    // Set the current track ID
    this.currentTrackIdValue = currentTrackId
    
    // Add all the tracks
    tracks.forEach((track, index) => {
      const trackElement = this._createTrackFromTemplate(track, index)
      this.containerTarget.appendChild(trackElement)
    })
  }
  
  // Creates a track element by cloning the template and setting its properties
  _createTrackFromTemplate(track, index) {
    const isCurrentTrack = track.id === this.currentTrackIdValue
    
    // Clone the template
    const clone = this.trackTemplateTarget.content.cloneNode(true)
    
    // Get the track item container
    const trackItem = clone.querySelector('.track-item')
    
    // Set attributes for track selection
    trackItem.dataset.spotifyPlayerTrackUri = track.uri
    trackItem.dataset.spotifyPlayerTrackName = track.name
    trackItem.dataset.spotifyPlayerArtistName = track.artists[0].name
    
    // Highlight current track
    if (isCurrentTrack) {
      trackItem.classList.add('bg-emerald-100')
    }
    
    // Set track number
    const trackNumber = clone.querySelector('[data-playlist-tracks-target="trackNumber"]')
    if (trackNumber) {
      trackNumber.textContent = (index + 1).toString().padStart(2, '0')
      if (isCurrentTrack) {
        trackNumber.classList.remove('text-gray-500')
        trackNumber.classList.add('text-emerald-600', 'font-bold')
      }
    }
    
    // Set track image if available, otherwise hide the image container
    const imageContainer = clone.querySelector('[data-playlist-tracks-target="imageContainer"]')
    const trackImage = clone.querySelector('[data-playlist-tracks-target="trackImage"]')
    if (imageContainer && trackImage) {
      if (track.album?.images?.[2]?.url) {
        trackImage.src = track.album.images[2].url
        trackImage.alt = `${track.name} album art`
      } else {
        // If no image, change image container to a placeholder
        imageContainer.innerHTML = ''
        imageContainer.classList.add('bg-gray-100', 'rounded')
      }
    }
    
    // Set track title
    const trackTitle = clone.querySelector('[data-playlist-tracks-target="trackTitle"]')
    if (trackTitle) {
      trackTitle.textContent = track.name
      if (isCurrentTrack) {
        trackTitle.classList.remove('text-gray-900')
        trackTitle.classList.add('text-emerald-600')
      }
    }
    
    // Set track artist
    const trackArtist = clone.querySelector('[data-playlist-tracks-target="trackArtist"]')
    if (trackArtist) {
      trackArtist.textContent = track.artists[0].name
    }
    
    // Set track duration
    const trackDuration = clone.querySelector('[data-playlist-tracks-target="trackDuration"]')
    if (trackDuration) {
      trackDuration.textContent = this._formatDuration(track.duration_ms)
    }
    
    return clone
  }
  
  // Helper to format milliseconds as mm:ss
  _formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }
}