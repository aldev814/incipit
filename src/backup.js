// backup / restore
//
// What gets backed up, and why the two categories are handled differently:
//
//   1. `extension.js` and `webview/index.js` live under Claude Code's
//      extension directory and we rewrite them wholesale. For these,
//      full-file snapshot + full-file restore is the correct operation.
//
//   2. `settings.json` is VS Code's global user settings — shared with
//      every other extension and every other user preference. We only
//      touch two keys (`chat.fontFamily` / `chat.fontSize`), so backing
//      up the whole file and blasting it back on restore would wipe any
//      unrelated settings the user changed between apply and restore.
//      Instead we snapshot only the PRE-apply state of the specific
//      keys we intend to write (including a tombstone if a key was
//      absent), and on restore we surgically roll back just those keys,
//      leaving everything else in the current settings.json untouched.
//
// Layout on disk:
//   ~/.incipit-backup/
//     <extension-version>/
//       <name>/                       user-supplied name, default "latest"
//         manifest.json
//         extension.js                (if it existed at backup time)
//         webview_index.js            (ditto)
//       _history-<timestamp>/         auto-renamed when a name collides
//
// `_history-` prefix (leading underscore) is reserved for the collision
// mover so it cannot clash with a user-supplied name.
//
// Atomicity: every write goes through `atomicWrite`, which writes to a
// temp file in the same directory and then renames. A crash mid-write
// leaves either the old file or the new file intact, never a torn one.
//
// Verification: full-file entries carry a sha256 captured at backup
// time. Restore recomputes the hash of the bytes it's about to write
// and aborts that entry (counting it as a skip) if the hashes disagree.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  vscodeUserSettingsPath,
  CHAT_FONT_SETTING_KEYS,
} = require('./install');

const BACKUP_ROOT = path.join(os.homedir(), '.incipit-backup');
const BACKUP_MANIFEST_NAME = 'manifest.json';
const HISTORY_PREFIX = '_history-';
const DEFAULT_BACKUP_NAME = 'latest';

// ------------------------------ helpers ------------------------------

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function timestampSlug() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Sanitize a user-supplied backup name. Accepts [A-Za-z0-9._-]; anything
// else collapses to `-`. Leading/trailing dashes and dots are trimmed,
// and the result is capped at 40 chars. Reserved `_history-` prefix is
// stripped so a user cannot forge an auto-history directory. Empty or
// unusable names fall back to DEFAULT_BACKUP_NAME.
function sanitizeBackupName(raw) {
  if (raw === undefined || raw === null) return DEFAULT_BACKUP_NAME;
  let s = String(raw).trim();
  if (!s) return DEFAULT_BACKUP_NAME;
  s = s.replace(/[^A-Za-z0-9._-]+/g, '-');
  s = s.replace(/^[-.]+|[-.]+$/g, '');
  if (!s) return DEFAULT_BACKUP_NAME;
  if (s.length > 40) s = s.slice(0, 40).replace(/[-.]+$/g, '');
  if (s.startsWith('_history-') || s === '_history') s = s.replace(/^_+/, '');
  if (!s) return DEFAULT_BACKUP_NAME;
  return s;
}

function atomicWrite(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, targetPath);
  } catch (exc) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw exc;
  }
}

function moveDirSync(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
    return;
  } catch (_) {
    // `rename` can fail across volumes or when a file is locked.
  }
  fs.cpSync(src, dst, { recursive: true });
  fs.rmSync(src, { recursive: true, force: true });
}

// --------------------------- manifest I/O ---------------------------

function writeManifest(backupDir, manifest) {
  const data = {
    version: 2,                         // schema version, not extension version
    created_at: manifest.createdAt,
    name: manifest.name,
    extension_version: manifest.extensionVersion,
    extension_dir: manifest.extensionDir,
    entries: manifest.entries.map(serializeEntry),
  };
  atomicWrite(
    path.join(backupDir, BACKUP_MANIFEST_NAME),
    JSON.stringify(data, null, 2),
  );
}

function serializeEntry(e) {
  if (e.type === 'file') {
    return {
      type: 'file',
      logical_name: e.logicalName,
      original_path: e.originalPath,
      backup_file: e.backupFile,       // basename, relative to backup dir
      existed_before: e.existedBefore,
      sha256: e.sha256,
    };
  }
  if (e.type === 'sparse_json') {
    return {
      type: 'sparse_json',
      logical_name: e.logicalName,
      original_path: e.originalPath,
      keys: e.keys.map(k => ({
        key: k.key,
        had_before: k.hadBefore,
        old_value: k.hadBefore ? k.oldValue : undefined,
      })),
    };
  }
  throw new Error(`Unknown backup entry type: ${e.type}`);
}

