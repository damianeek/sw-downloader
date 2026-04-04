/**
 * Uses yt-dlp --dump-json to check whether a YouTube stream is still live
 * or has finished (VOD available for download).
 *
 * Returns:
 *   'live'     — stream is currently broadcasting
 *   'finished' — stream ended, VOD is available
 *   'unknown'  — could not determine (yt-dlp error, private video, etc.)
 */

import { execa } from 'execa';
import { config } from './config.js';

/**
 * @param {string} videoUrl
 * @returns {Promise<'live'|'finished'|'unknown'>}
 */
export async function checkStreamStatus(videoUrl) {
  const args = [
    videoUrl,
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
  ];

  if (config.ffmpegLocation) {
    args.push('--ffmpeg-location', config.ffmpegLocation);
  }


  try {
    const { stdout } = await execa(config.ytdlpBin, args);
    const info = JSON.parse(stdout);

    if (info.is_live === true) {
      console.log(`Stream is LIVE: ${videoUrl}`);
      return 'live';
    }

    if (info.is_live === false || info.was_live === true) {
      console.log(`Stream is FINISHED (VOD ready): ${videoUrl}`);
      return 'finished';
    }

    // Some VODs don't set is_live at all — if we get valid JSON with a duration, it's done
    if (info.duration && info.duration > 0) {
      console.log(`Stream has duration ${info.duration}s — treating as finished.`);
      return 'finished';
    }

    console.warn('Could not determine stream status from yt-dlp output.');
    return 'unknown';
  } catch (err) {
    console.error(`checkStreamStatus error: ${err.message}`);
    return 'unknown';
  }
}
