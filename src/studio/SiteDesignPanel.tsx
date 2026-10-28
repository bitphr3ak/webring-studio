import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, Plus, Trash2 } from 'lucide-react';
import {
  AlbumItem,
  Appearance,
  DEFAULT_LAYOUT,
  ITEM_BLOCK_KINDS,
  LayoutBlock,
  LayoutBlockType,
  MAX_LAYOUT_BLOCKS,
  ProfileTheme,
  SharedItem,
  THEME_LABELS,
} from '../shared/schema';
import { MarkdownField } from './MarkdownField';

/**
 * Site Design: the look & feel options and the ordered content blocks of the published page.
 * Edits save automatically (debounced) and the live preview beside this panel refreshes.
 */

type DesignUpdate = { theme?: ProfileTheme; appearance?: Appearance; layout?: LayoutBlock[] };

interface SiteDesignPanelProps {
  theme: ProfileTheme;
  appearance: Appearance | undefined;
  layout: LayoutBlock[] | undefined;
  albums: AlbumItem[];
  items: SharedItem[];
  publishFriendsList: boolean;
  guestbookConfigured: boolean;
  mediaSrc: (url: string) => string;
  onSave: (updates: DesignUpdate) => Promise<void>;
}

type ThumbShape = 'stack' | 'sidebar' | 'deck' | 'rails' | 'grid' | 'reel';

interface ThemeOption {
  id: ProfileTheme;
  group: 'classic' | 'social';
  hint: string;
  shape: ThumbShape;
  /** Page background (also used for the accent contrast check), card surface, accent and text. */
  background: string;
  surface: string;
  accent: string;
  ink: string;
  /** "Use suggested block order": block types in this order, anything else keeps its place after. */
  suggestedOrder?: LayoutBlockType[];
}

const THEMES: ThemeOption[] = [
  { id: 'neo-webring', group: 'classic', hint: 'Dark slate cards', shape: 'stack', background: '#0f172a', surface: '#1e293b', accent: '#6366f1', ink: '#f8fafc' },
  { id: 'minimal-zine', group: 'classic', hint: 'Paper & serif', shape: 'stack', background: '#fafaf9', surface: '#ffffff', accent: '#1c1917', ink: '#1c1917' },
  { id: 'cyber-terminal', group: 'classic', hint: 'Black & green', shape: 'stack', background: '#050505', surface: '#0a0f0d', accent: '#22c55e', ink: '#4ade80' },
  { id: 'cozy-scrapbook', group: 'classic', hint: 'Warm amber', shape: 'stack', background: '#fef3c7', surface: '#fffbeb', accent: '#d97706', ink: '#451a03' },
  {
    id: 'facepace', group: 'social', hint: 'Cover photo, intro sidebar, post cards', shape: 'sidebar',
    background: '#eef1f6', surface: '#ffffff', accent: '#3460d4', ink: '#1c2433',
    suggestedOrder: ['text', 'items', 'albums', 'featured', 'image', 'friends', 'contact', 'links', 'guestbook'],
  },
  {
    id: 'tweetdeck', group: 'social', hint: 'Sky blue, a column per block', shape: 'deck',
    background: '#c6e2f4', surface: '#ffffff', accent: '#2b8fd6', ink: '#22303c',
    suggestedOrder: ['items', 'albums', 'friends', 'featured', 'text', 'image', 'links', 'contact', 'guestbook'],
  },
  {
    id: 'xtraspecial', group: 'social', hint: 'Black timeline between rails', shape: 'rails',
    background: '#000000', surface: '#16181c', accent: '#3d9df2', ink: '#e9ecef',
    suggestedOrder: ['featured', 'items', 'albums', 'text', 'image', 'friends', 'links', 'contact', 'guestbook'],
  },
  {
    id: 'instapick', group: 'social', hint: 'Stats, highlights, square grid', shape: 'grid',
    background: '#ffffff', surface: '#efefef', accent: '#d6337a', ink: '#1f1f1f',
    suggestedOrder: ['albums', 'items', 'featured', 'text', 'image', 'links', 'contact', 'friends', 'guestbook'],
  },
  {
    id: 'tiktalk', group: 'social', hint: 'Dark vertical reel', shape: 'reel',
    background: '#0b0b0f', surface: '#1c1c22', accent: '#ff3b6b', ink: '#f2f2f2',
    suggestedOrder: ['items', 'albums', 'featured', 'text', 'image', 'links', 'contact', 'friends', 'guestbook'],
  },
];

