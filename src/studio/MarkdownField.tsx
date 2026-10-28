import React, { useState } from 'react';
import { renderMarkdown } from '../shared/markdown';

/**
 * A Markdown textarea with a Write / Preview switch. The preview uses the same safe renderer as
 * the published page (it escapes everything first), so what you see is what gets published.
 */
export function MarkdownField(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  const [preview, setPreview] = useState(false);
  const tab = (active: boolean) =>
    `px-2 py-0.5 rounded-md text-[11px] font-semibold ${active ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`;
  return (
    <div className={props.className}>
      <div className="flex items-center gap-1 mb-1">
        <button type="button" className={tab(!preview)} onClick={() => setPreview(false)}>Write</button>
        <button type="button" className={tab(preview)} onClick={() => setPreview(true)}>Preview</button>
        <span className="ml-auto text-[10px] text-slate-500">
          Markdown: **bold**, *italic*, [link](https://…), # heading, - list, | table |
        </span>
      </div>
      {preview ? (
        <div
          className="studio-prose min-h-[4rem] px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(props.value) || '<p class="text-slate-500">Nothing to preview.</p>' }}
        />
      ) : (
        <textarea
          value={props.value}
          onChange={(e) => props.onChange(e.target.value.slice(0, 10000))}
          placeholder={props.placeholder}
          rows={props.rows ?? 6}
          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono leading-relaxed"
        />
      )}
    </div>
  );
}
