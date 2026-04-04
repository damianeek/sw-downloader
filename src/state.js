/**
 * Persistent state — survives between cron runs.
 * Stored as a JSON file at config.stateFile.
 *
 * Shape:
 * {
 *   streamUrl: string|null,
 *   foundAt: string|null,    // ISO datetime
 *   status: 'idle'|'found'|'downloading'|'done'|'failed',
 *   downloadedFile: string|null,
 *   completedAt: string|null,
 *   error: string|null
 * }
 */

import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const DEFAULT_STATE = {
  streamUrl: null,
  foundAt: null,
  status: 'idle',
  downloadedFile: null,
  completedAt: null,
  error: null,
};

export function readState() {
  try {
    const raw = fs.readFileSync(config.stateFile, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeState(patch) {
  const current = readState();
  const next = { ...current, ...patch };
  const dir = path.dirname(config.stateFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.stateFile, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Returns true if this exact URL was already successfully downloaded. */
export function isAlreadyDone(url) {
  const state = readState();
  return state.streamUrl === url && state.status === 'done';
}
