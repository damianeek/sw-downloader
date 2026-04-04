FROM node:22-slim

# System dependencies: ffmpeg + Chromium (Playwright)
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    ffmpeg \
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

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# Install Deno — yt-dlp's default JS runtime for YouTube extraction
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip \
    -o /tmp/deno.zip \
    && unzip /tmp/deno.zip -d /usr/local/bin \
    && rm /tmp/deno.zip \
    && deno --version

WORKDIR /app

COPY package.json ./
RUN npm install

# Install Playwright's Chromium browser
RUN npx playwright install chromium

COPY src/ ./src/

# ── Defaults (all overridable via docker run -e or .env) ──────────────────────
ENV CHANNEL_HANDLE=stan_wyjatkowy \
    OUTPUT_DIR=/downloads \
    STATE_FILE=/downloads/state.json \
    YTDLP_BIN=yt-dlp \
    FFMPEG_LOCATION=/usr/bin/ffmpeg \
    FIND_CRON="5 20 * * 6" \
    DOWNLOAD_CRON="*/30 * * * *" \
    TIMEZONE=Europe/Warsaw \
    RUN_NOW=false \
    HEADLESS=true

VOLUME ["/downloads"]

CMD ["node", "src/index.js"]
