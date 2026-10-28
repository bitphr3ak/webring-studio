import React, { useEffect, useState } from 'react';
import { ExternalLink, Star, Trash2 } from 'lucide-react';
import { renderMarkdown } from '../shared/markdown';

/** A friend's post or photo saved as a private copy (database.ts SavedPost). */
export interface SavedPostView {
  id: string;
  canonicalUrl: string;
  friendSiteUrl: string;
  friendName: string;
  friendAvatarUrl: string;
  entryType: 'photo' | 'post' | 'like' | 'share' | 'recommendation' | 'comment';
  title: string;
  commentary: string;
  targetUrl: string;
  mediaUrl: string;
  localMediaUrl: string;
  tags: string[];
  note: string;
  createdAt: string;
  savedAt: string;
  verifiedSignature: boolean;
}

/**
 * Saved posts: kept beyond the feed window and after the friend removes them. Private notes,
 * a text filter, and links back to the original.
 */
export function SavedPostsView(props: {
  saved: SavedPostView[];
  mediaSrc: (url: string) => string;
  onOpen: (url: string) => void;
  onRemove: (saved: SavedPostView) => Promise<void>;
  onSaveNote: (saved: SavedPostView, note: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();
  const shown = query
    ? props.saved.filter((s) =>
        [s.title, s.commentary, s.note, s.friendName, ...s.tags].some((text) => text.toLowerCase().includes(query))
      )
    : props.saved;

  if (props.saved.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center space-y-3">
        <Star className="w-10 h-10 text-amber-300 mx-auto" />
        <h3 className="font-bold text-base">Nothing saved yet</h3>
        <p className="text-xs text-slate-400 max-w-md mx-auto">
          Use <strong>☆ Save</strong> on a friend's post or photo to keep a private copy here, with its image. Saved
          posts stay after they leave your feed window or your friend removes them, and they're never published.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Search ${props.saved.length} saved post${props.saved.length === 1 ? '' : 's'}…`}
        className="w-full px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-800 text-sm focus:border-indigo-500 focus:outline-none"
      />
      {shown.length === 0 && <p className="text-sm text-slate-500 text-center py-6">No saved posts match "{filter}".</p>}
      {shown.map((saved) => (
        <SavedCard
          key={saved.id}
          saved={saved}
          mediaSrc={props.mediaSrc}
          onOpen={props.onOpen}
          onRemove={props.onRemove}
          onSaveNote={props.onSaveNote}
        />
      ))}
    </div>
  );
}

function SavedCard(props: {
  saved: SavedPostView;
  mediaSrc: (url: string) => string;
  onOpen: (url: string) => void;
  onRemove: (saved: SavedPostView) => Promise<void>;
  onSaveNote: (saved: SavedPostView, note: string) => Promise<void>;
}) {
  const { saved } = props;
  const [note, setNote] = useState(saved.note);
  useEffect(() => setNote(saved.note), [saved.note]);
  const image = saved.localMediaUrl ? props.mediaSrc(saved.localMediaUrl) : saved.mediaUrl;
  const original = /^https?:\/\//i.test(saved.targetUrl) ? saved.targetUrl : saved.friendSiteUrl;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">
            <span className="font-bold">{saved.friendName}</span>
            <span className="text-slate-500"> · {new Date(saved.createdAt).toLocaleDateString()}</span>
            {saved.verifiedSignature && <span className="ml-2 text-[10px] text-emerald-400">✓ verified when saved</span>}
          </p>
          <p className="text-[11px] text-slate-500">Saved {new Date(saved.savedAt).toLocaleDateString()}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => props.onOpen(original)}
            className="text-slate-400 hover:text-indigo-300"
            title="Open the original"
            aria-label="Open the original"
          >
            <ExternalLink className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => props.onRemove(saved)}
            className="text-slate-500 hover:text-rose-400"
            title="Remove from Saved"
            aria-label={`Remove ${saved.title} from Saved`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      {image && <img src={image} alt={saved.title} className="w-full max-h-96 object-cover rounded-xl" />}
      <h4 className="font-bold text-base">{saved.title}</h4>
      {saved.entryType === 'post' ? (
        <div className="studio-prose text-sm text-slate-300" dangerouslySetInnerHTML={{ __html: renderMarkdown(saved.commentary) }} />
      ) : (
        saved.commentary && <p className="text-sm text-slate-300 whitespace-pre-line">{saved.commentary}</p>
      )}
      {saved.tags.length > 0 && <p className="text-xs text-indigo-300">{saved.tags.map((t) => `#${t}`).join(' ')}</p>}
      <div>
        <label className="block text-[11px] text-slate-400 mb-1">Your note (private)</label>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note !== saved.note) void props.onSaveNote(saved, note);
          }}
          placeholder="Why you saved it, what to try…"
          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm focus:border-indigo-500 focus:outline-none"
        />
      </div>
    </div>
  );
}
