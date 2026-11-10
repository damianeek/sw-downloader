/**
 * Entry point — cron jobs (plus a daily yt-dlp update):
 *
 *  JOB 1 — "find"          (default: every 15 min, any day)
 *    Looks for a fresh, long video. A newly found one is saved to state and
 *    the download job runs right away. An optional FIND_RETRY_CRON adds
 *    extra checks on top.
 *
 *  JOB 2 — "download"      (default: every 30 min)
 *    Once a URL is in state, checks if stream is finished and downloads.
 *
 * Set RUN_NOW=true to run both jobs immediately at startup.
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
import { execa } from 'execa';
import { findLatestStreamUrl, findLongestVideoOnDate } from './findStream.js';
import { checkStreamStatus } from './checkStreamStatus.js';
import { downloadStream } from './download.js';
import { readState, writeState } from './state.js';
import { generateNfo } from './nfo.js';
import { extractAudio, isAudioEnabled } from './audio.js';
import { logEvent, logIdle, logError } from './logger.js';

// ─── Job: update yt-dlp ───────────────────────────────────────────────────────

async function jobUpdate() {
  const tag = '[update]';
  console.log(`${tag} Updating yt-dlp...`);
  try {
    // Extras must match the Dockerfile — without them pip upgrades yt-dlp alone and
    // leaves yt-dlp-ejs (pinned to the yt-dlp version) outdated
    const { stdout, stderr } = await execa('pip3', ['install', '--break-system-packages', '-U', 'yt-dlp[default,curl-cffi]']);
    const output = (stdout || stderr || '').trim();
    // Log just the last line which contains the version info
    const lastLine = output.split('\n').pop();
    console.log(`${tag} ${lastLine}`);
    // Log yt-dlp version for confirmation
    const { stdout: ver } = await execa(config.ytdlpBin, ['--version']);
    logEvent(`${tag} yt-dlp updated to ${ver.trim()}`);
  } catch (err) {
    logError(`${tag} Update failed: ${err.message}`);
  }
}

// ─── Job: find ────────────────────────────────────────────────────────────────

let findInProgress = false;

/** Returns true when a new stream was saved to state. */
async function jobFind() {
  if (findInProgress) { console.log('[find] Already running — skipping.'); return false; }
  findInProgress = true;
  const tag = '[find]';

  try {
    console.log(`${tag} Checking for new stream...`);

    const FIND_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max
    const url = await Promise.race([
      findLatestStreamUrl(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('findLatestStreamUrl timed out after 5min')), FIND_TIMEOUT_MS)
      ),
    ]);
    if (!url) {
      logIdle(`${tag} No matching video found (< ${config.maxAgeHours}h old, > ${config.minDurationMinutes}min). Next check at ${nextCronTime(config.findCron)}.`, 'no-match');
      return false;
    }

    // Compared by URL, not by date — the same video stays a candidate for
    // MAX_AGE_HOURS, which can cross midnight
    const state = readState();
    if (url === state.streamUrl) {
      logIdle(`${tag} Already tracked (${state.status}): ${url}`);
      return false;
    }

    // Don't clobber a running download — the new one is picked up on a later tick
    if (state.status === 'downloading') {
      logIdle(`${tag} New stream ${url} found, but ${state.streamUrl} is still downloading — will retry.`);
      return false;
    }

    writeState({
      streamUrl: url,
      foundAt: new Date().toISOString(),
      status: 'found',
      downloadedFile: null,
      audioFile: null,
      completedAt: null,
      error: null,
      valid: true,
    });

    logEvent(`${tag} Stream found: ${url}`);
    return true;
  } catch (err) {
    logError(`${tag} Find failed: ${err.message}`);
    return false;
  } finally {
    findInProgress = false;
  }
}

// ─── Job: download ────────────────────────────────────────────────────────────

