# Syft Listening

A Rails web app for kid-safe Spotify listening. Connect a Spotify Premium account and play curated playlists and saved podcasts through an in-browser Web Playback SDK player.

Long-term vision (see `product_requirements_document.md`): a Teen Music Access Manager where parents pre-approve artists, albums, songs, and playlists, teens request permission for new content, and parents approve it, with time limits and listening reports.

Current implementation covers the playback foundation: Spotify OAuth login, filtered playlist browsing, podcast/show browsing, catalog search, and remote playback control.

## Features

- **Spotify OAuth login** via OmniAuth (`omniauth-spotify`) — stores access/refresh tokens in `SpotifyUser`
- **Token refresh** — `SpotifyUser#fresh_access_token` / `#refresh_access_token!`
- **Curated playlists** — lists user's playlists filtered to names starting with `K:` (prefix stripped in UI)
- **Podcasts / shows** — lists saved shows via `GET /v1/me/shows` with graceful handling of 401/403/404
- **Catalog search** — `RSpotify::Track.search` (10 results, US market), HTML + JSON
- **In-browser playback** — Stimulus `spotify-player` controller using Spotify Web Playback SDK
- **Playback API** — `POST /play_track`, `/play_playlist`, `/play_episode` proxy to `PUT /v1/me/player/play` with device validation and track lookup
- **Tailwind CSS + Hotwire** (Turbo + Stimulus via importmap) UI

## Tech stack

- Ruby 3.2.1, Rails ~> 8.0.2
- SQLite3, Puma, Propshaft
- `rspotify`, `omniauth`, `omniauth-spotify`, `omniauth-rails_csrf_protection`, `dotenv-rails`, `bcrypt`
- `solid_cache` / `solid_queue` / `solid_cable`, Thruster, Kamal (Docker deploy)
- `tailwindcss-rails`, `turbo-rails`, `stimulus-rails`, `importmap-rails`, `jbuilder`
- RSpec + FactoryBot (`rspec-rails`, `factory_bot_rails`), Brakeman, RuboCop Omakase

## Prerequisites

- Ruby 3.2.1 (see `.ruby-version`)
- Bundler
- SQLite3
- A Spotify Developer app + a Spotify **Premium** account (Web Playback SDK requires Premium)

## Spotify app setup

1. Create an app at https://developer.spotify.com/dashboard
2. Add redirect URI: `http://localhost:3000/auth/spotify/callback` (plus your production callback URL)
3. Note the Client ID and Client Secret
4. Requested scopes (see `config/initializers/rspotify.rb`):
   `user-read-email user-read-private user-read-playback-state user-modify-playback-state streaming user-library-read user-read-currently-playing playlist-read-private playlist-read-collaborative`

## Getting started

```bash
bundle install
```

Create `.env` in the project root (loaded by `dotenv-rails`):

```bash
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
```

Set up the database:

```bash
bin/rails db:prepare
```

Run the app (Tailwind watcher included):

```bash
bin/dev
# or: bin/rails server  +  bin/rails tailwindcss:watch (see Procfile.dev)
```

Open http://localhost:3000. Sign in with Spotify, then open a Spotify client once so a playback device exists (or use the in-browser SDK device).

To use curated playlists, prefix kid-approved playlist names in Spotify with `K:` (e.g. `K:Bedtime`). The `K:` prefix is filtered server-side in `SpotifyPlayerController#fetch_user_playlists` and stripped in the view.

## Routes

| Method | Path | Action |
|---|---|---|
| GET | `/` | `spotify_player#index` (login or player) |
| GET | `/player` | `spotify_player#index` |
| GET | `/search?query=...` | `spotify_player#search` (HTML + JSON) |
| POST | `/play_track` | play track URI on `device_id` |
| POST | `/play_playlist` | play playlist `context_uri` on `device_id` |
| POST | `/play_episode` | play episode URI on `device_id` |
| GET | `/login` | redirect to `/auth/spotify` |
| GET | `/auth/spotify/callback` | OAuth callback |
| GET | `/logout` | clear session |
| GET | `/up` | health check |

Playback POST params: `{ uri: "spotify:track:...", device_id: "..." }`.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | yes | Spotify app client ID (RSpotify + OmniAuth) |
| `SPOTIFY_CLIENT_SECRET` | yes | Spotify app client secret |

Without these, the app boots but logs: `Spotify credentials not configured...` (`config/initializers/rspotify.rb`).

## Tests

```bash
bundle exec rspec
```

Specs live in `spec/` (models, requests, views, helpers). See `.rspec`.

Lint / security:

```bash
bundle exec rubocop
bundle exec brakeman
```

## Project structure

```
app/
  controllers/spotify_auth_controller.rb    # login / OAuth callback / logout
  controllers/spotify_player_controller.rb  # index, search, play_track/playlist/episode
  models/spotify_user.rb                    # OmniAuth user + token refresh + RSpotify wrapper
  views/spotify_player/index.html.erb       # playlists + podcasts + Web Playback SDK player
  views/spotify_player/search.html.erb
  javascript/controllers/                   # Stimulus spotify-player controller
config/
  routes.rb
  initializers/rspotify.rb                  # RSpotify.authenticate + OmniAuth Spotify provider
db/schema.rb                                # spotify_users (uid, access_token, refresh_token, token_expiry)
example-track-info.json                     # sample Spotify player state payload
product_requirements_document.md            # full PRD: parental controls roadmap
```

## Deployment

Docker + Kamal/Thruster files are included (`Dockerfile`, `.kamal/`, `.dockerignore`):

```bash
docker build -t syft_listening .
docker run -d -p 80:80 -e RAILS_MASTER_KEY=<value from config/master.key> --name syft_listening syft_listening
```

Set `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` and the production Spotify redirect URI in your deploy environment.

## Roadmap

From `product_requirements_document.md` — not yet implemented:

- Parent accounts + teen profiles with 4-digit PINs
- Per-profile allow lists (artists, albums, songs, playlists)
- Teen permission-request flow + parent approve/reject
- Time limits / allowed listening hours
- Request notifications and listening-habit reports
- Explicit-content filtering
