import { SavedPost, StudioDatabase } from '../db/database';
import { cleanUpLibrary, MediaLibrary } from './mediaLibrary';
import { fetchPublicImage } from './ringCrawler';

/**
 * Saved posts: private copies of friends' posts and photos the user wants to keep (a recipe, a
 * reference photo), independent of the feed window and of the friend keeping the post online.
 * Nothing here is ever exported or published.
 */

export type ImageFetcher = (url: string) => Promise<{ body: Buffer; contentType: string }>;

/**
 * Saves a feed entry and, when it has a web image, a local copy of that image. The post is saved
 * even if the image can't be downloaded (offline, removed, unsupported type).
 */
export async function savePost(
  db: StudioDatabase,
  library: MediaLibrary,
  canonicalUrl: string,
  options: { note?: string; fetchImage?: ImageFetcher } = {}
): Promise<SavedPost> {
  const saved = db.saveFeedEntry(canonicalUrl, options.note);
  if (!saved.localMediaUrl && /^https?:\/\//i.test(saved.mediaUrl)) {
    try {
      const image = await (options.fetchImage || fetchPublicImage)(saved.mediaUrl);
      db.setSavedLocalMedia(saved.id, library.importSavedImage(image.body, image.contentType));
    } catch {
      // Keep the saved text and the link to the original image
    }
  }
  return db.getSavedPosts().find((s) => s.id === saved.id)!;
}

/** Removes a saved post and its local image copy. */
export function unsavePost(db: StudioDatabase, library: MediaLibrary, savedId: string): void {
  db.deleteSavedPost(savedId);
  cleanUpLibrary(db, library);
}