async function jobDownload() {
  const tag = '[download]';

  const state = readState();

  if (!state.streamUrl) {
    logIdle(`${tag} No stream URL in state yet.`);
    return;
  }

  if (state.status === 'downloading') {
    console.log(`${tag} Download already in progress — skipping.`);
    return;
  }

  // ── Step 1: download (skip if already done and valid) ────────────────────
  let downloadedFile = state.downloadedFile;

  if (state.valid === false) {
    logEvent(`${tag} Marked invalid — looking for longest video on release day...`);
    const releaseDate = new Date(state.foundAt);
    const replacement = await findLongestVideoOnDate(releaseDate);
    const newUrl = replacement || state.streamUrl;
    if (replacement) logEvent(`${tag} Replacement found: ${newUrl}`);
    else logEvent(`${tag} No replacement found — re-downloading original: ${newUrl}`);
    writeState({ streamUrl: newUrl, status: 'found', downloadedFile: null, audioFile: null, completedAt: null, error: null, valid: true });
    downloadedFile = null;
  }

  // Set when the video is (re)downloaded in this tick — the audio copy must then
  // be regenerated even if a file with the same name already exists
  let justDownloaded = false;

  if (state.status !== 'done' || downloadedFile === null) {
    const streamStatus = await checkStreamStatus(state.streamUrl);

    if (streamStatus === 'live') {
      logIdle(`${tag} Stream still live. Next check at ${nextCronTime(config.downloadCron)}.`, 'live');
      return;
    }

    if (streamStatus === 'unknown') {
      logIdle(`${tag} Could not determine stream status. Next check at ${nextCronTime(config.downloadCron)}.`, 'unknown');
      return;
    }

    writeState({ status: 'downloading' });
    logEvent(`${tag} Starting download: ${state.streamUrl}`);

    try {
      downloadedFile = await downloadStream(state.streamUrl);
      writeState({ status: 'done', downloadedFile, completedAt: new Date().toISOString(), error: null, valid: true });
      logEvent(`${tag} Download complete: ${downloadedFile}`);
      justDownloaded = true;
    } catch (err) {
      logError(`${tag} Download failed: ${err.message}`);
      writeState({ status: 'failed', error: err.message });
      return;
    }
  } else {
    logIdle(`${tag} Already downloaded: ${downloadedFile}`);
  }

  // ── Step 2: NFO sidecar (skip if disabled or file already exists) ─────────
  if (config.generateNfo && downloadedFile) {
    await generateNfo(state.streamUrl, downloadedFile);
  }

  // ── Step 3: audio-only copy (skip if no audio dir mounted) ────────────────
  // A failure here doesn't touch the download status — retried on the next tick
  if (downloadedFile && isAudioEnabled()) {
    try {
      const audioFile = await extractAudio(downloadedFile, { overwrite: justDownloaded });
      if (audioFile !== state.audioFile || justDownloaded) {
        writeState({ audioFile });
        logEvent(`[audio] Audio ready: ${audioFile}`);
      }
    } catch (err) {
      logError(`[audio] Extraction failed: ${err.message}`);
    }
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

if (config.runNow) {
  console.log(`=== sw-downloader v${version} — RUN_NOW=true, running update + both jobs immediately ===`);
  jobUpdate().then(() => jobFind()).then(() => jobDownload()).catch(console.error);
} else {
  console.log(`=== sw-downloader v${version} started ===`);
  console.log(`Find cron    : ${config.findCron} (${config.timezone})`);
  console.log(`Retry cron   : ${config.findRetryCron ? `${config.findRetryCron} (${config.timezone})` : 'disabled'}`);
  console.log(`Download cron: ${config.downloadCron} (${config.timezone})`);
  console.log(`Update cron  : ${config.updateCron} (${config.timezone})`);
  console.log(`Channel      : @${config.channelHandle}`);
  console.log(`Output dir   : ${config.outputDir}`);
  console.log(`Audio dir    : ${isAudioEnabled()
    ? `${config.audioOutputDir} (${config.audioFormat})`
    : `disabled (${config.audioOutputDir || 'AUDIO_OUTPUT_DIR'} not mounted)`}`);
  console.log(`Max age      : ${config.maxAgeHours}h | Min duration: ${config.minDurationMinutes}min`);
  jobUpdate().catch(console.error);
}

// A freshly found stream is downloaded right away instead of waiting for the download tick
async function jobFindAndDownload() {
  if (await jobFind()) await jobDownload();
}

cron.schedule(config.findCron, jobFindAndDownload, { timezone: config.timezone });
if (config.findRetryCron) cron.schedule(config.findRetryCron, jobFindAndDownload, { timezone: config.timezone });
cron.schedule(config.downloadCron, jobDownload, { timezone: config.timezone });
cron.schedule(config.updateCron, jobUpdate, { timezone: config.timezone });
