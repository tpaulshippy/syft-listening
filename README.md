# Syft Listening — Speech Insights

A Rails web app for near-real-time speech insights. Speak into your microphone and get live Jev (TypeSafe AI) analysis:

- **Factual claim** — states a checkable fact, yes/no (noul)
- **Specificity** — vague → concrete details (score 0–4)
- **Complexity** — simple words → academic structure (score 0–4)
- **Grammar** — errors → fully correct (score 0–3; told to ignore likely speech-recognition slips)
- **Emotion** — neutral, happy, excited, anxious, frustrated, sad, angry, other (choice)
- **Speech habits** — filler words, hedging, repetition, asking a question (4 × noul)

Each metric maps to Jev typed questions (`habits` fans out to four) and can be toggled on/off. Disabled metrics are not sent to Jev, so they cost nothing. Answers with confidence below 0.5 render muted with an "uncertain" tag.

Live at https://listen.syftlearning.app (root path `/`; `/listen` redirects there).

## How it works

- **Transcription (free, no key):** the browser's built-in [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) (`SpeechRecognition`) transcribes speech continuously with interim results. Works in Chrome/Edge on desktop/Android. No transcription API key needed — this is the cheapest option that works well ($0). A type/paste box is included as a fallback for unsupported browsers.
- **Analysis (verified Jev API key required):** every time a sentence is finalized, the page sends the tail of the transcript (~1000 chars max, keeps it fast and cheap) plus the enabled metrics to `POST /jev_analyze`, which proxies to `POST https://api.typesafe.ai/v1/systemone` (model `jev-latest`, $0.042/M input tokens, output tokens free) with state as `{ transcript: ... }`. The proxy exists because TypeSafe's API rejects browser origins (CORS allowlist) and their JS SDK refuses to run in browsers — server-side calls are their endorsed pattern.
- **Key handling:** the Jev key lives in `localStorage` on the user's device only. It is forwarded through the server per request — never stored in the database, never logged (`api_key` is covered by the `:_key` log filter). Recorder, metrics, and transcript stay hidden until the key passes Test (pasting auto-tests); a 401 from Jev locks them again, while the explanation text stays visible throughout. Since a server operator could technically see keys in transit, the page says so openly, notes keys are revocable at `console.typesafe.ai/keys`, and points at this open-source repo for anyone who'd rather self-host.

## Tech stack

- Ruby 3.2.1, Rails ~> 8.0.2
- Puma, Propshaft — **no database** (no Active Record, no SQLite, no Solid adapters)
- `solid_cache` / `solid_queue` / `solid_cable`, Thruster, Kamal (Docker deploy)
- `tailwindcss-rails`, `turbo-rails`, `stimulus-rails`, `importmap-rails`, `jbuilder`
- RSpec + FactoryBot (`rspec-rails`, `factory_bot_rails`), Brakeman, RuboCop Omakase
- Vitest + ESLint for the Stimulus JS (`npm test`, `npm run lint` — needs `npm install`)
- No LLM string generation: Jev returns typed probabilities (`noul` / `choice` / `score`), rendered as score bars, yes/no flags, habit lists, and emotion distributions by the Stimulus `speech-insights` controller.

## Getting started

```bash
bundle install
```

Run the app (Tailwind watcher included):

```bash
bin/dev
```

Open http://localhost:3000. Paste a Jev API key (get one at https://console.typesafe.ai/keys — early access; pasting auto-verifies and unlocks the recorder), enable the metrics you want, hit the mic button (or "Sample" / type in the box), and watch the scores update.

Optional: set `TYPESAFE_API_KEY` in the environment as a fallback server-side key (used only when the request supplies none).

## Routes

| Method | Path | Action |
|---|---|---|
| GET | `/` | `speech#show` (the app) |
| GET | `/listen` | redirect to `/` |
| POST | `/jev_analyze` | proxy to Jev (`{ text, metrics, api_key }`) |
| GET | `/up` | health check |

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `TYPESAFE_API_KEY` | no | Fallback server-side Jev key when the client sends none |

## Tests

```bash
bundle exec rspec
```

JS (Stimulus controller unit tests, `test/`):

```bash
npm install
npm test
```

Specs live in `spec/` (RSpec) and `test/` (Vitest). Lint / security:

```bash
bundle exec rubocop
bundle exec brakeman
npm run lint
```

## Project structure

```
app/
  controllers/speech_controller.rb       # show + Jev proxy (analyze)
  views/speech/show.html.erb             # key input, toggles, transcript, result cards
  javascript/controllers/speech_insights_controller.js  # Web Speech API + per-sentence analysis + key gate
config/routes.rb                         # root -> speech#show, POST /jev_analyze
spec/requests/speech_spec.rb
```

## Deployment

Deploys to `listen.syftlearning.app` via `.github/workflows/deploy.yml`: on CI success for `main`, it pulls on the server, runs `bundle install`, and restarts the `listening` systemd service (port 4000).

Docker + Kamal/Thruster files are also included (`Dockerfile`, `.kamal/`, `.dockerignore`):

```bash
docker build -t syft_listening .
docker run -d -p 80:80 -e RAILS_MASTER_KEY=<value from config/master.key> --name syft_listening syft_listening
```
