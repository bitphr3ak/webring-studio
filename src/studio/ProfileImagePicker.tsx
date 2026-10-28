import React, { useState } from 'react';
import { ImagePlus, Images, Trash2, Upload } from 'lucide-react';
import { AlbumItem } from '../shared/schema';

/**
 * Profile photo or banner: upload a local image (saved straight away, replacing the previous
 * upload), pick a photo from an album, or enter a web address. Album and address choices are
 * applied when the profile is saved, like the other profile fields.
 */
export function ProfileImagePicker(props: {
  kind: 'avatar' | 'banner';
  label: string;
  value: string;
  /** The value currently saved on the profile, to show when a choice still needs saving. */
  savedValue: string;
  albums: AlbumItem[];
  mediaSrc: (url: string) => string;
  onChange: (url: string) => void;
  onUpload: (filePath?: string) => Promise<void>;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const avatar = props.kind === 'avatar';
  const value = props.value.trim();

  const photos = props.albums.flatMap((album) => album.photos.map((photo) => ({ album, photo })));
  const fromAlbum = photos.find(({ photo }) => photo.url === value || photo.thumbUrl === value);
  const source = !value
    ? 'No image'
    : value.startsWith('media/profile/')
      ? 'Uploaded image'
      : fromAlbum
        ? `From album: ${fromAlbum.album.title}`
        : value.startsWith('media/')
          ? 'Media Library image'
          : 'Web address';

  const upload = async (filePath?: string) => {
    setBusy(true);
    try {
      await props.onUpload(filePath);
    } finally {
      setBusy(false);
    }
  };

  const buttonClass =
    'px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs font-medium flex items-center gap-1.5';

  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">{props.label}</label>
      <div className={`flex gap-3 ${avatar ? 'items-center' : 'flex-col'}`}>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            const path = file && window.studioApi ? window.studioApi.getPathForFile(file) : '';
            if (path) void upload(path);
          }}
          className={`relative shrink-0 overflow-hidden bg-slate-950 border-2 border-dashed flex items-center justify-center text-slate-600 ${
            dragging ? 'border-indigo-400' : 'border-slate-800'
          } ${avatar ? 'w-24 h-24 rounded-2xl' : 'w-full h-28 rounded-xl'}`}
          title="Drop a JPEG or PNG here"
        >
          {value ? (
            <img src={props.mediaSrc(value)} alt="" className="w-full h-full object-cover" />
          ) : (
            <ImagePlus className="w-6 h-6" />
          )}
          {busy && <div className="absolute inset-0 bg-slate-950/70 flex items-center justify-center text-[11px] text-slate-300">Uploading…</div>}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            <button type="button" disabled={busy} onClick={() => void upload()} className={buttonClass}>
              <Upload className="w-3.5 h-3.5" /> Upload…
            </button>
            <button type="button" disabled={photos.length === 0} onClick={() => setBrowsing(!browsing)} className={buttonClass}>
              <Images className="w-3.5 h-3.5" /> From albums
            </button>
            {value && (
              <button type="button" onClick={() => props.onChange('')} className={`${buttonClass} text-rose-300`}>
                <Trash2 className="w-3.5 h-3.5" /> Remove
              </button>
            )}
          </div>
          <input
            type="text"
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            placeholder="or an image address: https://…"
            className="w-full px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs focus:border-indigo-500 focus:outline-none"
          />
          <p className="text-[11px] text-slate-500">
            {source}
            {props.value !== props.savedValue && <span className="text-amber-300"> · save the profile to apply</span>}
          </p>
        </div>
      </div>
      {browsing && (
        <div className="mt-2 p-2 rounded-xl bg-slate-950 border border-slate-800 max-h-56 overflow-y-auto grid grid-cols-4 sm:grid-cols-6 gap-1.5">
          {photos.map(({ album, photo }) => {
            // The thumbnail (480 px) is plenty for a profile photo; banners use the full web copy
            const url = avatar ? photo.thumbUrl || photo.url : photo.url;
            return (
              <button
                key={photo.id}
                type="button"
                title={`${album.title}${photo.caption ? ` · ${photo.caption}` : ''}`}
                onClick={() => {
                  props.onChange(url);
                  setBrowsing(false);
                }}
                className={`aspect-square rounded-lg overflow-hidden border-2 ${value === url ? 'border-indigo-400' : 'border-transparent hover:border-slate-600'}`}
              >
                <img src={props.mediaSrc(photo.thumbUrl || photo.url)} alt={photo.altText} className="w-full h-full object-cover" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
