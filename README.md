# player

Single-user, self-hosted YouTube downloader with a built-in video/audio streaming
web app. Download videos via yt-dlp, then watch or listen in the browser — audio-only
playback keeps working with the phone screen off (mobile background playback).

## Features

- Download YouTube videos/shorts via URL (yt-dlp)
- Stream video (MP4/WebM) with HTTP Range support
- Audio-only mode (extracted MP3) for music / low-bandwidth listening
- Background playback on mobile (audio stream keeps playing when the app is backgrounded or the screen is off)
- Thumbnail display, download progress via job polling
- Optional token-based login (single shared token)
- No database — everything on disk under `DATA_DIR`

## Quick start (Docker)

```sh
mkdir -p data
docker compose up -d --build
```

Create `./data` before starting: if the Docker daemon auto-creates it for the bind
mount, it is owned by root and the in-container user (uid 1000) can't write to it.

Then open http://localhost:8000. Downloads are stored in `./data/` on the host.

## Configuration

| Variable       | Default in compose | Description                                                        |
| -------------- | ------------------ | ------------------------------------------------------------------ |
| `ACCESS_TOKEN` | `""` (empty)       | Empty = no auth (trusted LAN only). Otherwise set a strong token; the web app will ask for it and set a login cookie. |
| `DATA_DIR`     | `/data`            | Where media/metadata are stored. Keep it pointing at the mounted volume. |
| Port mapping   | `8000:8000`        | Host port in `ports:` of `docker-compose.yml`.                     |

## Storage layout

All data lives under `DATA_DIR` (mounted from `./data` in compose):

```
data/
└── media/
    └── <video-id>/
        ├── video.*      # downloaded video file
        ├── audio.mp3    # extracted audio
        ├── thumb.*      # thumbnail
        └── meta.json    # title, duration, timestamps
```

The library is derived from `meta.json` files, so the volume can be backed up or
moved as-is; contents are rescanned on startup.

## Updating yt-dlp

YouTube changes frequently; update by rebuilding the image with fresh packages:

```sh
docker compose build --pull
docker compose up -d
```

## HTTPS note

If you expose the app beyond your LAN, put it behind a reverse proxy with TLS
(e.g. Caddy/nginx) and set a strong `ACCESS_TOKEN` — otherwise media and the
token cookie travel in cleartext.

## Local development (without Docker)

```sh
pip install -r requirements.txt
uvicorn app.main:app
```

Requires `ffmpeg` on PATH. Data goes to `./data` unless `DATA_DIR` is set.
