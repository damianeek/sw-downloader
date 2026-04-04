/**
 * Uses Playwright to find a recent stream on the configured channel.
 * Checks the Home, Videos, and Live tabs in order.
 * Only returns a video that is younger than MAX_AGE_HOURS (default 20h),
 * because the channel edits the VOD after 12-24h (cuts most of the stream).
 *
 * @returns {Promise<string|null>} YouTube video URL or null if not found
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const TABS = [
  { name: 'Home',    path: ''        },
  { name: 'Videos',  path: '/videos' },
  { name: 'Live',    path: '/streams' },
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

function isRecent(date) {
  if (!date) return false;
  const ageHours = (Date.now() - date.getTime()) / 3600000;
  return ageHours < config.maxAgeHours;
}

/**
 * Parses a YouTube duration string into total minutes.
 * Accepts "H:MM:SS" or "MM:SS" (as shown on thumbnail overlays).
 * Returns null if unparseable.
 */
function parseDurationMinutes(text) {
  if (!text) return null;
  const parts = text.trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60; // H:MM:SS
  if (parts.length === 2) return parts[0] + parts[1] / 60;                 // MM:SS
  return null;
}

function isLongEnough(minutes) {
  if (minutes === null) return true; // can't determine — don't discard
  return minutes >= config.minDurationMinutes;
}

/**
 * Scrapes one tab and returns all video candidates younger than maxAgeHours.
 * @returns {Promise<Array<{url: string, ageText: string, date: Date}>>}
 */
async function scrapeTab(page, tabPath, tabName) {
  const url = `https://www.youtube.com/@${config.channelHandle}${tabPath}?hl=en`;
  console.log(`[find] Checking ${tabName} tab: ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(1500);

  // Collect all video renderers visible on this tab
  const renderers = await page.locator(
    'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer'
  ).all();

  const results = [];

  for (const renderer of renderers) {
    // Get the video link
    const linkEl = renderer.locator('a#video-title-link, a#thumbnail').first();
    const href = await linkEl.getAttribute('href').catch(() => null);
    if (!href || !href.includes('/watch')) continue;

    const videoUrl = href.startsWith('http') ? href : `https://www.youtube.com${href}`;

    // Get all metadata spans — YouTube puts time like "2 hours ago" in there
    const spans = await renderer.locator('#metadata-line span, #metadata span').allTextContents();
    const ageText = spans.find((t) => /ago/i.test(t)) || '';

    const date = parseRelativeTime(ageText);
    if (!isRecent(date)) {
      if (ageText) console.log(`[find]   Skipping (too old: "${ageText}"): ${videoUrl}`);
      continue;
    }

    // Duration is shown on the thumbnail overlay, e.g. "3:42:15"
    const durationText = await renderer
      .locator('ytd-thumbnail-overlay-time-status-renderer span, .ytd-thumbnail-overlay-time-status-renderer')
      .first()
      .textContent()
      .catch(() => null);
    const durationMinutes = parseDurationMinutes(durationText?.trim());

    if (!isLongEnough(durationMinutes)) {
      console.log(`[find]   Skipping (too short: "${durationText?.trim()}", need >=${config.minDurationMinutes}min): ${videoUrl}`);
      continue;
    }

    const durationLabel = durationText?.trim() || 'duration unknown';
    console.log(`[find]   Found candidate (${ageText}, ${durationLabel}): ${videoUrl}`);
    results.push({ url: videoUrl, ageText, date, durationMinutes });
  }

  return results;
}

export async function findLatestStreamUrl() {
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const page = await context.newPage();

  try {
    // Accept cookie consent on first navigation
    await page.goto(`https://www.youtube.com/@${config.channelHandle}?hl=en`, {
      waitUntil: 'load',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    for (const label of ['Accept all', 'Reject all']) {
      const btn = page.locator(`button:has-text("${label}")`);
      if ((await btn.count()) > 0) {
        console.log(`[find] Accepting consent: "${label}"`);
        await btn.first().click();
        await page.waitForTimeout(2000);
        break;
      }
    }

    // Check all tabs, collect candidates
    const allCandidates = [];
    for (const tab of TABS) {
      try {
        const candidates = await scrapeTab(page, tab.path, tab.name);
        allCandidates.push(...candidates);
      } catch (err) {
        console.warn(`[find] Tab "${tab.name}" failed, skipping: ${err.message}`);
      }
    }

    if (allCandidates.length === 0) {
      const screenshotPath = path.join(config.outputDir, 'debug-screenshot.png');
      fs.mkdirSync(config.outputDir, { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`[find] No recent stream found (< ${config.maxAgeHours}h). Screenshot: ${screenshotPath}`);
      return null;
    }

    // Deduplicate by URL, pick the newest
    const seen = new Set();
    const unique = allCandidates.filter(({ url }) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });

    unique.sort((a, b) => b.date - a.date);
    const best = unique[0];
    console.log(`[find] Selected: ${best.url} (${best.ageText})`);
    return best.url;
  } finally {
    await browser.close();
  }
}

// Run directly: node src/findStream.js
if (process.argv[1].endsWith('findStream.js')) {
  findLatestStreamUrl()
    .then((url) => console.log(url ? `\nResult: ${url}` : '\nNo recent stream found.'))
    .catch(console.error);
}
