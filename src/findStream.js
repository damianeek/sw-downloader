/**
 * Uses Playwright to find a recent stream on the configured channel.
 * Checks the Home, Videos, and Live tabs in order.
 * Only returns a video younger than MAX_AGE_HOURS and longer than MIN_DURATION_MINUTES.
 *
 * A debug screenshot is saved to stateDir after each tab is scraped.
 *
 * @returns {Promise<string|null>} YouTube video URL or null if not found
 */

import { chromium } from 'playwright';
import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

async function getVideoInfo(videoUrl) {
  try {
    const args = [videoUrl, '--dump-json', '--no-playlist', '--no-warnings'];
    if (config.ffmpegLocation) args.push('--ffmpeg-location', config.ffmpegLocation);
    const { stdout } = await execa(config.ytdlpBin, args);
    const info = JSON.parse(stdout);
    const d = info.upload_date; // YYYYMMDD
    const uploadDate = d?.length === 8
      ? new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`)
      : null;
    return { uploadDate, durationMinutes: info.duration ? info.duration / 60 : null };
  } catch {
    return null;
  }
}

const TABS = [
  { name: 'home',   path: ''         },
  { name: 'videos', path: '/videos'  },
  { name: 'live',   path: '/streams' },
];

/**
 * Parses YouTube relative time strings into a Date.
 * Examples: "2 hours ago", "Streamed 5 hours ago", "1 day ago"
 */
function parseRelativeTime(text) {
  if (!text) return null;

  const match = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit  = match[2].toLowerCase();

  let ms;
  if      (unit.startsWith('sec'))   ms = value * 1000;
  else if (unit.startsWith('min'))   ms = value * 60_000;
  else if (unit.startsWith('hour'))  ms = value * 3_600_000;
  else if (unit.startsWith('day'))   ms = value * 86_400_000;
  else if (unit.startsWith('week'))  ms = value * 7 * 86_400_000;
  else if (unit.startsWith('month')) ms = value * 30 * 86_400_000;
  else if (unit.startsWith('year'))  ms = value * 365 * 86_400_000;
  else return null;

  return new Date(Date.now() - ms);
}


function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function isRecent(date) {
  if (!date) return false;
  return (Date.now() - date.getTime()) / 3_600_000 < config.maxAgeHours;
}

/**
 * Parses "H:MM:SS" or "MM:SS" into total minutes. Returns null if unparseable.
 */
function parseDurationMinutes(text) {
  if (!text) return null;
  const parts = text.trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
  if (parts.length === 2) return parts[0] + parts[1] / 60;
  return null;
}

function isLongEnough(minutes) {
  if (minutes === null) return true; // unknown duration — don't discard
  return minutes >= config.minDurationMinutes;
}

/**
 * Scrapes one tab, saves a debug screenshot, and returns video candidates.
 * @returns {Promise<Array<{url: string, ageText: string, date: Date, durationMinutes: number|null}>>}
 */
async function scrapeTab(page, tab) {
  const url = `https://www.youtube.com/@${config.channelHandle}${tab.path}?hl=en`;
  console.log(`[find] Checking ${tab.name} tab: ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(1500);

  // Save per-tab screenshot to stateDir for debugging
  fs.mkdirSync(config.stateDir, { recursive: true });
  const screenshotPath = path.join(config.stateDir, `debug-${tab.name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`[find] Screenshot: ${screenshotPath}`);

  const renderers = await page.locator(
    'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer'
  ).all();

  const results = [];
  let analyzed = 0;

  for (const renderer of renderers) {
    if (analyzed >= 6) {
      console.log(`[find]   Reached limit of 6 episodes analyzed for ${tab.name} tab.`);
      break;
    }

    const linkEl = renderer.locator('a#video-title-link, a#thumbnail').first();
    const href = await linkEl.getAttribute('href').catch(() => null);
    if (!href || !href.includes('/watch')) continue;
    
    analyzed++;

    const videoUrl = href.startsWith('http') ? href : `https://www.youtube.com${href}`;

    // Skip videos from other channels (home tab shows recommendations)
    const channelHref = await renderer
      .locator('a.yt-formatted-string[href], #channel-name a')
      .first()
      .getAttribute('href')
      .catch(() => null);
    if (channelHref && !channelHref.toLowerCase().includes(config.channelHandle.toLowerCase())) {
      console.log(`[find]   Skipping (different channel: "${channelHref}"): ${videoUrl}`);
      continue;
    }

    // Check thumbnail overlay — could be a duration ("3:42:15") or "LIVE"
    const overlayText = await renderer
      .locator('ytd-thumbnail-overlay-time-status-renderer span, .ytd-thumbnail-overlay-time-status-renderer')
      .first()
      .textContent()
      .catch(() => null);
    const overlayLabel = overlayText?.trim() || '';

    // Get all metadata text for debugging
    const spans = await renderer.locator('#metadata-line span, #metadata span').allTextContents();
    const allMeta = spans.map(s => s.trim()).filter(Boolean).join(' | ');

    const isLive = /^live$/i.test(overlayLabel) || /^premiere/i.test(overlayLabel) || /watching|waiting/i.test(allMeta);
    const ageText = spans.find((t) => /ago/i.test(t)) || '';

    if (isLive) {
      const viewCountMatch = allMeta.match(/([\d.,KMB]+\s+(?:watching|waiting))/i);
      const viewCountText = viewCountMatch ? viewCountMatch[1] : 'unknown viewers';
      // Live streams have no duration or reliable age — always include them
      console.log(`[find]   Found LIVE/PREMIERE stream (${viewCountText}, meta: "${allMeta}"): ${videoUrl}`);
      results.push({ url: videoUrl, ageText: 'LIVE', date: new Date(), durationMinutes: null });
      break; // Stop looking for episodes once it finds the live one
    }

    const date = parseRelativeTime(ageText);
    if (!isRecent(date)) {
      console.log(`[find]   Skipping (age: "${ageText || 'none'}", meta: "${allMeta}"): ${videoUrl}`);
      continue;
    }

    const durationMinutes = parseDurationMinutes(overlayLabel);
    if (!isLongEnough(durationMinutes)) {
      console.log(`[find]   Skipping (too short: "${overlayLabel}", need >=${config.minDurationMinutes}min): ${videoUrl}`);
      continue;
    }

    const durationLabel = overlayLabel || 'duration unknown';
    console.log(`[find]   Found candidate (${ageText}, ${durationLabel}): ${videoUrl}`);
    results.push({ url: videoUrl, ageText, date, durationMinutes });
  }

  return results;
}

async function launchPage() {
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const page = await context.newPage();
  return { browser, page };
}

async function acceptConsent(page) {
  for (const label of ['Accept all', 'Reject all']) {
    const btn = page.locator(`button:has-text("${label}")`);
    if ((await btn.count()) > 0) {
      console.log(`[find] Accepting consent: "${label}"`);
      await btn.first().click();
      await page.waitForTimeout(2000);
      break;
    }
  }
}

export async function findLatestStreamUrl() {
  const { browser, page } = await launchPage();

  try {
    // First navigation — handle cookie consent
    await page.goto(`https://www.youtube.com/@${config.channelHandle}?hl=en`, {
      waitUntil: 'load',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    await acceptConsent(page);

    // Scrape all tabs, collect candidates
    const allCandidates = [];
    for (const tab of TABS) {
      try {
        const candidates = await scrapeTab(page, tab);
        allCandidates.push(...candidates);
        if (candidates.some(c => c.ageText === 'LIVE')) {
          console.log('[find] Live stream found — skipping remaining tabs.');
          break;
        }
      } catch (err) {
        console.warn(`[find] Tab "${tab.name}" failed, skipping: ${err.message}`);
      }
    }

    if (allCandidates.length === 0) {
      console.log(`[find] No recent stream found (< ${config.maxAgeHours}h, > ${config.minDurationMinutes}min).`);
      return null;
    }

    // Deduplicate by URL, pick the newest
    const seen = new Set();
    const unique = allCandidates
      .filter(({ url }) => seen.has(url) ? false : seen.add(url))
      .sort((a, b) => b.date - a.date);

    const best = unique[0];
    console.log(`[find] Selected: ${best.url} (${best.ageText})`);
    return best.url;
  } finally {
    await browser.close();
  }
}

/**
 * Finds the longest video uploaded on a specific date from the Videos tab.
 * Used when a download is marked invalid and the stream may have been edited.
 *
 * @param {Date} targetDate
 * @returns {Promise<string|null>} YouTube video URL or null
 */
export async function findLongestVideoOnDate(targetDate) {
  const tag = '[find-invalid]';
  console.log(`${tag} Looking for longest video on ${targetDate.toDateString()} in Videos tab...`);

  const { browser, page } = await launchPage();
  let browserClosed = false;

  try {
    await page.goto(`https://www.youtube.com/@${config.channelHandle}?hl=en`, {
      waitUntil: 'load',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    await acceptConsent(page);

    // Collect all video URLs + durations from the Videos tab
    const videosUrl = `https://www.youtube.com/@${config.channelHandle}/videos?hl=en`;
    await page.goto(videosUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(1500);

    const renderers = await page.locator(
      'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer'
    ).all();

    const candidates = [];
    let analyzed = 0;
    for (const renderer of renderers) {
      if (analyzed >= 6) {
        console.log(`${tag}   Reached limit of 6 episodes analyzed.`);
        break;
      }
      const linkEl = renderer.locator('a#video-title-link, a#thumbnail').first();
      const href = await linkEl.getAttribute('href').catch(() => null);
      if (!href || !href.includes('/watch')) continue;
      
      analyzed++;
      const videoUrl = href.startsWith('http') ? href : `https://www.youtube.com${href}`;
      const overlayText = await renderer
        .locator('ytd-thumbnail-overlay-time-status-renderer span, .ytd-thumbnail-overlay-time-status-renderer')
        .first().textContent().catch(() => null);
      candidates.push({ url: videoUrl, durationMinutes: parseDurationMinutes(overlayText?.trim()) });
    }

    browserClosed = true;
    await browser.close();

    // Use yt-dlp to get exact upload date and duration for each candidate
    let best = null;
    for (const candidate of candidates) {
      const info = await getVideoInfo(candidate.url);
      if (!info?.uploadDate) { console.log(`${tag}   Could not fetch info: ${candidate.url}`); continue; }

      if (!isSameDay(info.uploadDate, targetDate)) {
        console.log(`${tag}   Skipping (${info.uploadDate.toDateString()}): ${candidate.url}`);
        continue;
      }

      const mins = info.durationMinutes ?? candidate.durationMinutes;
      console.log(`${tag}   Candidate (${info.uploadDate.toDateString()}, ${mins?.toFixed(0) ?? '?'} min): ${candidate.url}`);
      if (!best || (mins !== null && (best.mins === null || mins > best.mins))) {
        best = { url: candidate.url, mins };
      }
    }

    if (!best) {
      console.log(`${tag} No video found on ${targetDate.toDateString()}.`);
      return null;
    }

    console.log(`${tag} Selected longest: ${best.url} (${best.mins?.toFixed(0) ?? '?'} min)`);
    return best.url;
  } finally {
    if (!browserClosed) await browser.close();
  }
}

// Run directly: node src/findStream.js
if (process.argv[1]?.endsWith('findStream.js')) {
  findLatestStreamUrl()
    .then((url) => console.log(url ? `\nResult: ${url}` : '\nNo recent stream found.'))
    .catch(console.error);
}
