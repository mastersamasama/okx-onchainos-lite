// upstream: cli/src/watch/store.rs — on-disk layout under <home>/watch/<id>/:
// config.json (pretty WatchConfig), pid, status ("state|ms[|reason]"), cursor.<channel>
// ("file_no|offset"), events.<channel>.<0..2>.jsonl, daemon.log. Same names, same bytes.
import {
  existsSync, mkdirSync, writeFileSync, renameSync, readFileSync, statSync, openSync, closeSync,
  readSync, appendFileSync, unlinkSync, readdirSync, rmSync, lstatSync,
} from 'node:fs';
import { home } from '../core/home.mjs';
import { stringify } from '../core/json.mjs';
import { DaemonState, watchConfigFromStr, valueFromStr } from './types.mjs';
import { pathJoin, io, ioError, decodeUtf8, splitn, trim, parseUnsigned, cmpBytes } from './_rs.mjs';

const MAX_FILE_SIZE = 32 * 1024 * 1024; // 32 MB
const MAX_FILES = 3;

// upstream: store.rs::watch_root
export const watchRoot = () => pathJoin(home(), 'watch');
// upstream: store.rs::watch_dir
export const watchDir = (id) => pathJoin(watchRoot(), id);

const eventsPath = (dir, channel, fileNo) => pathJoin(dir, `events.${channel}.${fileNo}.jsonl`);
const cursorPath = (dir, channel) => pathJoin(dir, `cursor.${channel}`);
const statusPath = (dir) => pathJoin(dir, 'status');
const pidPath = (dir) => pathJoin(dir, 'pid');
const configPath = (dir) => pathJoin(dir, 'config.json');

// fs::read_to_string
const readToString = (p) => decodeUtf8(io(() => readFileSync(p)));
// fs::write then fs::rename (tmp + rename)
function writeAtomic(dir, tmpName, finalPath, text) {
  const tmp = pathJoin(dir, tmpName);
  io(() => writeFileSync(tmp, text));
  io(() => renameSync(tmp, finalPath));
}

// upstream: store.rs::init_watch_dir
export function initWatchDir(id, config) {
  const dir = watchDir(id);
  io(() => mkdirSync(dir, { recursive: true }));
  writeAtomic(dir, '.config.json.tmp', configPath(dir), stringify(config, true));
  return dir;
}

// upstream: store.rs::write_pid
export function writePid(dir, pid) {
  io(() => writeFileSync(pidPath(dir), String(pid)));
}

// upstream: store.rs::read_pid → u32 (throws on io / parse errors)
export function readPid(id) {
  const s = readToString(pidPath(watchDir(id)));
  const v = parseUnsigned(trim(s), 'u32');
  if (v === undefined) throw new Error(trim(s) === '' ? 'cannot parse integer from empty string' : /^\+?\d+$/.test(trim(s)) ? 'number too large to fit in target type' : 'invalid digit found in string');
  return v;
}

// upstream: store.rs::write_status
export function writeStatus(dir, state, reason) {
  const now = nowMs();
  const line = reason === undefined || reason === null ? `${state}|${now}` : `${state}|${now}|${reason}`;
  writeAtomic(dir, '.status.tmp', statusPath(dir), line);
}

// upstream: store.rs::read_daemon_state
export function readDaemonState(id) {
  const file = statusPath(watchDir(id));
  if (!existsSync(file)) return DaemonState.Crashed;
  return DaemonState.fromStatusLine(readToString(file), nowMs());
}

// upstream: store.rs::read_config
export function readConfig(id) {
  return watchConfigFromStr(readToString(configPath(watchDir(id))));
}

// upstream: store.rs::Cursor
export const cursor = (fileNo, offset) => ({ fileNo, offset });

// upstream: store.rs::read_cursor — missing/unreadable/malformed → {0,0}
export function readCursor(dir, channel) {
  let s;
  try { s = decodeUtf8(readFileSync(cursorPath(dir, channel))); } catch { return cursor(0, 0); }
  const parts = splitn(trim(s), 2, '|');
  if (parts.length !== 2) return cursor(0, 0);
  const fileNo = parseUnsigned(parts[0], 'u32') ?? 0;
  const offset = parseUnsigned(parts[1], 'u64') ?? 0;
  return cursor(Number(fileNo), Number(offset));
}

// upstream: store.rs::write_cursor
export function writeCursor(dir, channel, fileNo, offset) {
  writeAtomic(dir, `.cursor.${channel}.tmp`, cursorPath(dir, channel), `${fileNo}|${offset}`);
}

// upstream: store.rs::append_events — one compact serde_json line per event.
export function appendEvents(dir, channel, events) {
  if (!events.length) return;
  const current = eventsPath(dir, channel, 0);
  if (existsSync(current)) {
    const meta = io(() => statSync(current));
    if (meta.size >= MAX_FILE_SIZE) rotateFiles(dir, channel);
  }
  const text = events.map((e) => stringify(e) + '\n').join('');
  io(() => appendFileSync(eventsPath(dir, channel, 0), text));
}

// upstream: store.rs::rotate_files
function rotateFiles(dir, channel) {
  const oldest = eventsPath(dir, channel, MAX_FILES - 1);
  if (existsSync(oldest)) io(() => unlinkSync(oldest));
  for (let n = MAX_FILES - 2; n >= 0; n--) {
    const src = eventsPath(dir, channel, n);
    if (existsSync(src)) io(() => renameSync(src, eventsPath(dir, channel, n + 1)));
  }
}

