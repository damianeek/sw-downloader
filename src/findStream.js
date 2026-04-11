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
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

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

  for (const renderer of renderers) {
    const linkEl = renderer.locator('a#video-title-link, a#thumbnail').first();
    const href = await linkEl.getAttribute('href').catch(() => null);
    if (!href || !href.includes('/watch')) continue;

    const videoUrl = href.startsWith('http') ? href : `https://www.youtube.com${href}`;

    const spans = await renderer.locator('#metadata-line span, #metadata span').allTextContents();
    const ageText = spans.find((t) => /ago/i.test(t)) || '';
    const date = parseRelativeTime(ageText);

    if (!isRecent(date)) {
      if (ageText) console.log(`[find]   Skipping (too old: "${ageText}"): ${videoUrl}`);
      continue;
    }

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
    // First navigation — handle cookie consent
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

    // Scrape all tabs, collect candidates
    const allCandidates = [];
    for (const tab of TABS) {
      try {
        const candidates = await scrapeTab(page, tab);
        allCandidates.push(...candidates);
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

// Run directly: node src/findStream.js
if (process.argv[1].endsWith('findStream.js')) {
  findLatestStreamUrl()
    .then((url) => console.log(url ? `\nResult: ${url}` : '\nNo recent stream found.'))
    .catch(console.error);
}
