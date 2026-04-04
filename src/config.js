/**
 * Central configuration — all values come from environment variables.
 * Loads .env from the project root automatically (no-op if file doesn't exist).
 */

import 'dotenv/config';

export const config = {
  // YouTube channel handle (without @)
  channelHandle: process.env.CHANNEL_HANDLE || 'stan_wyjatkowy',

  // Output directory for downloaded files
  outputDir: process.env.OUTPUT_DIR || '/downloads',

  // State file path — tracks stream URL and download status across cron runs
  stateFile: process.env.STATE_FILE || '/downloads/state.json',

  // Path to ffmpeg binary (passed to yt-dlp via --ffmpeg-location)
  ffmpegLocation: process.env.FFMPEG_LOCATION || '',

  // Path to yt-dlp binary
  ytdlpBin: process.env.YTDLP_BIN || 'yt-dlp',

  // Cron: when to check if the stream is live and grab the URL
  // Default: Saturday 20:05 Europe/Warsaw
  findCron: process.env.FIND_CRON || '5 20 * * 6',

  // Cron: how often to attempt downloading after stream is found
  // Default: every 30 minutes
  downloadCron: process.env.DOWNLOAD_CRON || '*/30 * * * *',

  // Timezone for all cron jobs
  timezone: process.env.TIMEZONE || 'Europe/Warsaw',

  // Set to 'true' to run the find+download pipeline immediately (skip cron)
  runNow: process.env.RUN_NOW === 'true',

  // Year the show premiered. Used in the custom filename style.
  // When set, filenames use: "Uploader (YEAR) - YYYY-MM-DD - Title [id].mp4"
  // When empty, uses yt-dlp default:  "Uploader - Title [id].mp4"
  showYear: process.env.SHOW_YEAR || '2022',

  // Minimum video duration (in minutes) to be considered the full unedited stream.
  // After editing, the VOD is cut to just the intro — default 60 minutes.
  minDurationMinutes: parseFloat(process.env.MIN_DURATION_MINUTES || '60'),

  // How old (in hours) a video can be and still be considered the unedited stream.
  maxAgeHours: parseFloat(process.env.MAX_AGE_HOURS || '12'),

  // Set to 'false' to show the browser window (for debugging)
  headless: process.env.HEADLESS !== 'false',
};
