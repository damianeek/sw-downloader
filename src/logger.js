/**
 * File logger with idle-suppression.
 *
 * logEvent(msg)       — always writes to stdout + log file (resets the tag's idle streak)
 * logIdle(msg, key)   — always writes to stdout; writes to log file only when the
 *                       key differs from the previous idle message with the same
 *                       tag ("[find]", "[download]", …). key defaults to msg — pass
 *                       a stable one when msg contains changing parts (timestamps)
 *
 * The log file lives next to the state file: <stateDir>/sw-downloader.log
 */

import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const logFile = path.join(config.stateDir, 'sw-downloader.log');

// tag → key of the last idle message written to the log file. Tracked per tag
// so interleaved jobs don't hide each other's messages
const lastIdleKey = new Map();

function tagOf(message) {
  return message.match(/^\[[^\]]+\]/)?.[0] ?? '';
}

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
  lastIdleKey.delete(tagOf(message));
}

export function logIdle(message, key = message) {
  console.log(message);
  const tag = tagOf(message);
  if (lastIdleKey.get(tag) !== key) {
    append(message);
    lastIdleKey.set(tag, key);
  }
}

export function logError(message) {
  console.error(message);
  append(`ERROR: ${message}`);
  lastIdleKey.delete(tagOf(message));
}
