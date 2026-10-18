# sw-downloader

> **Work in progress** — expect rough edges and breaking changes.

Automatically downloads the latest **Stan Wyjątkowy** Saturday stream from YouTube before the channel edits the VOD.

Runs as a Docker container with two independent cron jobs:

- **Find job** — Playwright scrapes the channel (Home, Videos, Live tabs) looking for a video uploaded in the last 12 hours that is longer than 60 minutes
- **Download job** — polls every 30 minutes; once the stream is detected as finished, downloads the full VOD via yt-dlp

---

## How it works

```
Sat 20:05  →  Playwright checks channel tabs
               ✓ video < 12h old AND > 60min → save URL to state.json

Every 30m  →  check state
               live?     → skip, retry next tick
               finished? → yt-dlp download → mark done
               done?     → skip
```

State is persisted to a JSON file so the container survives restarts without re-downloading.

---

## Requirements

- Docker (Linux) or Docker Desktop (Windows / macOS)

ffmpeg, yt-dlp, Deno, and Chromium are all bundled in the image — nothing else needed.

---

## Running

### Linux — pre-built image from GHCR

No need to clone or build anything. Pull and run directly:

```bash
docker run -d \
  --name sw-downloader \
  --restart unless-stopped \
  -v "/path/to/downloads:/downloads" \
  ghcr.io/damianeek/sw-downloader:latest
```

Test immediately without waiting for Saturday:

```bash
docker run --rm \
  -v "/path/to/downloads:/downloads" \
  -e RUN_NOW=true \
  ghcr.io/damianeek/sw-downloader:latest
```

Check logs:

```bash
docker logs -f sw-downloader
```

---

### Unraid

1. Go to **Docker → Add Container**
2. Fill in the following:

| Field | Value |
|---|---|
| Name | `sw-downloader` |
| Repository | `ghcr.io/damianeek/sw-downloader:latest` |
| Network Type | `bridge` |

3. Add a **Path**:
   - Container Path: `/downloads`
   - Host Path: your media share, e.g. `/mnt/user/Media/`

   Optionally add a second **Path** for audio-only copies:
   - Container Path: `/audio`
   - Host Path: e.g. `/mnt/user/Media/Podcasts/`

4. Add **Variables** (optional, these are the defaults):
   - `TIMEZONE` = `Europe/Warsaw`
   - `CHANNEL_HANDLE` = `stan_wyjatkowy`
   - `MAX_AGE_HOURS` = `12`
   - `MIN_DURATION_MINUTES` = `60`

5. Click **Apply** — Unraid will pull the image and start the container automatically.

To test immediately, add `RUN_NOW` = `true` as a variable before starting, then remove it after the first run.

---

### Build from source

```bash
git clone https://github.com/damianeek/sw-downloader.git
cd sw-downloader
docker build -t sw-downloader .

docker run -d \
  --name sw-downloader \
  --restart unless-stopped \
  -v "/path/to/downloads:/downloads" \
  sw-downloader
```

---

## Configuration

All settings are environment variables. Copy `.env.example` to `.env` and adjust.

| Variable | Default | Description |
|---|---|---|
| `CHANNEL_HANDLE` | `stan_wyjatkowy` | YouTube channel handle (without `@`) |
| `OUTPUT_DIR` | `/downloads` | Where downloaded videos are saved |
| `STATE_FILE` | `/downloads/state.json` | Persisted download state |
| `MAX_AGE_HOURS` | `12` | Max age (hours) of video to be considered the unedited stream |
| `MIN_DURATION_MINUTES` | `60` | Min duration (minutes) — filters out already-edited short versions |
| `AUDIO_OUTPUT_DIR` | `/audio` (Docker), empty (local) | Where audio-only copies are saved — extraction runs only if this directory exists (see [Audio-only copy](#audio-only-copy)) |
| `AUDIO_FORMAT` | `m4a` | `m4a` (lossless stream copy, fast) or `mp3` (re-encoded) |
| `SHOW_YEAR` | `2022` | Show premiere year used in filename |
| `FIND_CRON` | `5 20 * * 6` | When to look for a new stream (cron, Europe/Warsaw) |
| `DOWNLOAD_CRON` | `*/30 * * * *` | How often to attempt download after stream is found |
| `TIMEZONE` | `Europe/Warsaw` | Timezone for all cron jobs |
| `YTDLP_BIN` | `yt-dlp` | Path to yt-dlp binary |
| `FFMPEG_LOCATION` | `/usr/local/bin/ffmpeg` | Path to ffmpeg (yt-dlp static build bundled in Docker, override for local dev) |
| `RUN_NOW` | `false` | Set to `true` to trigger immediately instead of waiting for cron |

### Docker Compose

```yaml
services:
  sw-downloader:
    build: .
    restart: unless-stopped
    volumes:
      - /path/to/downloads:/downloads
    environment:
      - CHANNEL_HANDLE=stan_wyjatkowy
      - OUTPUT_DIR=/downloads
      - TIMEZONE=Europe/Warsaw
```

---

## Output filename

```
Stan Wyjątkowy (2022) - 2026-04-05 - Episode title here [videoId].mp4
```

The MP4 has the YouTube thumbnail embedded as cover art, plus title, description, upload date and chapters as metadata.

---

## Audio-only copy

Mount a directory at `/audio` and each downloaded episode is also saved there as audio only — same filename, `.m4a` (or `.mp3` with `AUDIO_FORMAT=mp3`). Cover art, title, description and chapters are carried over from the video, so the file is ready for a podcast / audiobook player.

```bash
docker run -d \
  --name sw-downloader \
  --restart unless-stopped \
  -v "/path/to/downloads:/downloads" \
  -v "/path/to/audio:/audio" \
  ghcr.io/damianeek/sw-downloader:latest
```

No `/audio` mount → no audio file. Extraction runs after the download (and NFO); if it fails, the video stays marked as done and extraction is retried on the next download tick.

Convert an existing video by hand:

```bash
AUDIO_OUTPUT_DIR=/path/to/audio node src/audio.js "/path/to/video.mp4"
```

---

## Local development

```bash
npm install
npx playwright install chromium

# copy and edit .env
cp .env.example .env

# test the scraper (debug screenshots land next to the state file)
node src/findStream.js

# test a download directly
node src/download.js "https://www.youtube.com/watch?v=VIDEO_ID"

# test the full pipeline immediately
RUN_NOW=true node src/index.js
```

### State file

The state file (`state.json`) tracks what was found and downloaded. Delete it to force a fresh run.

```json
{
  "streamUrl": "https://www.youtube.com/watch?v=...",
  "foundAt": "2026-04-05T20:05:00.000Z",
  "status": "done",
  "downloadedFile": "/downloads/Stan Wyjątkowy (2022) - 2026-04-05 - ... .mp4",
  "audioFile": "/audio/Stan Wyjątkowy (2022) - 2026-04-05 - ... .m4a",
  "completedAt": "2026-04-05T21:03:00.000Z",
  "error": null
}
```

Status values: `idle` → `found` → `downloading` → `done` (or `failed` → retries on next tick)
