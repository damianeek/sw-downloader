/**
 * File logger with idle-suppression.
 *
 * logEvent(msg)  — always writes to stdout + log file (resets idle streak)
 * logIdle(msg)   — always writes to stdout; only writes to log file on the
 *                  first call in a consecutive idle streak
 *
 * The log file lives next to the state file: <stateDir>/sw-downloader.log
 */

import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const logFile = path.join(config.stateDir, 'sw-downloader.log');

let lastWasIdle = false;

function ts() {
  return new Date().toLocaleString('en-US', {
    timeZone: config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function append(message) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${ts()}] ${message}\n`, 'utf8');
  } catch {
    // log file write failure is non-fatal
  }
}

export function logEvent(message) {
  console.log(message);
  append(message);
  lastWasIdle = false;
}

export function logIdle(message) {
  console.log(message);
  if (!lastWasIdle) {
    append(message);
    lastWasIdle = true;
  }
}

export function logError(message) {
  console.error(message);
  append(`ERROR: ${message}`);
  lastWasIdle = false;
}
