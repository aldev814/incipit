import { hasMathPlaceholders, tokenizePlaceholders } from './math_tokens.js';

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'CODE',
  'PRE',
  'BUTTON',
  'INPUT',
  'TEXTAREA',
  'SVG',
  'MATH',
]);

// Block-level tags used to verify that a math token stays within one block.
// If `rawStart` and `rawEnd` resolve into different blocks, the token came
// from text stitched across child blocks. Inserting it would produce invalid
// DOM around the rendered math span, so the token is skipped.
const BLOCK_TAGS = new Set([
  'P', 'LI', 'TD', 'TH', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'DD', 'DT', 'DIV', 'PRE', 'HR',
  'UL', 'OL', 'DL', 'MENU',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'CAPTION', 'COLGROUP',
  'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'ASIDE',
  'FIGURE', 'FIGCAPTION', 'MAIN', 'ADDRESS',
  'FORM', 'FIELDSET', 'DETAILS', 'SUMMARY',
]);

function nearestBlockAncestor(node, segment) {
  let el = node && node.nodeType === 1 ? node : (node && node.parentElement);
  const stopAt = segment && segment.parentElement;
  while (el && el !== stopAt) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return segment || null;
}

export function renderMathInSegment(segment, renderTokenToNode) {
  // Cheapest gate first: `textContent` avoids the full linearize walk when
  // the segment obviously has no placeholders (the common case — user
  // bubbles, chrome, and most assistant paragraphs). `textContent` is a
  // single recursive string read, much cheaper than building the parts
  // table that `linearizeSegment` needs.
  const quickText = segment && segment.textContent;
  if (!hasMathPlaceholders(quickText)) {
    return { complete: true, mutated: false };
  }

  const linear = linearizeSegment(segment);
  if (!hasMathPlaceholders(linear.text)) {
    return { complete: true, mutated: false };
  }

  const tokenResult = tokenizePlaceholders(linear.text);
  if (!tokenResult.complete) {
    return { complete: false, mutated: false };
  }

  const mathTokens = tokenResult.tokens.filter((token) => token.type === 'math');
  if (mathTokens.length === 0) {
    return { complete: true, mutated: false };
  }

  const mutated = replaceMathTokens(segment, linear.parts, mathTokens, renderTokenToNode);
  return { complete: true, mutated };
}

function linearizeSegment(segment) {
  const state = { text: '', parts: [] };
  collectParts(segment, segment, state);
  return state;
}

