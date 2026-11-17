// PRIVACY.md to HTML for the privacy policy page, at build time. Only what that file uses is
// supported: # and ## headings, paragraphs, one-level "- " lists, **bold** and [text](https://…) links.
// Anything else stops the build, so the page can't silently differ from the file.

const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const slug = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');

function inline(text: string): string {
  const html = escapeHtml(text)
    .replaceAll(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replaceAll(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // What is left of Markdown syntax after the supported forms were replaced
  const rest = html.replaceAll(/<a href="[^"]*">/g, '');
  if (/[*`_[\]]|!\[/.test(rest)) throw new Error(`Unsupported Markdown in: ${text}`);
  return html;
}

export function renderMarkdown(source: string): string {
  const blocks = source
    .replaceAll('\r\n', '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      const heading = /^(#{1,2}) (.+)$/.exec(block);
      if (heading && lines.length === 1) {
        const [, marks = '', text = ''] = heading;
        return marks.length === 1 ? `<h1>${inline(text)}</h1>` : `<h2 id="${slug(text)}">${inline(text)}</h2>`;
      }
      if (lines.every((line) => line.startsWith('- '))) {
        return `<ul>\n${lines.map((line) => `<li>${inline(line.slice(2))}</li>`).join('\n')}\n</ul>`;
      }
      if (lines.some((line) => /^(#|>|\||- |\d+\. |\s)/.test(line))) throw new Error(`Unsupported Markdown block: ${block}`);
      return `<p>${inline(lines.join(' '))}</p>`;
    })
    .join('\n');
}
