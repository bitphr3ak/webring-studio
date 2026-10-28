/**
 * A small, safe Markdown renderer for profile text blocks.
 *
 * Every character is HTML-escaped first, then a limited syntax is applied: headings, paragraphs,
 * **bold**, *italic*, `code`, fenced code, links, bullet/numbered lists, quotes, horizontal rules
 * and pipe tables. Raw HTML is never passed through, and links only allow http(s), mailto,
 * site-relative and media/ URLs, so nothing a user types can run script on the page.
 *
 * The function is fully self-contained (no imports, no outside references) because the site
 * generator also embeds its source into the published page with `renderMarkdown.toString()`,
 * so text blocks render the same way whether the page uses its embedded data or live JSON.
 */
export function renderMarkdown(source: string): string {
  const MAX_LENGTH = 10000;
  const escapeHtml = (text: string) =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  const safeHref = (raw: string) => {
    // raw has already been escaped; undo &amp; so the scheme check sees the real URL
    const url = raw.replace(/&amp;/g, '&').trim();
    const lower = url.toLowerCase();
    const allowed =
      lower.startsWith('https://') ||
      lower.startsWith('http://') ||
      lower.startsWith('mailto:') ||
      lower.startsWith('media/') ||
      lower.startsWith('./') ||
      lower.startsWith('#') ||
      (lower.startsWith('/') && !lower.startsWith('//'));
    return allowed ? escapeHtml(url) : '';
  };
  const inline = (text: string) => {
    const codeSpans: string[] = [];
    let out = text.replace(/`([^`]+)`/g, (_m, code: string) => {
      codeSpans.push(`<code>${code}</code>`);
      return `\u0000${codeSpans.length - 1}\u0000`;
    });
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
      const safe = safeHref(href);
      if (!safe) return label;
      const external = /^https?:/i.test(safe);
      return `<a href="${safe}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
    });
    out = out
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)]);
  };
  const splitRow = (line: string) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const lines = escapeHtml(String(source || '').slice(0, MAX_LENGTH).replace(/\r\n?/g, '\n')).split('\n');
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      html.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length + 1; // # → h2: the page already has an h1
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${head.map((_h, c) => `<td>${inline(r[c] || '')}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>'
      );
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) quote.push(lines[i++].replace(/^&gt;\s?/, ''));
      html.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''))}</li>`);
      }
      html.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|&gt;|\s*([-*+]|\d+\.)\s+|(-{3,}|\*{3,})\s*$)/.test(lines[i])
    ) {
      paragraph.push(lines[i++]);
    }
    if (paragraph.length === 0) {
      paragraph.push(lines[i++]);
    }
    html.push(`<p>${inline(paragraph.join('<br>'))}</p>`);
  }
  return html.join('\n');
}

/**
 * Markdown as plain text, for places that show a short snippet (a post's derived title, a grid
 * tile, a reel card): markers are dropped and links keep their label. Self-contained for the same
 * reason as renderMarkdown; the result still needs escaping before it goes into HTML.
 */
export function markdownToPlainText(source: string): string {
  return String(source || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^```.*$/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*(\n|$)/gm, '')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s).,!?:;]|$)/gm, '$1$2')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
