/**
 * Generates a Plex-compatible NFO sidecar file for a downloaded video.
 *
 * Uses yt-dlp --dump-json to fetch metadata (title, description, upload date,
 * channel, thumbnail), then writes an <episodedetails> XML file next to the
 * video file. Plex reads these via its "Local Media Assets" agent.
 *
 * @param {string} videoUrl   YouTube URL
 * @param {string} videoFile  Absolute path to the downloaded .mp4
 */

import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

export async function generateNfo(videoUrl, videoFile) {
  const nfoFile = videoFile.replace(/\.[^.]+$/, '.nfo');

  if (fs.existsSync(nfoFile)) {
    console.log(`[nfo] Already exists: ${nfoFile}`);
    return;
  }

  console.log(`[nfo] Fetching metadata for ${videoUrl}`);

  const args = [videoUrl, '--dump-json', '--no-playlist', '--no-warnings'];
  if (config.ffmpegLocation) args.push('--ffmpeg-location', config.ffmpegLocation);

  let info;
  try {
    const { stdout } = await execa(config.ytdlpBin, args);
    info = JSON.parse(stdout);
  } catch (err) {
    console.error(`[nfo] Could not fetch metadata: ${err.message}`);
    return;
  }

  const title       = escapeXml(info.title        || '');
  const description = escapeXml(info.description  || '');
  const uploader    = escapeXml(info.uploader      || info.channel || '');
  const videoId     = info.id || '';

  // upload_date is YYYYMMDD — convert to YYYY-MM-DD
  const rawDate = info.upload_date || '';
  const aired   = rawDate.length === 8
    ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
    : '';

  // Best available thumbnail
  const thumb = info.thumbnail || (videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : '');

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>${title}</title>
  <plot>${description}</plot>
  <aired>${aired}</aired>
  <studio>${uploader}</studio>
  <thumb aspect="thumb">${escapeXml(thumb)}</thumb>
  <uniqueid type="youtube" default="true">${videoId}</uniqueid>
</episodedetails>
`;

  fs.writeFileSync(nfoFile, xml, 'utf8');
  console.log(`[nfo] Written: ${nfoFile}`);
}

function escapeXml(str) {
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}
