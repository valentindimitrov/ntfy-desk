// A small Markdown renderer for ntfy's Markdown messages (content_type text/markdown). It builds DOM
// nodes with textContent only (never innerHTML), and links only to http(s) URLs. Supported: paragraphs,
// line breaks, # headings, - and 1. lists, ``` code blocks, `code`, **bold**, *italic* / _italic_ and
// [links](https://...); bare http(s) URLs become links too (linkify). Anything else stays text.

import { isHttpUrl } from './ntfy';

// A bare URL: up to whitespace or a character that can't be part of one written in text
const BARE_URL = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Plain text with its http(s) URLs as links (trailing punctuation such as a full stop stays text) */
export function linkify(text: string, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(BARE_URL)) {
    let url = match[0];
    // "(see https://x.example/a)." ends at the a; a URL with its own ( keeps its )
    while (/[.,;:!?)\]}]$/.test(url) && !(url.endsWith(')') && url.includes('('))) {
      url = url.slice(0, -1);
    }
    const index = match.index ?? 0;
    if (!isHttpUrl(url)) continue;
    if (index > last) fragment.append(text.slice(last, index));
    const link = doc.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = url;
    fragment.append(link);
    last = index + url.length;
  }
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}

// Inline markup, first match wins: code, bold, italic, link
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function renderInline(text: string, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) {
      fragment.append(linkify(text.slice(last, index), doc));
    }
    const [, code, bold, bold2, italic, italic2, linkText, linkUrl] = match;
    if (code !== undefined) {
      const element = doc.createElement('code');
      element.textContent = code;
      fragment.append(element);
    } else if (bold !== undefined || bold2 !== undefined) {
      const element = doc.createElement('strong');
      element.append(renderInline(bold ?? bold2 ?? '', doc));
      fragment.append(element);
    } else if (italic !== undefined || italic2 !== undefined) {
      const element = doc.createElement('em');
      element.append(renderInline(italic ?? italic2 ?? '', doc));
      fragment.append(element);
    } else if (linkText !== undefined && isHttpUrl(linkUrl)) {
      const element = doc.createElement('a');
      element.href = linkUrl;
      element.target = '_blank';
      element.rel = 'noopener noreferrer';
      element.textContent = linkText;
      fragment.append(element);
    } else {
      // A link to anything but http(s): its text only
      fragment.append(linkText ?? match[0]);
    }
    last = index + match[0].length;
  }
  if (last < text.length) {
    fragment.append(linkify(text.slice(last), doc));
  }
  return fragment;
}

function paragraph(lines: string[], doc: Document): HTMLElement {
  const element = doc.createElement('p');
  lines.forEach((line, i) => {
    if (i > 0) element.append(doc.createElement('br'));
    element.append(renderInline(line, doc));
  });
  return element;
}

export function renderMarkdown(text: string, doc: Document = document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let pending: string[] = [];
  const flush = () => {
    if (pending.length > 0) {
      fragment.append(paragraph(pending, doc));
      pending = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith('```'); i++) {
        code.push(lines[i]!);
      }
      const pre = doc.createElement('pre');
      const element = doc.createElement('code');
      element.textContent = code.join('\n');
      pre.append(element);
      fragment.append(pre);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      // Kept small inside a message: h1-h2 as h4, the rest as h5
      const element = doc.createElement(heading[1]!.length <= 2 ? 'h4' : 'h5');
      element.append(renderInline(heading[2]!, doc));
      fragment.append(element);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const list = doc.createElement(bullet ? 'ul' : 'ol');
      const itemPattern = bullet ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      for (; i < lines.length; i++) {
        const item = itemPattern.exec(lines[i]!);
        if (!item) break;
        const li = doc.createElement('li');
        li.append(renderInline(item[1]!, doc));
        list.append(li);
      }
      i--;
      fragment.append(list);
      continue;
    }

    if (line.trim() === '') {
      flush();
    } else {
      pending.push(line);
    }
  }
  flush();
  return fragment;
}

/** Plain text of a Markdown message, for desktop notifications */
export function markdownToText(text: string): string {
  return text
    .replace(/^```.*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_, a: string | undefined, b: string | undefined) => a ?? b ?? '')
    .replace(/\*([^*\n]+)\*|_([^_\n]+)_/g, (_, a: string | undefined, b: string | undefined) => a ?? b ?? '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
