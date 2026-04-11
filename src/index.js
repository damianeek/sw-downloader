/**
 * Entry point — three cron jobs:
 *
 *  JOB 1 — "find" initial  (default: Sat 20:05)
 *    First trigger for the weekly stream.
 *
 *  JOB 2 — "find" retry    (default: every 5 min, Sat 20:00–23:59)
 *    Keeps looking every 5 min in case the stream wasn't up at 20:05.
 *    Skips immediately if the URL is already in state.
 *
 *  JOB 3 — "download"      (default: every 30 min)
 *    Once a URL is in state, checks if stream is finished and downloads.
 *
 * On startup: if it's Saturday and past 20:05, both jobs run immediately
 * so a freshly deployed/restarted container catches up without waiting.
 *
 * Set RUN_NOW=true to force both jobs immediately regardless of day/time.
 */

import cron from 'node-cron';
import { readFileSync } from 'fs';
import { CronExpressionParser } from 'cron-parser';
import { config } from './config.js';

function nextCronTime(expression) {
  try {
    const next = CronExpressionParser.parse(expression, { tz: config.timezone }).next().toDate();
    return next.toLocaleString('en-US', {
      timeZone: config.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });
  } catch {
    return 'next tick';
  }
}

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
import { findLatestStreamUrl } from './findStream.js';
import { checkStreamStatus } from './checkStreamStatus.js';
import { downloadStream } from './download.js';
import { readState, writeState, isAlreadyDone } from './state.js';
import { generateNfo } from './nfo.js';

// ─── Job: find ────────────────────────────────────────────────────────────────

async function jobFind() {
  const tag = '[find]';
  console.log(`${tag} Checking for new stream...`);

  const state = readState();

  // If we already found (or downloaded) a stream today, don't search again
  if (state.streamUrl && state.foundAt) {
    const tz = config.timezone;
    const foundDate = new Date(state.foundAt).toLocaleDateString('en-US', { timeZone: tz });
    const today    = new Date().toLocaleDateString('en-US', { timeZone: tz });
    if (foundDate === today) {
      console.log(`${tag} Stream already found today (${state.status}): ${state.streamUrl} — skipping.`);
      return;
    }
  }

  const url = await findLatestStreamUrl();
  if (!url) {
    console.log(`${tag} No matching video found (< ${config.maxAgeHours}h old, > ${config.minDurationMinutes}min). Next check at ${nextCronTime(config.findRetryCron)}.`);
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

  console.log(`${tag} URL saved — download job will pick it up on its next tick.`);
}

// ─── Job: download ────────────────────────────────────────────────────────────

async function jobDownload() {
  const tag = '[download]';
  console.log(`${tag} Checking state...`);

  const state = readState();

  if (!state.streamUrl) {
    console.log(`${tag} No stream URL in state yet.`);
    return;
  }

  if (state.status === 'downloading') {
    console.log(`${tag} Download already in progress — skipping.`);
    return;
  }

  // ── Step 1: download (skip if already done) ───────────────────────────────
  let downloadedFile = state.downloadedFile;

  if (state.status !== 'done') {
    const streamStatus = await checkStreamStatus(state.streamUrl);

    if (streamStatus === 'live') {
      console.log(`${tag} Stream still live. Next check at ${nextCronTime(config.downloadCron)}.`);
      return;
    }

    if (streamStatus === 'unknown') {
      console.warn(`${tag} Could not determine stream status. Next check at ${nextCronTime(config.downloadCron)}.`);
      return;
    }

    writeState({ status: 'downloading' });

    try {
      downloadedFile = await downloadStream(state.streamUrl);
      writeState({ status: 'done', downloadedFile, completedAt: new Date().toISOString(), error: null });
      console.log(`${tag} Download complete. Saved to: ${downloadedFile}`);
    } catch (err) {
      console.error(`${tag} Download failed: ${err.message}`);
      writeState({ status: 'failed', error: err.message });
      return;
    }
  } else {
    console.log(`${tag} Already downloaded: ${downloadedFile}`);
  }

  // ── Step 2: NFO sidecar (skip if disabled or file already exists) ─────────
  if (config.generateNfo && downloadedFile) {
    await generateNfo(state.streamUrl, downloadedFile);
  }
}

// ─── Startup catch-up: run immediately if it's Saturday past 20:05 ────────────

function isInStreamWindow() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: config.timezone }));
  const isSaturday = now.getDay() === 6;
  const isPast2005 = now.getHours() > 20 || (now.getHours() === 20 && now.getMinutes() >= 5);
  const isBefore2359 = now.getHours() <= 23;
  return isSaturday && isPast2005 && isBefore2359;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

if (config.runNow || isInStreamWindow()) {
  const reason = config.runNow ? 'RUN_NOW=true' : 'Saturday stream window detected';
  console.log(`=== sw-downloader v${version} — ${reason}, running both jobs immediately ===`);
  jobFind().then(() => jobDownload()).catch(console.error);
} else {
  console.log(`=== sw-downloader v${version} started ===`);
  console.log(`Find cron    : ${config.findCron} (${config.timezone})`);
  console.log(`Retry cron   : ${config.findRetryCron} (${config.timezone})`);
  console.log(`Download cron: ${config.downloadCron} (${config.timezone})`);
  console.log(`Channel      : @${config.channelHandle}`);
  console.log(`Output dir   : ${config.outputDir}`);
  console.log(`Max age      : ${config.maxAgeHours}h | Min duration: ${config.minDurationMinutes}min`);
}

// Always register cron jobs (they're no-ops outside their schedule)
cron.schedule(config.findCron, jobFind, { timezone: config.timezone });
cron.schedule(config.findRetryCron, jobFind, { timezone: config.timezone });
cron.schedule(config.downloadCron, jobDownload, { timezone: config.timezone });
