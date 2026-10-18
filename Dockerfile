FROM node:22-slim@sha256:32b9e321f262db540d55ac10dc529667cf4737546e097cdd36a843c62bcbf423

# System dependencies: Chromium (Playwright) — ffmpeg is installed separately below
RUN apt-get update && apt-get install -y \
    curl \
    tini \
    unzip \
    xz-utils \
    # Chromium runtime deps
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip with its recommended extras:
#   default   — mutagen (cover art embedding in MP4), yt-dlp-ejs (YouTube JS
#               challenge solver used with Deno), websockets, brotli, ...
#   curl-cffi — browser impersonation support
# Keep in sync with the update command in src/index.js (jobUpdate)
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages "yt-dlp[default,curl-cffi]"

# ffmpeg + ffprobe from yt-dlp's own static builds — recommended by yt-dlp
# (patched for its use cases) and much newer than Debian's ffmpeg 5.1
RUN curl -fsSL https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz \
    | tar -xJ -C /usr/local/bin --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe' \
    && ffmpeg -version | head -1

# Install Deno — yt-dlp's default JS runtime for YouTube extraction
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip \
    -o /tmp/deno.zip \
    && unzip /tmp/deno.zip -d /usr/local/bin \
    && rm /tmp/deno.zip \
    && deno --version

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Install Playwright's Chromium browser — separate layer so it only rebuilds
# when the playwright package version changes, not when app code changes.
# Headless shell only: there is no display in the container, so the full
# Chromium would be dead weight (~400 MB)
RUN npx playwright install --only-shell chromium

COPY src/ ./src/

# ── Defaults (all overridable via docker run -e or .env) ──────────────────────
ENV CHANNEL_HANDLE=stan_wyjatkowy \
    OUTPUT_DIR=/downloads \
    STATE_FILE=/config/state.json \
    YTDLP_BIN=yt-dlp \
    FFMPEG_LOCATION=/usr/local/bin/ffmpeg \
    AUDIO_OUTPUT_DIR=/audio \
    AUDIO_FORMAT=m4a \
    FIND_CRON="5 20 * * 6" \
    FIND_RETRY_CRON="*/5 20-23 * * 6" \
    DOWNLOAD_CRON="*/30 * * * *" \
    UPDATE_CRON="0 19 * * 6" \
    TIMEZONE=Europe/Warsaw \
    RUN_NOW=false

VOLUME ["/downloads", "/config"]
# /audio is deliberately NOT a VOLUME — audio extraction runs only when the user
# mounts a directory there; a declared VOLUME would always create an anonymous one

# tini as PID 1 reaps orphaned Chromium helper processes (zygote, renderers,
# crashpad) that get reparented to PID 1 after browser.close() — node never
# wait()s on processes it didn't spawn, so without tini they pile up as zombies
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