// upstream: store.rs::read_events_from_cursor → { events, perEventCursors, newCursor }
export function readEventsFromCursor(dir, channel, limit) {
  let cur = readCursor(dir, channel);
  const events = [];
  let perEventCursors = [];
  let path = eventsPath(dir, channel, cur.fileNo);
  const rotated = !existsSync(path) || io(() => statSync(path)).size < cur.offset;
  if (rotated) {
    // `cursor.file_no + 1` is u32 arithmetic: it wraps (release build, no overflow checks).
    const rotatedPath = eventsPath(dir, channel, (cur.fileNo + 1) >>> 0);
    if (existsSync(rotatedPath)) drainFile(rotatedPath, cur.offset, limit, events, null);
    cur = cursor(cur.fileNo, 0);
  }
  path = eventsPath(dir, channel, cur.fileNo);
  if (existsSync(path)) {
    const remaining = Math.max(0, limit - events.length);
    const newOffset = drainFile(path, cur.offset, remaining, events, perEventCursors);
    const rotatedCount = events.length - perEventCursors.length;
    if (rotatedCount > 0) perEventCursors = [...Array(rotatedCount)].map(() => cursor(cur.fileNo, 0)).concat(perEventCursors);
    cur = cursor(cur.fileNo, newOffset);
  }
  return { events, perEventCursors, newCursor: cur };
}

// upstream: store.rs::drain_file — BufReader::read_line loop from `offset`; a trailing
// line without '\n' is left unread; blank / invalid JSON lines are consumed and skipped.
// Note `limit` is compared against the whole `events` vector (rotated tail included).
function drainFile(path, offset, limit, events, perEventCursors) {
  const fileNo = parseFileNoFromPath(path);
  const buf = readFrom(path, offset);
  let pos = 0;
  let current = offset;
  while (events.length < limit) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) {                                        // EOF or incomplete line
      // read_line still read (and UTF-8 validated) the incomplete tail: invalid → io error.
      if (pos < buf.length) decodeUtf8(buf.subarray(pos));
      break;
    }
    const lineBuf = buf.subarray(pos, nl + 1);
    const line = decodeUtf8(lineBuf);                   // read_line: invalid UTF-8 → io error
    pos = nl + 1;
    current += lineBuf.length;
    const t = trim(line);
    if (!t) continue;
    let event;
    try { event = valueFromStr(t); } catch { continue; }
    events.push(event);
    if (perEventCursors) perEventCursors.push(cursor(fileNo, current));
  }
  return current;
}

function readFrom(path, offset) {
  const fd = io(() => openSync(path, 'r'));
  try {
    const size = io(() => statSync(path)).size;
    if (offset >= size) return Buffer.alloc(0);
    const out = Buffer.alloc(size - offset);
    let got = 0;
    while (got < out.length) {
      const n = readSync(fd, out, got, out.length - got, offset + got);
      if (n <= 0) break;
      got += n;
    }
    return out.subarray(0, got);
  } finally { closeSync(fd); }
}

// upstream: store.rs::parse_file_no_from_path — file stem's last '.'-segment as u32, else 0.
function parseFileNoFromPath(path) {
  const name = path.split(process.platform === 'win32' ? /[\\/]/ : '/').pop();
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const v = parseUnsigned(stem.split('.').pop(), 'u32');
  return v === undefined ? 0 : Number(v);
}

// upstream: store.rs::WatchEntry / list_watches — entries named ws_* / watch_*, sorted by id.
export function listWatches() {
  const root = watchRoot();
  if (!existsSync(root)) return [];
  const entries = [];
  for (const id of io(() => readdirSync(root))) {
    if (!id.startsWith('ws_') && !id.startsWith('watch_')) continue;
    let state;
    try { state = readDaemonState(id); } catch { state = DaemonState.Crashed; }
    let pid = null;
    try { pid = readPid(id); } catch {}
    let config = null;
    try { config = readConfig(id); } catch {}
    entries.push({ id, state, pid, config });
  }
  entries.sort((a, b) => cmpBytes(a.id, b.id));
  return entries;
}

// upstream: store.rs::remove_watch_dir
// fs::remove_dir_all refuses a root that is not a directory (Windows: ERROR_DIRECTORY 267,
// unix: ENOTDIR) — e.g. a plain file named ws_* under watch/.
export function removeWatchDir(id) {
  const dir = watchDir(id);
  if (!existsSync(dir)) return;
  const st = io(() => lstatSync(dir));
  if (!st.isDirectory() && !st.isSymbolicLink()) throw ioError({ code: 'ENOTDIR', path: dir });
  io(() => rmSync(dir, { recursive: true }));
}

// upstream: store.rs::now_ms
export const nowMs = () => Date.now();

// upstream: store.rs::last_poll_time — newest mtime (ms) of cursor.* files, or null.
export function lastPollTime(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  let latest = null;
  for (const name of names) {
    if (!name.startsWith('cursor.')) continue;
    let mtimeMs;
    try { mtimeMs = statSync(pathJoin(dir, name)).mtimeMs; } catch { continue; }
    if (mtimeMs < 0) return null;                        // duration_since(UNIX_EPOCH).ok()? → None
    const ms = Math.floor(mtimeMs);
    latest = latest === null ? ms : Math.max(latest, ms);
  }
  return latest;
}