/** A tiny wireframe of a theme's page arrangement, in its colours. */
function ThemeThumb({ option }: { option: ThemeOption }) {
  const box = (style: React.CSSProperties, key?: string) => (
    <div key={key} style={{ position: 'absolute', borderRadius: 2, background: option.surface, ...style }} />
  );
  const accent = (style: React.CSSProperties) => box({ background: option.accent, ...style });
  const parts: React.ReactNode[] = [];
  switch (option.shape) {
    case 'sidebar':
      parts.push(accent({ left: 0, right: 0, top: 0, height: 5, borderRadius: 0 }), box({ left: 6, right: 6, top: 8, height: 14 }));
      parts.push(<div key="av" style={{ position: 'absolute', left: 10, top: 16, width: 10, height: 10, borderRadius: 99, background: option.accent, border: `2px solid ${option.surface}` }} />);
      parts.push(box({ left: 6, width: 24, top: 25, bottom: 4 }), box({ left: 33, right: 6, top: 25, height: 16 }), box({ left: 33, right: 6, top: 44, bottom: 4 }));
      break;
    case 'deck':
      [0, 1, 2, 3].forEach((i) => parts.push(box({ left: 4 + i * 23, width: 20, top: 4, bottom: 4 }, `c${i}`)));
      parts.push(accent({ left: 4, width: 20, top: 4, height: 8 }));
      break;
    case 'rails':
      parts.push(accent({ left: 5, width: 6, top: 6, height: 6, borderRadius: 99 }), box({ left: 5, width: 14, top: 16, height: 3 }), box({ left: 5, width: 14, top: 22, height: 3 }));
      parts.push(<div key="ln" style={{ position: 'absolute', left: 24, right: 30, top: 0, bottom: 0, borderLeft: `1px solid ${option.surface}`, borderRight: `1px solid ${option.surface}` }} />);
      [0, 1, 2, 3].forEach((i) => parts.push(box({ left: 28, right: 34, top: 6 + i * 13, height: 9 }, `r${i}`)));
      parts.push(box({ right: 4, width: 22, top: 6, height: 20 }), box({ right: 4, width: 22, top: 30, height: 16 }));
      break;
    case 'grid':
      parts.push(<div key="av" style={{ position: 'absolute', left: 22, top: 5, width: 14, height: 14, borderRadius: 99, border: `2px solid ${option.accent}` }} />);
      parts.push(box({ left: 42, width: 36, top: 7, height: 3 }), box({ left: 42, width: 26, top: 13, height: 3 }));
      [0, 1, 2, 3, 4, 5].forEach((i) => parts.push(box({ left: 22 + (i % 3) * 19, width: 17, top: 24 + Math.floor(i / 3) * 19, height: 17, borderRadius: 0 }, `g${i}`)));
      break;
    case 'reel':
      parts.push(<div key="av" style={{ position: 'absolute', left: 44, top: 4, width: 10, height: 10, borderRadius: 99, background: option.accent }} />);
      parts.push(<div key="reel" style={{ position: 'absolute', left: 34, width: 30, top: 18, bottom: 3, borderRadius: 3, background: `linear-gradient(160deg, ${option.accent}, #2ee6e6)` }} />);
      [0, 1, 2].forEach((i) => parts.push(<div key={`d${i}`} style={{ position: 'absolute', left: 58, top: 36 + i * 7, width: 4, height: 4, borderRadius: 99, background: '#fff' }} />));
      break;
    default:
      parts.push(accent({ left: 6, right: 6, top: 5, height: 12 }), box({ left: 6, right: 6, top: 20, height: 10 }));
      parts.push(box({ left: 6, width: 42, top: 33, bottom: 4 }), box({ left: 50, right: 6, top: 33, bottom: 4 }));
  }
  return (
    <div className="relative w-full h-16 rounded-md overflow-hidden" style={{ background: option.background }} aria-hidden="true">
      {parts}
    </div>
  );
}

