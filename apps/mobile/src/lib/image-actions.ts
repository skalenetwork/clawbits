import { Directory, File, Paths } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
// The modern `MediaLibrary.Asset.create` API rejects unless the app has *full*
// read/write library access ("Allow Access to All Photos") — even for a single
// add. The legacy module wraps Apple's `UIImageWriteToSavedPhotosAlbum`, which
// only triggers the Add-Only prompt ("…would like to add to your Photos") and
// is the right system API for save-one-image flows.
import { saveToLibraryAsync } from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';

const CACHE_SUBDIR = 'image-actions';

async function downloadToCache(url: string): Promise<File> {
  const dir = new Directory(Paths.cache, CACHE_SUBDIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return File.downloadFileAsync(url, dir, { idempotent: true });
}

/** @returns `true` on a confirmed save, `false` on any failure. */
export async function saveImageToLibrary(url: string): Promise<boolean> {
  try {
    const file = await downloadToCache(url);
    await saveToLibraryAsync(file.uri);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    return true;
  } catch (err) {
    Alert.alert('Save failed', err instanceof Error ? err.message : 'Unknown error.');
    return false;
  }
}

export async function shareImage(url: string): Promise<void> {
  try {
    if (!(await Sharing.isAvailableAsync())) return;
    const file = await downloadToCache(url);
    await Sharing.shareAsync(file.uri, { UTI: 'public.image', mimeType: 'image/*' });
  } catch (err) {
    Alert.alert('Share failed', err instanceof Error ? err.message : 'Unknown error.');
  }
}
