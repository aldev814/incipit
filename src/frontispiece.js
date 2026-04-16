'use strict';

const os = require('os');

const Ansi = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  ITALIC: '\x1b[3m',
  TERRA: '\x1b[38;2;217;119;87m',
  IVORY: '\x1b[38;2;248;248;246m',
  GREY: '\x1b[38;2;152;152;152m',
  RED: '\x1b[31m',
  GREEN: '\x1b[32m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m',
};

const LAYOUT = Object.freeze({
  TERM_MIN: 60,
  TERM_MAX: 100,
  INNER_WIDTH: 68,
  FRAME_MARGIN: 4,
  INDENT: 6,
  LABEL_COL: 12,
  TOP_BLANKS: 3,
  TITLE_GAP_AFTER: 4,
  LEDGER_GAP_AFTER: 4,
  MENU_GAP_BEFORE_RULE: 2,
  RULE_GAP_BEFORE_PROMPT: 1,
  PROMPT_MARK: '› ',
  MENU_MARK_COL: 5,
});

const TITLE = 'I  ·  N  ·  C  ·  I  ·  P  ·  I  ·  T';
const TAGLINES = Object.freeze([
  'a quiet typesetting patch',
  'for long-form reading',
]);

function color(text, code) {
  return `${code}${text}${Ansi.RESET}`;
}

function clearScreen() {
  process.stdout.write(process.platform === 'win32' ? '\x1Bc' : '\x1B[2J\x1B[H');
}

function termWidth() {
  const width = process.stdout.columns || 96;
  return Math.min(Math.max(width, LAYOUT.TERM_MIN), LAYOUT.TERM_MAX);
}

function frameGeometry() {
  const outer = termWidth();
  const inner = Math.min(outer - LAYOUT.FRAME_MARGIN, LAYOUT.INNER_WIDTH);
  const padLen = Math.max(0, Math.floor((outer - inner) / 2));
  return {
    inner,
    framePad: ' '.repeat(padLen),
    indent: ' '.repeat(LAYOUT.INDENT),
  };
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function centerLine(text, width) {
  const len = stripAnsi(text).length;
  if (len >= width) return text;
  return ' '.repeat(Math.floor((width - len) / 2)) + text;
}

function shortenPath(value) {
  const home = os.homedir();
  const normalized = value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  return normalized.replace(/\\/g, '/');
}

function wrapWidth(value, max) {
  if (max <= 0 || value.length <= max) return [value];
  const lines = [];
  for (let i = 0; i < value.length; i += max) lines.push(value.slice(i, i + max));
  return lines;
}

function wrapPathValue(value, max) {
  if (max <= 0 || value.length <= max) return [value];
  const lines = [];
  let remaining = value;
  while (remaining.length > max) {
    const candidate = remaining.slice(0, max);
    const cut = selectPathBreak(candidate, max);
    lines.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function selectPathBreak(candidate, max) {
  const slash = candidate.lastIndexOf('/') + 1;
  if (slash > 0) return slash;
  const hyphen = candidate.lastIndexOf('-') + 1;
  if (hyphen > 0) return hyphen;
  return max;
}

function wrapLedgerValue(value, max) {
  return value.includes('/') ? wrapPathValue(value, max) : wrapWidth(value, max);
}

function createPrinter(framePad) {
  return {
    line(text) {
      console.log(framePad + text);
    },
    blank() {
      console.log();
    },
  };
}

function renderTitle(printer, inner) {
  const centered = text => centerLine(text, inner);
  printer.line(centered(color(TITLE, `${Ansi.TERRA}${Ansi.BOLD}`)));
  printer.blank();
  for (const tagline of TAGLINES) {
    printer.line(centered(color(tagline, `${Ansi.GREY}${Ansi.ITALIC}`)));
  }
}

function renderLedger(printer, indent, inner, target, missingText, backupRoot) {
  const valueMax = Math.max(10, inner - indent.length - LAYOUT.LABEL_COL);
  const continuation = indent + ' '.repeat(LAYOUT.LABEL_COL);
  const emitRow = (label, value) => {
    const chunks = wrapLedgerValue(value, valueMax);
    printer.line(
      indent +
      color(label.padEnd(LAYOUT.LABEL_COL), Ansi.GREY) +
      color(chunks[0], Ansi.IVORY),
    );
    for (const chunk of chunks.slice(1)) {
      printer.line(continuation + color(chunk, Ansi.IVORY));
    }
  };

  if (target) {
    emitRow('Target', `Claude Code ${target.version}`);
    emitRow('Extension', shortenPath(target.extensionDir));
  } else {
    printer.line(
      indent +
      color('Target'.padEnd(LAYOUT.LABEL_COL), Ansi.GREY) +
      color(missingText, `${Ansi.GREY}${Ansi.ITALIC}`),
    );
  }
  emitRow('Backup', shortenPath(backupRoot));
}

function renderMenuItems(printer, indent, items) {
  for (const item of items) {
    const mark = color(item.mark.padEnd(LAYOUT.MENU_MARK_COL), Ansi.TERRA);
    printer.line(indent + mark + color(item.label, Ansi.IVORY));
  }
}

function promptPrefix() {
  const { framePad, indent } = frameGeometry();
  return framePad + indent + color(LAYOUT.PROMPT_MARK, Ansi.TERRA);
}

function renderMainMenu(options) {
  const { menuItems, target, missingText, backupRoot } = options;
  clearScreen();
  const { inner, framePad, indent } = frameGeometry();
  const printer = createPrinter(framePad);
  const rule = color('━'.repeat(inner), Ansi.GREY);

  printer.blank();
  printer.line(rule);
  for (let i = 0; i < LAYOUT.TOP_BLANKS; i++) printer.blank();
  renderTitle(printer, inner);
  for (let i = 0; i < LAYOUT.TITLE_GAP_AFTER; i++) printer.blank();
  renderLedger(printer, indent, inner, target, missingText, backupRoot);
  for (let i = 0; i < LAYOUT.LEDGER_GAP_AFTER; i++) printer.blank();
  renderMenuItems(printer, indent, menuItems);
  for (let i = 0; i < LAYOUT.MENU_GAP_BEFORE_RULE; i++) printer.blank();
  printer.line(rule);
  for (let i = 0; i < LAYOUT.RULE_GAP_BEFORE_PROMPT; i++) printer.blank();
}

function renderLanguagePicker(options) {
  const { heading, optionsList } = options;
  clearScreen();
  const { inner, framePad, indent } = frameGeometry();
  const printer = createPrinter(framePad);
  const rule = color('━'.repeat(inner), Ansi.GREY);
  const centered = text => centerLine(text, inner);

  printer.blank();
  printer.line(rule);
  for (let i = 0; i < LAYOUT.TOP_BLANKS; i++) printer.blank();
  renderTitle(printer, inner);
  for (let i = 0; i < LAYOUT.TITLE_GAP_AFTER; i++) printer.blank();
  printer.line(centered(color(heading, Ansi.GREY)));
  printer.blank();
  printer.blank();
  renderMenuItems(printer, indent, optionsList);
  for (let i = 0; i < LAYOUT.MENU_GAP_BEFORE_RULE; i++) printer.blank();
  printer.line(rule);
  for (let i = 0; i < LAYOUT.RULE_GAP_BEFORE_PROMPT; i++) printer.blank();
}

module.exports = {
  Ansi,
  color,
  clearScreen,
  promptPrefix,
  renderMainMenu,
  renderLanguagePicker,
};
