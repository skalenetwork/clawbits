const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Makes the Android app foldable / large-screen friendly.
 *
 *  - Strips ``android:screenOrientation`` from MainActivity. Android 16
 *    (API 36) ignores the attribute on displays with ``smallestWidth``
 *    >= 600dp anyway, but removing it silences the Play Store adaptive
 *    quality warning and lets phone-sized rotation work.
 *  - Sets ``android:resizeableActivity="true"`` explicitly so the
 *    classification is unambiguous on pre-Android-16 devices.
 *  - Adds the ``android.supports_size_changes`` meta-data signal Google
 *    Play uses for the Tier 2 / Tier 3 adaptive classification.
 *
 *  iOS keeps the ``"orientation": "portrait"`` setting from app.json,
 *  which Expo translates into ``UISupportedInterfaceOrientations`` —
 *  ``supportsTablet: false`` means iPhone-only, so portrait-lock is
 *  still the right iOS behavior.
 */
const withAndroidFoldable = (config) => {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    const mainActivity = application?.activity?.find(
      (a) => a.$['android:name'] === '.MainActivity',
    );
    if (!mainActivity) return cfg;

    delete mainActivity.$['android:screenOrientation'];
    mainActivity.$['android:resizeableActivity'] = 'true';

    const SIZE_CHANGES = 'android.supports_size_changes';
    const metaData = mainActivity['meta-data'] ?? [];
    const existing = metaData.find((m) => m.$['android:name'] === SIZE_CHANGES);
    if (existing) {
      existing.$['android:value'] = 'true';
    } else {
      metaData.push({
        $: { 'android:name': SIZE_CHANGES, 'android:value': 'true' },
      });
    }
    mainActivity['meta-data'] = metaData;

    return cfg;
  });
};

module.exports = withAndroidFoldable;
