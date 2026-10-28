/**
 * The sample content earlier versions seeded into every new primary persona (the "Alex Rivera"
 * profile, a photo album, four posts, the fictional friend "Maya Lin" and a fake webring).
 * Kept only so StudioDatabase can remove it from existing installs: each row is deleted only
 * while it still matches what was seeded, so anything the user edited is left alone.
 */

export const DEMO_PEER_SITE_URL = 'https://maya.indiering.social';
export const DEMO_PEER_FOLDER_NAME = 'simulated-peer-maya';

export const LEGACY_DEMO_PROFILE = {
  siteUrl: 'https://alex.indiering.social',
  handle: 'alex.indiering.social',
  displayName: 'Alex Rivera',
  tagline: 'Digital gardener, analog photographer & webring explorer',
  bio: 'Welcome to my self-contained corner of the web! Everything here is hosted as static JSON & HTML, managed locally from my desktop studio, and federated across my friend ring.',
  location: 'Pacific Northwest',
  avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=300&auto=format&fit=crop&q=80',
  bannerUrl: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1200&auto=format&fit=crop&q=80',
  interests: ['IndieWeb', 'Photography', 'Self-Hosting', 'Decentralized Web', 'Sci-Fi'],
  atprotoHandle: 'alex.bsky.social',
};

export const LEGACY_DEMO_ALBUM = { id: 'album-pnw-trails', title: 'Misty Morning Trails' };

export const LEGACY_DEMO_PHOTOS = [
  {
    id: 'photo-sunbeams',
    url: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1200&auto=format&fit=crop&q=80',
  },
  {
    id: 'photo-coast-fog',
    url: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=1200&auto=format&fit=crop&q=80',
  },
];

export const LEGACY_DEMO_ITEMS = [
  { id: 'item-welcome-post', title: 'Building My Own Static Social Wall on the IndieWeb' },
  { id: 'item-posse-manifesto', title: 'Why Small Static Websites & Webrings Are Returning' },
  { id: 'item-synth-album', title: 'Music for Subterranean Greenhouses (Ambient Tape Loop LP)' },
  { id: 'item-camera-rec', title: 'Olympus OM-1 Mechanical 35mm SLR' },
];

export const LEGACY_DEMO_FRIEND = { id: 'friend-maya', siteUrl: DEMO_PEER_SITE_URL, displayName: 'Maya Lin' };

export const LEGACY_DEMO_WEBRING = {
  id: 'ring-indie-craft',
  hubUrl: 'https://ring.indiecraft.org/webring-hub.json',
};
