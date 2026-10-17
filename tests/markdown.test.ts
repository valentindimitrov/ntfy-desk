// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { markdownToText, renderMarkdown } from '@/utils/markdown';

function html(markdown: string): string {
  const div = document.createElement('div');
  div.append(renderMarkdown(markdown));
  return div.innerHTML;
}

describe('renderMarkdown', () => {
  it('renders the supported markup', () => {
    expect(html('**Disk** at *91%* on `gx10`')).toBe('<p><strong>Disk</strong> at <em>91%</em> on <code>gx10</code></p>');
    expect(html('# Title\n\ntext\nnext line')).toBe('<h4>Title</h4><p>text<br>next line</p>');
    expect(html('- one\n- two\n\n1. first\n2. second')).toBe('<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>');
    expect(html('```\n<b>raw</b>\n```')).toBe('<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>');
  });

  it('links to http(s) only, opening in a new tab', () => {
    expect(html('[logs](https://logs.example/a)')).toBe(
      '<p><a href="https://logs.example/a" target="_blank" rel="noopener noreferrer">logs</a></p>',
    );
    expect(html('[click](javascript:alert(1))')).toBe('<p>click)</p>');
    expect(html('[file](file:///etc/passwd)')).toBe('<p>file</p>');
  });

  it('never turns text into HTML', () => {
    const rendered = html('<img src=x onerror=alert(1)> **<script>alert(1)</script>**');
    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain('<script');
    expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('markdownToText', () => {
  it('strips the markup for desktop notifications', () => {
    expect(markdownToText('# Alert\n**Disk** at *91%*, see [logs](https://x.example)\n- `sda`')).toBe(
      'Alert\nDisk at 91%, see logs\n• sda',
    );
  });
});
