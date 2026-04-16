// User preferences for the `incipit` CLI.
//
// Currently this holds only the UI language. The file lives at
// `~/.incipit/config.json` and is the sole trigger for the first-run
// language picker: if the file is missing or does not contain a valid
// `language`, the interactive menu shows the picker once, saves the
// choice here, and never asks again.
//
// Write path is atomic (tmp + rename) so a crash mid-write cannot
// corrupt the config.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR  = path.join(os.homedir(), '.incipit');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const SUPPORTED_LANGUAGES = Object.freeze(['zh', 'en']);

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const text = fs.readFileSync(CONFIG_PATH, 'utf8');
    const data = text.trim() ? JSON.parse(text) : {};
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
    return data;
  } catch (_) {
    // Corrupt JSON is treated as "no config" rather than aborting the
    // CLI. Next successful write overwrites it.
    return {};
  }
}

function writeConfig(data) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = path.join(
    CONFIG_DIR,
    `.config.json.tmp-${process.pid}-${Date.now()}`,
  );
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (exc) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw exc;
  }
}

function getLanguage() {
  const cfg = readConfig();
  const lang = cfg.language;
  if (typeof lang === 'string' && SUPPORTED_LANGUAGES.includes(lang)) return lang;
  return null;
}

function setLanguage(lang) {
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    throw new Error(`Unsupported language: ${lang}`);
  }
  const cfg = readConfig();
  cfg.language = lang;
  writeConfig(cfg);
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  SUPPORTED_LANGUAGES,
  readConfig,
  writeConfig,
  getLanguage,
  setLanguage,
};