function readManifest(backupDir) {
  const p = path.join(backupDir, BACKUP_MANIFEST_NAME);
  if (!fs.existsSync(p)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
  const entries = (data.entries || [])
    .map(e => deserializeEntry(e, backupDir))
    .filter(Boolean);
  return {
    schemaVersion:    data.version || 1,
    createdAt:        data.created_at || '',
    name:             data.name || path.basename(backupDir),
    extensionVersion: data.extension_version || '',
    extensionDir:     data.extension_dir || '',
    entries,
  };
}

function deserializeEntry(e, backupDir) {
  if (!e || !e.type) {
    // v1 manifest: untyped entries were always whole-file. Migrate.
    if (e && e.logical_name && e.original_path) {
      return {
        type:          'file',
        logicalName:   e.logical_name,
        originalPath:  e.original_path,
        backupFile:    path.basename(e.backup_path || ''),
        backupPath:    e.backup_path || path.join(backupDir, path.basename(e.backup_path || '')),
        existedBefore: Boolean(e.existed_before),
        sha256:        e.sha256 || '',
      };
    }
    return null;
  }
  if (e.type === 'file') {
    return {
      type:          'file',
      logicalName:   e.logical_name,
      originalPath:  e.original_path,
      backupFile:    e.backup_file,
      backupPath:    path.join(backupDir, e.backup_file),
      existedBefore: Boolean(e.existed_before),
      sha256:        e.sha256 || '',
    };
  }
  if (e.type === 'sparse_json') {
    return {
      type:         'sparse_json',
      logicalName:  e.logical_name,
      originalPath: e.original_path,
      keys: (e.keys || []).map(k => ({
        key:       k.key,
        hadBefore: Boolean(k.had_before),
        oldValue:  k.had_before ? k.old_value : undefined,
      })),
    };
  }
  return null;
}

// --------------------------- backup creation ---------------------------

// Read the CURRENT state of the settings.json keys that apply is about
// to overwrite, so we can surgically roll them back later. If the file
// doesn't exist or fails to parse as JSON, every key is recorded as
// "didn't exist before".
function snapshotSparseJson(jsonPath, keys) {
  const entry = {
    type:         'sparse_json',
    logicalName:  'vscode_settings.json',
    originalPath: jsonPath,
    keys:         keys.map(k => ({ key: k, hadBefore: false, oldValue: undefined })),
  };
  if (!fs.existsSync(jsonPath)) return entry;
  let data;
  try {
    const text = fs.readFileSync(jsonPath, 'utf8');
    data = text.trim() ? JSON.parse(text) : {};
  } catch (_) {
    // JSONC or corrupted JSON — treat as "unknown", leave tombstones
    // in place. Restore will then simply delete our keys if present.
    return entry;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return entry;
  }
  for (const slot of entry.keys) {
    if (Object.prototype.hasOwnProperty.call(data, slot.key)) {
      slot.hadBefore = true;
      slot.oldValue  = data[slot.key];
    }
  }
  return entry;
}

function snapshotFile(logicalName, src, backupDir) {
  if (!fs.existsSync(src)) {
    return {
      type:          'file',
      logicalName,
      originalPath:  src,
      backupFile:    logicalName,
      backupPath:    path.join(backupDir, logicalName),
      existedBefore: false,
      sha256:        '',
    };
  }
  const buf = fs.readFileSync(src);
  const dst = path.join(backupDir, logicalName);
  atomicWrite(dst, buf);
  return {
    type:          'file',
    logicalName,
    originalPath:  src,
    backupFile:    logicalName,
    backupPath:    dst,
    existedBefore: true,
    sha256:        sha256Bytes(buf),
  };
}

function createBackup(target, opts = {}) {
  const name = sanitizeBackupName(opts.name);
  const versionDir = path.join(BACKUP_ROOT, String(target.version));
  const backupDir = path.join(versionDir, name);
  if (fs.existsSync(backupDir)) {
    const historyDir = path.join(versionDir, `${HISTORY_PREFIX}${timestampSlug()}`);
    moveDirSync(backupDir, historyDir);
  }
  fs.mkdirSync(backupDir, { recursive: true });

  const entries = [
    snapshotFile('extension.js',      target.extensionJsPath,     backupDir),
    snapshotFile('webview_index.js',  target.webviewIndexJsPath,  backupDir),
    snapshotSparseJson(vscodeUserSettingsPath(), Array.from(CHAT_FONT_SETTING_KEYS)),
  ];

  const manifest = {
    createdAt:        new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    name,
    extensionVersion: target.version,
    extensionDir:     target.extensionDir,
    entries,
  };
  writeManifest(backupDir, manifest);
  return manifest;
}

function currentBackupDir(target, name = DEFAULT_BACKUP_NAME) {
  return path.join(BACKUP_ROOT, String(target.version), sanitizeBackupName(name));
}

// --------------------------- backup listing ---------------------------

function listAvailableBackups() {
  const results = [];
  if (!fs.existsSync(BACKUP_ROOT)) return results;
  const versionDirs = fs.readdirSync(BACKUP_ROOT).filter(n => {
    try { return fs.statSync(path.join(BACKUP_ROOT, n)).isDirectory(); }
    catch (_) { return false; }
  });
  for (const vd of versionDirs) {
    const vPath = path.join(BACKUP_ROOT, vd);
    const subDirs = fs.readdirSync(vPath).filter(n => {
      try { return fs.statSync(path.join(vPath, n)).isDirectory(); }
      catch (_) { return false; }
    });
    for (const sd of subDirs) {
      const bd = path.join(vPath, sd);
      const m = readManifest(bd);
      if (!m) continue;
      results.push({
        label:     `v${m.extensionVersion} / ${sd}  (${m.createdAt})`,
        backupDir: bd,
        manifest:  m,
        sortKey:   m.createdAt || '',
      });
    }
  }
  // Newest first, chronologically. createdAt is an ISO string so plain
  // string comparison sorts correctly.
  results.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return results;
}

// --------------------------- restore ---------------------------

function restoreBackup(manifest) {
  let restored = 0;
  let skipped = 0;
  for (const e of manifest.entries) {
    try {
      if (e.type === 'file') {
        if (restoreFileEntry(e)) restored++;
        else skipped++;
      } else if (e.type === 'sparse_json') {
        if (restoreSparseJsonEntry(e)) restored++;
        else skipped++;
      } else {
        skipped++;
      }
    } catch (_) {
      skipped++;
    }
  }
  return [restored, skipped];
}

function restoreFileEntry(e) {
  if (e.existedBefore) {
    if (!fs.existsSync(e.backupPath)) return false;
    const buf = fs.readFileSync(e.backupPath);
    // sha256 gate: refuse to write corrupted backup bytes back to disk.
    if (e.sha256 && sha256Bytes(buf) !== e.sha256) return false;
    fs.mkdirSync(path.dirname(e.originalPath), { recursive: true });
    atomicWrite(e.originalPath, buf);
    return true;
  }
  // The file did not exist at backup time. If it exists now, delete it
  // so the extension dir matches the pre-apply state. This only fires
  // for the two patched JS files — settings.json is always a
  // sparse_json entry and never takes this path.
  if (fs.existsSync(e.originalPath)) {
    try {
      fs.unlinkSync(e.originalPath);
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

function restoreSparseJsonEntry(e) {
  // Read the CURRENT settings.json. We deliberately do not touch the
  // file we snapshotted — we roll back against the user's latest state.
  let current = {};
  let fileExists = fs.existsSync(e.originalPath);
  if (fileExists) {
    try {
      const text = fs.readFileSync(e.originalPath, 'utf8');
      current = text.trim() ? JSON.parse(text) : {};
    } catch (_) {
      // JSONC or corrupted — don't touch it. User's file, user's problem.
      return false;
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return false;
    }
  }

  let mutated = false;
  for (const slot of e.keys) {
    if (slot.hadBefore) {
      // Key existed before apply: put the old value back.
      if (current[slot.key] !== slot.oldValue) {
        current[slot.key] = slot.oldValue;
        mutated = true;
      }
    } else {
      // Key did not exist before apply: remove it.
      if (Object.prototype.hasOwnProperty.call(current, slot.key)) {
        delete current[slot.key];
        mutated = true;
      }
    }
  }

  if (!mutated) return false;
  // If the file didn't exist and rollback would only remove keys (which
  // are absent anyway), the `mutated` flag would already be false and
  // we'd have returned. So if we reach here and the file doesn't exist,
  // the user must have legitimate content in it — write the rolled-back
  // object back.
  fs.mkdirSync(path.dirname(e.originalPath), { recursive: true });
  atomicWrite(e.originalPath, JSON.stringify(current, null, 4) + '\n');
  return true;
}

module.exports = {
  BACKUP_ROOT,
  DEFAULT_BACKUP_NAME,
  sanitizeBackupName,
  currentBackupDir,
  createBackup,
  listAvailableBackups,
  restoreBackup,
};
