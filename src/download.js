/**
 * Downloads a finished YouTube stream using yt-dlp.
 * Returns the path of the downloaded file on success.
 *
 * @param {string} videoUrl
 * @returns {Promise<string>} absolute path of the downloaded file
 */

import { execa } from 'execa';
import path from 'path';
import fs from 'fs';
import { config } from './config.js';

export async function downloadStream(videoUrl) {
  fs.mkdirSync(config.outputDir, { recursive: true });
  fs.mkdirSync(config.tempDir,   { recursive: true });

  const filenameTemplate = config.showYear
    ? `%(uploader)s (${config.showYear}) - %(upload_date>%Y-%m-%d)s - %(title)s [%(id)s].%(ext)s`
    : '%(uploader)s - %(title)s [%(id)s].%(ext)s';

  const args = [
    videoUrl,
    '--paths',  `home:${config.outputDir}`,
    '--paths',  `temp:${config.tempDir}`,
    '--output', filenameTemplate,
    '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--newline',
  ];

  if (config.downloadSubtitles) {
    // --write-auto-subs is needed to request auto-generated subs from YouTube.
    // --embed-subs embeds them into the MP4 during the ffmpeg merge.
    // Leftover subtitle files are deleted from outputDir after the merge.
    args.push(
      '--write-auto-subs',
      '--sub-langs', 'pl',
      '--embed-subs',
    );
  }

  if (config.ffmpegLocation) {
    args.push('--ffmpeg-location', config.ffmpegLocation);
  }

  console.log(`[download] Starting: ${videoUrl}`);
  console.log(`[download] Output: ${config.outputDir}  Temp: ${config.tempDir}`);

  // Snapshot existing mp4s so we can identify the new file afterwards
  const before = existingMp4s(config.outputDir);
  const startedAt = Date.now();

  // Full stdio inherit — progress and all output goes straight to the terminal
  try {
    await execa(config.ytdlpBin, args, { stdio: 'inherit' });
  } finally {
    // Always clean up temp dir, even on failure
    try {
      fs.rmSync(config.tempDir, { recursive: true, force: true });
      console.log(`[download] Temp dir cleaned: ${config.tempDir}`);
    } catch (e) {
      console.warn(`[download] Could not clean temp dir: ${e.message}`);
    }
  }

  // Remove any subtitle sidecar files left in outputDir — subs are embedded
  if (config.downloadSubtitles) {
    cleanSubtitleFiles(config.outputDir, startedAt);
  }

  // Find the file that appeared (or grew) since we started
  const downloadedFile = findNewFile(config.outputDir, before, startedAt);

  if (!downloadedFile) {
    throw new Error('yt-dlp exited successfully but no new mp4 file was found in output dir.');
  }

  const stat = fs.statSync(downloadedFile);
  if (stat.size === 0) {
    throw new Error(`Downloaded file is empty: ${downloadedFile}`);
  }

  console.log(`[download] Done: ${downloadedFile} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  return downloadedFile;
}

const SUBTITLE_EXTS = ['.vtt', '.srt', '.ass', '.ssa', '.ttml'];

function cleanSubtitleFiles(dir, since) {
  try {
    fs.readdirSync(dir)
      .filter((f) => SUBTITLE_EXTS.some((ext) => f.endsWith(ext)))
      .map((f) => path.join(dir, f))
      .filter((f) => fs.statSync(f).mtimeMs >= since)
      .forEach((f) => {
        fs.rmSync(f, { force: true });
        console.log(`[download] Removed subtitle sidecar: ${f}`);
      });
  } catch (e) {
    console.warn(`[download] Could not clean subtitle files: ${e.message}`);
  }
}

function existingMp4s(dir) {
  try {
    return new Set(
      fs.readdirSync(dir)
        .filter((f) => f.endsWith('.mp4'))
        .map((f) => path.join(dir, f))
    );
  } catch {
    return new Set();
  }
}

function findNewFile(dir, before, startedAt) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => path.join(dir, f))
      .filter((f) => !before.has(f) || fs.statSync(f).mtimeMs >= startedAt);

    if (files.length === 0) return null;
    // Return the most recently modified one
    return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  } catch {
    return null;
  }
}

// Run directly: node src/download.js <url>
if (process.argv[1].endsWith('download.js')) {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node src/download.js <youtube-url>');
    process.exit(1);
  }
  downloadStream(url)
    .then((file) => console.log('Saved to:', file))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