const ACCENTS = ['#6366f1', '#22d3ee', '#a855f7', '#ec4899', '#f97316', '#eab308', '#22c55e', '#ef4444'];

const BLOCK_LABELS: Record<LayoutBlockType, string> = {
  albums: 'Photo albums',
  items: 'Posts & shares',
  friends: 'Friends',
  text: 'Text',
  image: 'Image',
  links: 'Link buttons',
  featured: 'Featured',
  contact: 'Contact & elsewhere',
  guestbook: 'Guestbook',
};

const KIND_LABELS: Record<(typeof ITEM_BLOCK_KINDS)[number], string> = {
  post: 'Posts',
  like: 'Likes',
  share: 'Shares',
  recommendation: 'Recommendations',
  comment: 'Comments',
};

function newBlock(type: LayoutBlockType): LayoutBlock {
  const id = `${type}-${Math.random().toString(36).slice(2, 8)}`;
  switch (type) {
    case 'albums':
      return { id, type, visible: true, options: { style: 'grid' } };
    case 'items':
      return { id, type, visible: true, options: { kinds: ['post'], limit: 6 } };
    case 'text':
      return { id, type, visible: true, title: 'About me', options: { markdown: '' } };
    case 'image':
      return { id, type, visible: true, options: { url: '', alt: '', caption: '' } };
    case 'links':
      return { id, type, visible: true, options: { links: [{ label: '', url: '' }] } };
    case 'featured':
      return { id, type, visible: true, options: { canonicalUrl: '' } };
    case 'contact':
      return { id, type, visible: true, options: { entries: [{ label: '', url: '' }] } };
    default:
      return { id, type, visible: true, options: {} } as LayoutBlock;
  }
}

/** WCAG contrast ratio between two #rrggbb colours. */
function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const channel = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const inputClass = 'w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs';
const selectClass = 'px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs';

