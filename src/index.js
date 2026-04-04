/**
 * Entry point — two independent cron jobs:
 *
 *  JOB 1 — "find"   (default: Sat 20:05 Europe/Warsaw)
 *    Playwright scrapes the channel, finds the newest video that is
 *    > MIN_DURATION_MINUTES long and uploaded within MAX_AGE_HOURS.
 *    Saves URL to state.json unless it was already downloaded.
 *
 *  JOB 2 — "download"  (default: every 30 min)
 *    If state.status === 'found':
 *      - asks yt-dlp whether the stream is still live or finished
 *      - if finished → downloads, marks state as 'done'
 *      - if still live → skips, retries next tick
 *
 * Set RUN_NOW=true to trigger both jobs immediately (for testing).
 */

import cron from 'node-cron';
import { config } from './config.js';
import { findLatestStreamUrl } from './findStream.js';
import { checkStreamStatus } from './checkStreamStatus.js';
import { downloadStream } from './download.js';
import { readState, writeState, isAlreadyDone } from './state.js';

// ─── Job 1: find the stream URL ───────────────────────────────────────────────

async function jobFind() {
  const tag = '[find]';
  console.log(`${tag} ${new Date().toISOString()} — checking for new stream...`);

  const url = await findLatestStreamUrl();
  if (!url) {
    console.log(`${tag} No matching video found (< ${config.maxAgeHours}h old, > ${config.minDurationMinutes}min).`);
    return;
  }

  if (isAlreadyDone(url)) {
    console.log(`${tag} Already downloaded: ${url}`);
    return;
  }

  writeState({
    streamUrl: url,
    foundAt: new Date().toISOString(),
    status: 'found',
    downloadedFile: null,
    completedAt: null,
    error: null,
  });

  console.log(`${tag} New URL saved — download job will pick it up on its next tick.`);
}

// ─── Job 2: download the stream once it's finished ───────────────────────────

async function jobDownload() {
  const tag = '[download]';
  console.log(`${tag} ${new Date().toISOString()} — checking state...`);

  const state = readState();

  if (!state.streamUrl) {
    console.log(`${tag} No stream URL in state yet.`);
    return;
  }

  if (state.status === 'done') {
    console.log(`${tag} Already downloaded: ${state.downloadedFile}`);
    return;
  }

  if (state.status === 'downloading') {
    console.log(`${tag} Download already in progress — skipping.`);
    return;
  }

  // 'found' or 'failed' (retry on failure)
  const streamStatus = await checkStreamStatus(state.streamUrl);

  if (streamStatus === 'live') {
    console.log(`${tag} Stream still live. Will retry next tick.`);
    return;
  }

  if (streamStatus === 'unknown') {
    console.warn(`${tag} Could not determine stream status. Will retry next tick.`);
    return;
  }

  // streamStatus === 'finished'
  writeState({ status: 'downloading' });

  try {
    const file = await downloadStream(state.streamUrl);
    writeState({ status: 'done', downloadedFile: file, completedAt: new Date().toISOString(), error: null });
    console.log(`${tag} All done. Saved to: ${file}`);
  } catch (err) {
    console.error(`${tag} Download failed: ${err.message}`);
    writeState({ status: 'failed', error: err.message });
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

if (config.runNow) {
  console.log('RUN_NOW=true — running both jobs immediately.');
  jobFind().then(() => jobDownload()).catch(console.error);
} else {
  console.log('=== sw-downloader started ===');
  console.log(`Find cron    : ${config.findCron} (${config.timezone})`);
  console.log(`Download cron: ${config.downloadCron} (${config.timezone})`);
  console.log(`Channel      : @${config.channelHandle}`);
  console.log(`Output dir   : ${config.outputDir}`);
  console.log(`Max age      : ${config.maxAgeHours}h`);
  console.log(`Min duration : ${config.minDurationMinutes}min`);

  cron.schedule(config.findCron, jobFind, { timezone: config.timezone });
  cron.schedule(config.downloadCron, jobDownload, { timezone: config.timezone });
}
