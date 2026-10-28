import React, { useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { SharedItem } from '../shared/schema';
import { MarkdownField } from './MarkdownField';

/** The fields of a post or shared item that can be edited after publishing. */
export interface ItemEdit {
  title: string;
  commentary: string;
  targetUrl?: string;
  targetAuthorName?: string;
  targetAuthorUrl?: string;
  category?: string;
  mediaUrl: string;
  rating?: number | null;
  tags: string[];
}

const fieldClass = 'w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm focus:border-indigo-500 focus:outline-none';
const labelClass = 'block text-[11px] text-slate-400 mb-1';

/**
 * Inline editor for one of the user's own items. Its type, id and permanent address don't change,
 * so friends' likes and comments stay attached to it.
 */
export function ItemEditor(props: {
  item: SharedItem;
  mediaSrc: (url: string) => string;
  onPickImage: () => Promise<string | null>;
  onSave: (edit: ItemEdit) => Promise<void>;
  onCancel: () => void;
}) {
  const { item } = props;
  const isPost = item.type === 'post';
  const isComment = item.type === 'comment';
  const rated = !isPost && !isComment;
  const [draft, setDraft] = useState({
    title: item.title,
    commentary: item.commentary,
    targetUrl: item.targetUrl === item.canonicalUrl ? '' : item.targetUrl,
    targetAuthorName: item.targetAuthorName || '',
    targetAuthorUrl: item.targetAuthorUrl || '',
    category: item.category,
    mediaUrl: item.mediaUrl,
    rating: item.rating ?? 0,
    tags: item.tags.join(', '),
  });
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isPost && !draft.commentary.trim() && !draft.title.trim()) return;
    setSaving(true);
    try {
      await props.onSave({
        title: draft.title,
        commentary: draft.commentary,
        mediaUrl: draft.mediaUrl.trim(),
        tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
        ...(isPost
          ? {}
          : {
              targetUrl: draft.targetUrl,
              targetAuthorName: draft.targetAuthorName,
              targetAuthorUrl: draft.targetAuthorUrl,
              category: draft.category,
            }),
        ...(rated ? { rating: draft.rating || null } : {}),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-3">
      <div>
        <label className={labelClass}>Title</label>
        <input
          type="text"
          value={draft.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder={isPost ? 'Optional: the first line of your text is used if empty' : 'Title'}
          className={fieldClass}
        />
      </div>
      <div>
        <label className={labelClass}>{isPost ? 'Post' : isComment ? 'Your comment' : 'Your notes'}</label>
        {isPost ? (
          <MarkdownField value={draft.commentary} onChange={(commentary) => set({ commentary })} rows={6} />
        ) : (
          <textarea
            rows={3}
            value={draft.commentary}
            onChange={(e) => set({ commentary: e.target.value })}
            className={fieldClass}
          />
        )}
      </div>
      {!isPost && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-3">
            <label className={labelClass}>{isComment ? 'Replying to (post address)' : 'Link'}</label>
            <input type="text" value={draft.targetUrl} onChange={(e) => set({ targetUrl: e.target.value })} placeholder="https://…" className={fieldClass} />
          </div>
          <div>
            <label className={labelClass}>Source / author name</label>
            <input type="text" value={draft.targetAuthorName} onChange={(e) => set({ targetAuthorName: e.target.value })} className={fieldClass} />
          </div>
          <div>
            <label className={labelClass}>Source / author address</label>
            <input type="text" value={draft.targetAuthorUrl} onChange={(e) => set({ targetAuthorUrl: e.target.value })} placeholder="https://…" className={fieldClass} />
          </div>
          <div>
            <label className={labelClass}>Category</label>
            <input type="text" value={draft.category} onChange={(e) => set({ category: e.target.value })} className={fieldClass} />
          </div>
        </div>
      )}
      <div>
        <label className={labelClass}>Image</label>
        <div className="flex flex-wrap items-center gap-2">
          {draft.mediaUrl && <img src={props.mediaSrc(draft.mediaUrl)} alt="" className="w-16 h-16 rounded-lg object-cover bg-slate-800" />}
          <button
            type="button"
            onClick={async () => {
              const url = await props.onPickImage();
              if (url) set({ mediaUrl: url });
            }}
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1.5"
          >
            <ImagePlus className="w-3.5 h-3.5" /> Upload…
          </button>
          {draft.mediaUrl && (
            <button
              type="button"
              onClick={() => set({ mediaUrl: '' })}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-rose-300 flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" /> Remove
            </button>
          )}
          <input
            type="text"
            value={draft.mediaUrl}
            onChange={(e) => set({ mediaUrl: e.target.value })}
            placeholder="or an image address: https://…"
            className={`${fieldClass} flex-1 min-w-[12rem] text-xs`}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="md:col-span-2">
          <label className={labelClass}>Tags (comma-separated)</label>
          <input type="text" value={draft.tags} onChange={(e) => set({ tags: e.target.value })} className={fieldClass} />
        </div>
        {rated && (
          <div>
            <label className={labelClass}>Rating</label>
            <select value={draft.rating} onChange={(e) => set({ rating: Number(e.target.value) })} className={fieldClass}>
              <option value={0}>No rating</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>{'★'.repeat(n)}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving} className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-semibold text-xs">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" onClick={props.onCancel} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs">
          Cancel
        </button>
        <span className="text-[11px] text-slate-500">Its address stays the same, so friends' likes and comments stay with it.</span>
      </div>
    </form>
  );
}