function collectParts(root, node, state) {
  if (node.nodeType === Node.TEXT_NODE) {
    appendTextPart(node, state);
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  if (node !== root && shouldSkipSubtree(node)) {
    return;
  }

  if (node.tagName === 'BR') {
    appendBreakPart(node, state);
    return;
  }

  for (const child of Array.from(node.childNodes)) {
    collectParts(root, child, state);
  }
}

function shouldSkipSubtree(node) {
  if (SKIP_TAGS.has(node.tagName)) {
    return true;
  }

  if (node.hasAttribute && node.hasAttribute('data-tex-source')) {
    return true;
  }

  if (!node.classList) {
    return false;
  }

  return (
    node.classList.contains('katex') ||
    node.classList.contains('claude-math') ||
    node.classList.contains('claude-user-copy-btn') ||
    node.classList.contains('claude-user-copy-btn-row') ||
    node.classList.contains('claude-show-more-row') ||
    node.classList.contains('claude-show-more-btn')
  );
}

function appendTextPart(node, state) {
  const value = node.nodeValue || '';
  if (value.length === 0) {
    return;
  }

  const start = state.text.length;
  state.text += value;
  state.parts.push({ kind: 'text', node, start, end: state.text.length });
}

function appendBreakPart(node, state) {
  const start = state.text.length;
  state.text += '\n';
  state.parts.push({ kind: 'break', node, start, end: state.text.length });
}

function replaceMathTokens(segment, parts, tokens, renderTokenToNode) {
  let mutated = false;
  for (let idx = tokens.length - 1; idx >= 0; idx -= 1) {
    const token = tokens[idx];
    // Resolve START and END differently at part boundaries.
    // START wants the beginning of the next part, so it uses strict `<`.
    // END wants the end of the previous part, so it uses inclusive `<=`.
    // Reusing the same inclusive rule for both sides would misclassify a
    // token inside one text node as spanning multiple nodes.
    const start = resolvePointStart(parts, token.rawStart);
    const end = resolvePoint(parts, token.rawEnd);
    if (!start || !end) {
      continue;
    }

    // First gate: both ends must resolve inside the same text node.
    //
    // `Range.deleteContents()` across multiple text nodes can delete the
    // element nodes between them, such as `<em>` inside
    // `<p>$<em>x</em>=1$</p>`. React keeps references to those nodes and can
    // later fail with `The node to be removed is not a child of this node`.
    //
    // Under the current preprocessing path, valid math should collapse into a
    // single text node. Skipping an unexpected cross-node token is safer than
    // corrupting the webview DOM.
    if (start.container !== end.container) {
      continue;
    }

    // Second gate: also skip tokens that cross block ancestors.
    // This is redundant today, but it protects future relaxations of the
    // start/end resolution rules.
    const startBlock = nearestBlockAncestor(start.container, segment);
    const endBlock = nearestBlockAncestor(end.container, segment);
    if (startBlock !== endBlock) {
      continue;
    }

    const range = document.createRange();
    range.setStart(start.container, start.offset);
    range.setEnd(end.container, end.offset);
    range.deleteContents();
    range.insertNode(renderTokenToNode(token));
    mutated = true;
  }
  return mutated;
}

// END uses inclusive `<=` so `offset === part.end` lands at the end of that part.
function resolvePoint(parts, offset) {
  for (const part of parts) {
    if (offset < part.start) {
      break;
    }

    if (part.kind === 'text' && offset <= part.end) {
      return {
        container: part.node,
        offset: offset - part.start,
      };
    }

    if (part.kind === 'break') {
      if (offset === part.start) {
        return siblingPoint(part.node, 0);
      }
      if (offset === part.end) {
        return siblingPoint(part.node, 1);
      }
    }
  }

  const last = parts[parts.length - 1];
  if (!last) {
    return null;
  }

  if (last.kind === 'text' && offset === last.end) {
    return { container: last.node, offset: last.node.nodeValue.length };
  }

  if (last.kind === 'break' && offset === last.end) {
    return siblingPoint(last.node, 1);
  }

  return null;
}

// START uses strict `<`. When `offset === part.end`, that character belongs
// to the next part, not the current one. Treating it as current would
// misclassify a single-node token as cross-node.
function resolvePointStart(parts, offset) {
  for (const part of parts) {
    if (offset < part.start) {
      break;
    }

    if (part.kind === 'text' && offset < part.end) {
      return {
        container: part.node,
        offset: offset - part.start,
      };
    }

    if (part.kind === 'break') {
      if (offset === part.start) {
        return siblingPoint(part.node, 0);
      }
      if (offset === part.end) {
        return siblingPoint(part.node, 1);
      }
    }
  }

  // If `offset` equals the final part end and there is no next part, fall
  // back to END semantics and return the end of the last part.
  const last = parts[parts.length - 1];
  if (!last) {
    return null;
  }

  if (last.kind === 'text' && offset === last.end) {
    return { container: last.node, offset: last.node.nodeValue.length };
  }

  if (last.kind === 'break' && offset === last.end) {
    return siblingPoint(last.node, 1);
  }

  return null;
}

function siblingPoint(node, delta) {
  const parent = node.parentNode;
  if (!parent) {
    return null;
  }
  const index = Array.prototype.indexOf.call(parent.childNodes, node);
  return { container: parent, offset: index + delta };
}
