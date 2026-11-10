/**
 * Central configuration — all values come from environment variables.
 * Loads .env from the project root automatically (no-op if file doesn't exist).
 */

import 'dotenv/config';
import path from 'path';

// Prefix all console output with a local timestamp in the configured timezone
const _tz = process.env.TIMEZONE || 'Europe/Warsaw';
for (const method of ['log', 'warn', 'error']) {
  const orig = console[method].bind(console);
  console[method] = (...args) => {
    const ts = new Date().toLocaleString('en-US', {
      timeZone: _tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    orig(`[${ts}]`, ...args);
  };
}

const stateFile = process.env.STATE_FILE || '/downloads/state.json';

const AUDIO_FORMATS = ['m4a', 'mp3'];

function parseAudioFormat(value) {
  const format = (value || 'm4a').toLowerCase();
  if (AUDIO_FORMATS.includes(format)) return format;
  console.warn(`Unknown AUDIO_FORMAT "${value}" — falling back to m4a.`);
  return 'm4a';
}

export const config = {
  // YouTube channel handle (without @)
  channelHandle: process.env.CHANNEL_HANDLE || 'stan_wyjatkowy',

  // Output directory for downloaded files
  outputDir: process.env.OUTPUT_DIR || '/downloads',

  // State file path — tracks stream URL and download status across cron runs
  stateFile,

  // Directory derived from stateFile — used for debug screenshots, etc.
  stateDir: path.dirname(stateFile),

  // Path to ffmpeg binary (passed to yt-dlp via --ffmpeg-location)
  ffmpegLocation: process.env.FFMPEG_LOCATION || '',

  // Path to yt-dlp binary
  ytdlpBin: process.env.YTDLP_BIN || 'yt-dlp',

  // Temp directory for yt-dlp partial/part files — merged file lands in outputDir
  // Default is /tmp/sw-dl (RAM-backed tmpfs on Linux); override with TEMP_DIR env var
  tempDir: process.env.TEMP_DIR || '/tmp/sw-dl',

  // Whether to generate a Plex-compatible .nfo sidecar file after each download
  generateNfo: process.env.GENERATE_NFO === 'true',

  // Whether to download Polish subtitles and embed them as an internal track in the MP4.
  // yt-dlp tries manual subs first, falls back to auto-generated.
  downloadSubtitles: process.env.DOWNLOAD_SUBTITLES === 'true',

  // Directory for audio-only copies of downloaded videos (with cover, description
  // and chapters taken from the video). Extraction runs only when this directory
  // exists — in Docker that means a volume is mounted at this path.
  audioOutputDir: process.env.AUDIO_OUTPUT_DIR || '',

  // Audio format: 'm4a' (lossless stream copy, fast) or 'mp3' (re-encoded)
  audioFormat: parseAudioFormat(process.env.AUDIO_FORMAT),

  // Cron: how often to look for a new episode. Episodes no longer air only on
  // Saturday evenings, so the default checks every day
  // Default: every 15 minutes
  findCron: process.env.FIND_CRON || '*/15 * * * *',

  // Cron: optional extra find schedule, e.g. denser checks around a known
  // airing time. Empty = disabled
  findRetryCron: process.env.FIND_RETRY_CRON || '',

  // Cron: how often to attempt downloading after stream is found
  // Default: every 30 minutes
  downloadCron: process.env.DOWNLOAD_CRON || '*/30 * * * *',

  // Cron: yt-dlp update schedule — an episode can come out any day, so keep
  // yt-dlp fresh daily. Also runs once at container startup.
  // Default: every day at 04:00
  updateCron: process.env.UPDATE_CRON || '0 4 * * *',

  // Timezone for all cron jobs
  timezone: process.env.TIMEZONE || 'Europe/Warsaw',

  // Set to 'true' to run the find+download pipeline immediately (skip cron)
  runNow: process.env.RUN_NOW === 'true',

  // Year the show premiered. Used in the custom filename style.
  // When set, filenames use: "Uploader (YEAR) - YYYY-MM-DD - Title [id].mp4"
  // When empty, uses yt-dlp default:  "Uploader - Title [id].mp4"
  showYear: process.env.SHOW_YEAR || '2022',

  // Minimum video duration (in minutes) to be considered the full unedited stream.
  // Clips on the channel run up to ~17 min and special editions 48–60 min, while
  // fresh episodes are 2h+. Live streams have no duration and always pass.
  minDurationMinutes: parseFloat(process.env.MIN_DURATION_MINUTES || '90'),

  // How old (in hours) a video can be and still be considered the unedited stream.
  maxAgeHours: parseFloat(process.env.MAX_AGE_HOURS || '12'),

  // Base URL for YouTube (used for mocking during tests)
  youtubeBaseUrl: process.env.YOUTUBE_BASE_URL || 'https://www.youtube.com',
};