export function SiteDesignPanel(props: SiteDesignPanelProps) {
  const [theme, setTheme] = useState<ProfileTheme>(props.theme);
  const [appearance, setAppearance] = useState<Appearance>(props.appearance || {});
  const [layout, setLayout] = useState<LayoutBlock[]>(props.layout ?? DEFAULT_LAYOUT);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef<DesignUpdate>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  // Pick up changes made elsewhere (persona switch, MCP agent) unless the user is mid-edit
  useEffect(() => {
    if (dirty.current) return;
    setTheme(props.theme);
    setAppearance(props.appearance || {});
    setLayout(props.layout ?? DEFAULT_LAYOUT);
  }, [props.theme, props.appearance, props.layout]);

  const queueSave = (update: DesignUpdate, delay = 600) => {
    dirty.current = true;
    pending.current = { ...pending.current, ...update };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const payload = pending.current;
      pending.current = {};
      setSaving(true);
      try {
        await props.onSave(payload);
      } finally {
        setSaving(false);
        dirty.current = false;
      }
    }, delay);
  };

  const updateAppearance = (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    setAppearance(next);
    queueSave({ appearance: next }, 250);
  };

  const updateLayout = (next: LayoutBlock[], delay?: number) => {
    setLayout(next);
    queueSave({ layout: next }, delay);
  };

  const updateBlock = (id: string, change: (block: LayoutBlock) => LayoutBlock, delay?: number) => {
    updateLayout(layout.map((b) => (b.id === id ? change(b) : b)), delay);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= layout.length || from === to) return;
    const next = [...layout];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateLayout(next, 200);
  };

  const themeOption = THEMES.find((t) => t.id === theme) || THEMES[0];
  const themeBackground = themeOption.background;

  const chooseTheme = (id: ProfileTheme) => {
    setTheme(id);
    queueSave({ theme: id }, 100);
  };

  // Reorders blocks by the template's suggestion; nothing is added, removed or hidden
  const applySuggestedOrder = () => {
    const order = themeOption.suggestedOrder;
    if (!order) return;
    const rank = (b: LayoutBlock) => {
      const i = order.indexOf(b.type);
      return i === -1 ? order.length : i;
    };
    const next = layout.map((b, i) => ({ b, i })).sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i).map((x) => x.b);
    updateLayout(next, 200);
  };
  const accentContrast = appearance.accent ? contrastRatio(appearance.accent, themeBackground) : null;

  const featuredOptions = [
    ...props.items.filter((i) => i.type !== 'comment').map((i) => ({ value: i.canonicalUrl, label: `${i.type}: ${i.title}` })),
    ...props.albums.map((a) => ({ value: a.canonicalUrl, label: `album: ${a.title}` })),
  ];
  const libraryImages = props.albums.flatMap((a) =>
    a.photos.map((p) => ({ url: p.url, thumb: p.thumbUrl || p.url, label: p.caption || a.title, alt: p.altText }))
  );

  const renderBlockSettings = (block: LayoutBlock) => {
    switch (block.type) {
      case 'albums':
        return (
          <div className="space-y-2">
            <select
              className={selectClass}
              value={block.options.style}
              onChange={(e) => updateBlock(block.id, (b) => ({ ...b, options: { ...block.options, style: e.target.value as 'grid' | 'carousel' } }) as LayoutBlock, 200)}
            >
              <option value="grid">Grid</option>
              <option value="carousel">Carousel (scrolls sideways)</option>
            </select>
            <p className="text-[11px] text-slate-400">Albums to show (none ticked = all):</p>
            {props.albums.map((album) => {
              const ids = block.options.albumIds || [];
              return (
                <label key={album.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="accent-indigo-500"
                    checked={ids.includes(album.id)}
                    onChange={(e) => {
                      const nextIds = e.target.checked ? [...ids, album.id] : ids.filter((x) => x !== album.id);
                      updateBlock(block.id, () => ({ ...block, options: { ...block.options, albumIds: nextIds } }), 200);
                    }}
                  />
                  {album.title}
                </label>
              );
            })}
          </div>
        );
      case 'items':
        return (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {ITEM_BLOCK_KINDS.map((kind) => (
                <label key={kind} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    className="accent-indigo-500"
                    checked={block.options.kinds.includes(kind)}
                    onChange={(e) => {
                      const kinds = e.target.checked ? [...block.options.kinds, kind] : block.options.kinds.filter((k) => k !== kind);
                      if (kinds.length === 0) return;
                      updateBlock(block.id, () => ({ ...block, options: { ...block.options, kinds } }), 200);
                    }}
                  />
                  {KIND_LABELS[kind]}
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs">
              Show at most
              <input
                type="number"
                min={1}
                max={200}
                className={`${selectClass} w-20`}
                value={block.options.limit ?? ''}
                placeholder="All"
                onChange={(e) => {
                  const value = Number(e.target.value);
                  updateBlock(block.id, () => ({ ...block, options: { ...block.options, limit: value > 0 ? Math.min(200, value) : undefined } }));
                }}
              />
            </label>
          </div>
        );
      case 'friends':
        return (
          <p className="text-[11px] text-slate-400">
            {props.publishFriendsList
              ? 'Shows the friends you have marked public.'
              : 'Publishing your friends list is off (Friends & Webrings), so this block shows nothing.'}
          </p>
        );
      case 'text':
        return (
          <div className="space-y-1">
            <MarkdownField
              value={block.options.markdown}
              placeholder={'Write in Markdown: **bold**, *italic*, [links](https://...), lists, and tables:\n| Year | Event |\n|---|---|\n| 2026 | Joined the ring |'}
              onChange={(markdown) => updateBlock(block.id, () => ({ ...block, options: { markdown } }), 900)}
            />
            <p className="text-[10px] text-slate-500">Markdown, with headings, lists, links, quotes, code and tables. HTML isn't allowed.</p>
          </div>
        );
      case 'image':
        return (
          <div className="space-y-2">
            {libraryImages.length > 0 && (
              <select
                className={`${selectClass} w-full`}
                value={libraryImages.some((i) => i.url === block.options.url) ? block.options.url : ''}
                onChange={(e) => {
                  const picked = libraryImages.find((i) => i.url === e.target.value);
                  if (picked) updateBlock(block.id, () => ({ ...block, options: { ...block.options, url: picked.url, alt: block.options.alt || picked.alt } }), 200);
                }}
              >
                <option value="">Choose from Media Library…</option>
                {libraryImages.map((img) => (
                  <option key={img.url} value={img.url}>{img.label}</option>
                ))}
              </select>
            )}
            <input className={inputClass} placeholder="Or an image URL (https://…)" value={block.options.url}
              onChange={(e) => updateBlock(block.id, () => ({ ...block, options: { ...block.options, url: e.target.value } }), 900)} />
            {block.options.url && <img src={props.mediaSrc(block.options.url)} alt="" className="w-full max-h-32 object-cover rounded-lg" />}
            <input className={inputClass} placeholder="Alt text (describe the image)" value={block.options.alt}
              onChange={(e) => updateBlock(block.id, () => ({ ...block, options: { ...block.options, alt: e.target.value } }), 900)} />
            <input className={inputClass} placeholder="Caption (optional)" value={block.options.caption}
              onChange={(e) => updateBlock(block.id, () => ({ ...block, options: { ...block.options, caption: e.target.value } }), 900)} />
            <input className={inputClass} placeholder="Link when clicked (optional)" value={block.options.link || ''}
              onChange={(e) => updateBlock(block.id, () => ({ ...block, options: { ...block.options, link: e.target.value || undefined } }), 900)} />
          </div>
        );
      case 'links':
      case 'contact': {
        const rows = block.type === 'links' ? block.options.links : block.options.entries;
        const write = (next: Array<{ label: string; url: string }>) =>
          updateBlock(
            block.id,
            () => (block.type === 'links' ? { ...block, options: { links: next } } : { ...block, options: { entries: next } }) as LayoutBlock,
            900
          );
        return (
          <div className="space-y-1.5">
            {rows.map((row, idx) => (
              <div key={idx} className="flex gap-1.5">
                <input className={inputClass} placeholder={block.type === 'contact' ? 'Email, Mastodon…' : 'Label'} value={row.label}
                  onChange={(e) => write(rows.map((r, i) => (i === idx ? { ...r, label: e.target.value } : r)))} />
                <input className={inputClass} placeholder={block.type === 'contact' ? 'mailto: or https://' : 'https://…'} value={row.url}
                  onChange={(e) => write(rows.map((r, i) => (i === idx ? { ...r, url: e.target.value } : r)))} />
                <button type="button" className="px-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs" title="Remove"
                  onClick={() => write(rows.filter((_r, i) => i !== idx))}>✕</button>
              </div>
            ))}
            <button type="button" className="text-xs text-indigo-300 hover:underline" onClick={() => write([...rows, { label: '', url: '' }])}>
              + Add {block.type === 'contact' ? 'contact' : 'link'}
            </button>
          </div>
        );
      }
      case 'featured':
        return (
          <select
            className={`${selectClass} w-full`}
            value={block.options.canonicalUrl}
            onChange={(e) => updateBlock(block.id, () => ({ ...block, options: { canonicalUrl: e.target.value } }), 200)}
          >
            <option value="">Choose a post or album…</option>
            {featuredOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label.slice(0, 80)}</option>
            ))}
          </select>
        );
      case 'guestbook':
        return (
          <p className="text-[11px] text-slate-400">
            {props.guestbookConfigured
              ? 'Visitors can open a comment thread (Giscus / Utterances) for your whole page.'
              : 'Set up Giscus or Utterances in Publish & SFTP to use a guestbook; until then this block shows nothing.'}
          </p>
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-5">
      {/* Look & feel */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-sm">Look &amp; feel</h3>
          {saving && <span className="text-[10px] text-slate-500">Saving…</span>}
        </div>
        {(
          [
            ['classic', 'Classic themes', 'Colours and fonts over the standard page.'],
            ['social', 'Social-style templates', 'These also rearrange the page. Your blocks keep their order within it.'],
          ] as const
        ).map(([group, heading, note]) => (
          <div key={group}>
            <p className="text-xs text-slate-400">{heading}</p>
            <p className="text-[11px] text-slate-500 mb-1.5">{note}</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" role="radiogroup" aria-label={heading}>
              {THEMES.filter((t) => t.group === group).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={theme === t.id}
                  onClick={() => chooseTheme(t.id)}
                  className={`text-left p-1.5 rounded-lg border ${theme === t.id ? 'border-indigo-400 bg-indigo-500/10' : 'border-slate-800 hover:border-slate-600'}`}
                >
                  <ThemeThumb option={t} />
                  <span className="block text-xs font-semibold text-slate-100 mt-1">{THEME_LABELS[t.id]}</span>
                  <span className="block text-[10px] text-slate-400 leading-tight">{t.hint}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {themeOption.suggestedOrder && (
          <button
            type="button"
            onClick={applySuggestedOrder}
            className="text-[11px] px-2.5 py-1 rounded-lg border border-slate-700 hover:border-slate-500 text-slate-300"
          >
            Use {THEME_LABELS[theme]}'s suggested block order
          </button>
        )}
        <div>
          <p className="text-xs text-slate-400 mb-1.5">Accent colour</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => updateAppearance({ accent: undefined })}
              className={`h-7 px-2 rounded-lg text-[10px] border ${!appearance.accent ? 'border-white' : 'border-slate-700'} bg-slate-950`}
            >
              Theme
            </button>
            {ACCENTS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Accent ${color}`}
                onClick={() => updateAppearance({ accent: color })}
                className={`w-7 h-7 rounded-lg border-2 ${appearance.accent === color ? 'border-white' : 'border-transparent'}`}
                style={{ background: color }}
              />
            ))}
            <input
              type="color"
              aria-label="Custom accent colour"
              value={appearance.accent || '#6366f1'}
              onChange={(e) => updateAppearance({ accent: e.target.value })}
              className="w-9 h-7 rounded-lg bg-transparent border border-slate-700 cursor-pointer"
            />
          </div>
          {accentContrast !== null && accentContrast < 3 && (
            <p className="text-[11px] text-amber-300 mt-1.5">
              This colour is hard to see on this theme's background (contrast {accentContrast.toFixed(1)}:1). Try a
              {contrastRatio(themeBackground, '#000000') > contrastRatio(themeBackground, '#ffffff') ? ' darker' : ' lighter'} shade.
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs text-slate-400">
          {(
            [
              ['font', 'Font', [['theme', 'As theme'], ['sans', 'Sans'], ['serif', 'Serif'], ['rounded', 'Rounded'], ['mono', 'Mono']]],
              ['corners', 'Corners', [['rounded', 'Rounded'], ['sharp', 'Sharp'], ['soft', 'Extra soft']]],
              ['surface', 'Sections', [['card', 'Cards'], ['flat', 'Flat']]],
              ['background', 'Background', [['theme', 'As theme'], ['gradient', 'Accent glow'], ['banner-blur', 'Blurred banner']]],
              ['bannerHeight', 'Banner height', [['medium', 'Medium'], ['short', 'Short'], ['tall', 'Tall']]],
              ['avatarShape', 'Profile photo', [['rounded', 'Rounded square'], ['circle', 'Circle']]],
              ['interactions', 'Interactive extras', [['on', 'On (lightbox, post view)'], ['off', 'Off']]],
            ] as const
          ).map(([key, label, choices]) => (
            <label key={key} className="block">
              {label}
              <select
                className={`${selectClass} w-full mt-1 text-slate-100`}
                value={(appearance[key] as string | undefined) || choices[0][0]}
                onChange={(e) => updateAppearance({ [key]: e.target.value } as Partial<Appearance>)}
              >
                {choices.map(([value, text]) => (
                  <option key={value} value={value}>{text}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>

      {/* Page layout */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
        <div>
          <h3 className="font-bold text-sm">Page layout</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Your banner, photo, name, bio and links stay at the top. Drag the blocks below to arrange the rest of
            the page.
          </p>
        </div>
        <ul className="space-y-1.5">
          {layout.map((block, index) => (
            <li
              key={block.id}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null) move(dragIndex, index);
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
              className={`rounded-xl border ${dragIndex === index ? 'border-indigo-400' : 'border-slate-800'} bg-slate-950`}
            >
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <GripVertical className="w-4 h-4 text-slate-500 cursor-grab shrink-0" aria-hidden />
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === block.id ? null : block.id)}
                  className={`flex-1 text-left text-xs font-medium truncate ${block.visible ? '' : 'text-slate-500 line-through'}`}
                >
                  {block.title || BLOCK_LABELS[block.type]}
                  {block.title && <span className="text-slate-500 font-normal"> · {BLOCK_LABELS[block.type]}</span>}
                </button>
                <button type="button" title="Move up" disabled={index === 0} onClick={() => move(index, index - 1)} className="p-1 rounded hover:bg-slate-800 disabled:opacity-30">
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button type="button" title="Move down" disabled={index === layout.length - 1} onClick={() => move(index, index + 1)} className="p-1 rounded hover:bg-slate-800 disabled:opacity-30">
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  title={block.visible ? 'Hide' : 'Show'}
                  onClick={() => updateBlock(block.id, (b) => ({ ...b, visible: !b.visible }), 100)}
                  className="p-1 rounded hover:bg-slate-800"
                >
                  {block.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
                </button>
                <button
                  type="button"
                  title="Remove block"
                  onClick={() => updateLayout(layout.filter((b) => b.id !== block.id), 100)}
                  className="p-1 rounded hover:bg-slate-800 text-rose-300"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              {expanded === block.id && (
                <div className="px-3 pb-3 pt-1 space-y-2 border-t border-slate-800">
                  <input
                    className={inputClass}
                    placeholder="Heading (leave empty for the default)"
                    value={block.title ?? ''}
                    onChange={(e) => updateBlock(block.id, (b) => ({ ...b, title: e.target.value || undefined }), 900)}
                  />
                  {renderBlockSettings(block)}
                </div>
              )}
            </li>
          ))}
        </ul>
        {layout.length < MAX_LAYOUT_BLOCKS && (
          <div className="flex flex-wrap items-center gap-2">
            <Plus className="w-3.5 h-3.5 text-slate-400" />
            <select
              className={selectClass}
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                const block = newBlock(e.target.value as LayoutBlockType);
                updateLayout([...layout, block], 100);
                setExpanded(block.id);
              }}
            >
              <option value="">Add a block…</option>
              {(Object.keys(BLOCK_LABELS) as LayoutBlockType[]).map((type) => (
                <option key={type} value={type}>{BLOCK_LABELS[type]}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => updateLayout(DEFAULT_LAYOUT.map((b) => ({ ...b })), 100)}
              className="ml-auto text-[11px] text-slate-400 hover:text-white"
            >
              Reset to default
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
