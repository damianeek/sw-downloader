import fs from 'fs';
import os from 'os';
import path from 'path';
import { execa } from 'execa';
import { jest } from '@jest/globals';

// Env must be set BEFORE importing config. ffmpeg/ffprobe come from PATH —
// an empty value keeps dotenv from filling FFMPEG_LOCATION from a local .env
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-audio-test-'));
const audioDir = path.join(tmp, 'audio');
fs.mkdirSync(audioDir);
process.env.AUDIO_OUTPUT_DIR = audioDir;
process.env.AUDIO_FORMAT = 'm4a';
process.env.FFMPEG_LOCATION = '';

jest.setTimeout(60000);

// What yt-dlp --embed-metadata writes: upload_date as YYYYMMDD
const YTDLP_DATE = '20261110';
const VIDEO_NAME = 'Stan Wyjątkowy (2022) - 2026-11-10 - Test episode [S0c5DPXLH84]';

/** Same as Audiobookshelf: the raw tag value goes straight into new Date() */
function absParseDate(value) {
  return new Date(value);
}

async function probeDateTag(file) {
  const { stdout } = await execa('ffprobe', [
    '-v', 'error', '-show_entries', 'format_tags=date', '-of', 'json', file,
  ]);
  return JSON.parse(stdout).format?.tags?.date;
}

/** Builds an MP4 the way the download step does: audio + video + jpg cover + date tag */
async function makeVideo(file) {
  const cover = path.join(tmp, 'cover.jpg');
  await execa('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', cover]);
  await execa('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1',
    '-i', cover,
    '-map', '1', '-map', '0', '-map', '2',
    '-c:v:0', 'mpeg4', '-c:a', 'aac', '-c:v:1', 'mjpeg', '-disposition:v:1', 'attached_pic',
    '-metadata', `date=${YTDLP_DATE}`, '-metadata', 'title=Test episode',
    file,
  ]);
}

describe('audio date tag', () => {
  let extractAudio;
  let toIsoDate;

  beforeAll(async () => {
    ({ extractAudio, toIsoDate } = await import('../src/audio.js'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('yt-dlp date format is what ABS cannot parse', () => {
    expect(Number.isNaN(absParseDate(YTDLP_DATE).getTime())).toBe(true);
  });

  it('final M4A has date YYYY-MM-DD that ABS parses to the publish date', async () => {
    const video = path.join(tmp, `${VIDEO_NAME}.mp4`);
    await makeVideo(video);
    expect(await probeDateTag(video)).toBe(YTDLP_DATE);

    const audioFile = await extractAudio(video);

    // Filename unchanged apart from the extension
    expect(audioFile).toBe(path.join(audioDir, `${VIDEO_NAME}.m4a`));

    const tag = await probeDateTag(audioFile);
    expect(tag).toBe('2026-11-10');

    const parsed = absParseDate(tag);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.toISOString().slice(0, 10)).toBe('2026-11-10');
  });

  it.each([
    ['20261110', '2026-11-10'],
    ['2026-11-10', '2026-11-10'],
    ['2026-11-10T19:00:00.000000Z', '2026-11-10'],
    ['20261340', null],
    ['2026', null],
    ['', null],
    [undefined, null],
  ])('toIsoDate(%p) → %p', (value, expected) => {
    expect(toIsoDate(value)).toBe(expected);
  });
});
