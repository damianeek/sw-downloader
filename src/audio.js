/**
 * Extracts an audio-only copy of a downloaded video into AUDIO_OUTPUT_DIR.
 *
 * Everything comes from the video file itself — yt-dlp embeds the cover
 * (thumbnail), title, description and chapters during download, and ffmpeg
 * carries them over into the audio file. No extra requests to YouTube.
 *
 *   m4a — audio stream is copied as-is (lossless, takes seconds)
 *   mp3 — audio is re-encoded with libmp3lame (VBR ~190 kbps)
 *
 * Extraction is enabled only when AUDIO_OUTPUT_DIR is set and the directory
 * exists — in Docker that means a volume is mounted at that path.
 */

import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const FORMATS = {
  m4a: { muxer: 'ipod', codec: ['-c:a', 'copy'] },
  mp3: { muxer: 'mp3',  codec: ['-c:a', 'libmp3lame', '-q:a', '2', '-id3v2_version', '3'] },
};

export function isAudioEnabled() {
  if (!config.audioOutputDir) return false;
  try {
    return fs.statSync(config.audioOutputDir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} videoFile  Absolute path to the downloaded .mp4
 * @param {{ overwrite?: boolean }} [options]  overwrite — replace an existing audio file
 * @returns {Promise<string>} absolute path of the audio file
 */
export async function extractAudio(videoFile, { overwrite = false } = {}) {
  const base = path.basename(videoFile, path.extname(videoFile));
  const audioFile = path.join(config.audioOutputDir, `${base}.${config.audioFormat}`);

  if (!overwrite && fs.existsSync(audioFile)) {
    console.log(`[audio] Already exists: ${audioFile}`);
    return audioFile;
  }

  const coverIndex = await findCoverStreamIndex(videoFile);
  if (coverIndex === null) {
    console.warn(`[audio] No embedded cover in ${videoFile} — audio will have no artwork.`);
  }

  // Write to a .part file first so media scanners never pick up a half-written file
  const partFile = `${audioFile}.part`;
  console.log(`[audio] Extracting ${config.audioFormat}: ${audioFile}`);

  try {
    await execa(ffBin('ffmpeg'), buildFfmpegArgs(videoFile, partFile, config.audioFormat, coverIndex));

    if (fs.statSync(partFile).size === 0) {
      throw new Error(`Extracted audio is empty: ${partFile}`);
    }
    fs.renameSync(partFile, audioFile);
  } catch (err) {
    fs.rmSync(partFile, { force: true });
    throw err;
  }

  const { size } = fs.statSync(audioFile);
  console.log(`[audio] Done: ${audioFile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return audioFile;
}

/**
 * @param {string} input
 * @param {string} output
 * @param {'m4a'|'mp3'} format
 * @param {number|null} coverIndex  index of the attached_pic stream in input, if any
 * @returns {string[]}
 */
export function buildFfmpegArgs(input, output, format, coverIndex) {
  const { muxer, codec } = FORMATS[format];

  // First audio stream only — skips the video and any embedded subtitle track
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:a:0'];

  if (coverIndex !== null) {
    args.push('-map', `0:${coverIndex}`, '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
  }

  // Title, description, date etc. + chapters come from the video's container metadata
  args.push('-map_metadata', '0', '-map_chapters', '0', ...codec, '-f', muxer, output);
  return args;
}

/**
 * Finds the stream that yt-dlp's --embed-thumbnail added as cover art.
 * @returns {Promise<number|null>}
 */
async function findCoverStreamIndex(videoFile) {
  try {
    const { stdout } = await execa(ffBin('ffprobe'), [
      '-v', 'error',
      '-select_streams', 'v',
      '-show_entries', 'stream=index:stream_disposition=attached_pic',
      '-of', 'json',
      videoFile,
    ]);
    const streams = JSON.parse(stdout).streams || [];
    return streams.find((s) => s.disposition?.attached_pic === 1)?.index ?? null;
  } catch (err) {
    console.warn(`[audio] ffprobe failed: ${err.message}`);
    return null;
  }
}

/**
 * Resolves ffmpeg/ffprobe next to FFMPEG_LOCATION, which (like yt-dlp's
 * --ffmpeg-location) may point at the ffmpeg binary or at its directory.
 */
function ffBin(name) {
  const loc = config.ffmpegLocation;
  if (!loc) return name;

  let isDir = false;
  try { isDir = fs.statSync(loc).isDirectory(); } catch { /* treat as file path */ }

  return isDir
    ? path.join(loc, name)
    : path.join(path.dirname(loc), name + path.extname(loc));
}

// Run directly: node src/audio.js <video.mp4>
if (process.argv[1]?.endsWith('audio.js')) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/audio.js <video.mp4>');
    process.exit(1);
  }
  if (!isAudioEnabled()) {
    console.error(`AUDIO_OUTPUT_DIR is not set or does not exist: "${config.audioOutputDir}"`);
    process.exit(1);
  }
  extractAudio(path.resolve(file), { overwrite: true })
    .then((out) => console.log('Saved to:', out))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
