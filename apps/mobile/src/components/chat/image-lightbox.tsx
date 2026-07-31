import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { memo, useCallback, useEffect, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import Gallery from 'react-native-awesome-gallery';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassPill } from '@/components/glass-pill';
import { saveImageToLibrary, shareImage } from '@/lib/image-actions';

const SAVED_TOAST_DURATION_MS = 1800;

interface ImageLightboxProps {
  visible: boolean;
  imageUrls: string[];
  initialIndex: number;
  onClose: () => void;
}

export const ImageLightbox = memo(function ImageLightbox({
  visible,
  imageUrls,
  initialIndex,
  onClose,
}: ImageLightboxProps) {
  const insets = useSafeAreaInsets();
  // `viewedIndex` is what the user has swiped to; `null` means "haven't
  // swiped yet, fall back to whatever initialIndex the parent passed".
  // Resetting to null on close (rather than syncing from initialIndex in an
  // effect) keeps the index source-of-truth-derived and avoids
  // set-state-in-effect.
  const [viewedIndex, setViewedIndex] = useState<number | null>(null);
  const [savedShown, setSavedShown] = useState(false);
  const currentIndex = viewedIndex ?? initialIndex;

  useEffect(() => {
    if (!savedShown) return;
    const handle = setTimeout(() => setSavedShown(false), SAVED_TOAST_DURATION_MS);
    return () => clearTimeout(handle);
  }, [savedShown]);

  // The Modal stays mounted across open/close cycles, so any state we don't
  // explicitly clear here would carry over to the next open. Both consumers
  // route every close through the `onClose` prop, so resetting here covers
  // all paths (back button, swipe-to-close, hardware back).
  const handleClose = useCallback(() => {
    setViewedIndex(null);
    setSavedShown(false);
    onClose();
  }, [onClose]);

  if (imageUrls.length === 0) return null;

  const currentUrl = imageUrls[currentIndex] ?? imageUrls[0] ?? '';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
      statusBarTranslucent>
      <View style={styles.backdrop}>
        <Gallery
          data={imageUrls}
          initialIndex={initialIndex}
          onIndexChange={setViewedIndex}
          onSwipeToClose={handleClose}
          keyExtractor={(item, index) => `${item}-${index}`}
          renderItem={({ item, setImageDimensions }) => (
            <Image
              source={{ uri: item }}
              style={styles.image}
              contentFit="contain"
              onLoad={(event) => {
                const { width, height } = event.source;
                if (width && height) setImageDimensions({ width, height });
              }}
            />
          )}
        />
        <View
          style={[
            styles.toolbarSlot,
            { top: insets.top + 8, left: Math.max(12, insets.left + 8) },
          ]}
          pointerEvents="box-none">
          <GlassPill
            surface="glass"
            tintColor="#FFFFFF"
            actions={[
              {
                symbol: { ios: 'chevron.backward', android: 'chevron_left' },
                accessibilityLabel: 'Back',
                onPress: handleClose,
              },
            ]}
          />
        </View>
        {currentUrl ? (
          <View
            style={[
              styles.toolbarSlot,
              { top: insets.top + 8, right: Math.max(12, insets.right + 8) },
            ]}
            pointerEvents="box-none">
            <GlassPill
              surface="glass"
              tintColor="#FFFFFF"
              actions={[
                {
                  symbol: { ios: 'square.and.arrow.up', android: 'share' },
                  accessibilityLabel: 'Share image',
                  onPress: () => {
                    void shareImage(currentUrl);
                  },
                },
                {
                  symbol: { ios: 'square.and.arrow.down', android: 'download' },
                  accessibilityLabel: 'Save image',
                  onPress: () => {
                    void (async () => {
                      const ok = await saveImageToLibrary(currentUrl);
                      if (ok) setSavedShown(true);
                    })();
                  },
                },
              ]}
            />
          </View>
        ) : null}
        {savedShown ? (
          <Animated.View
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(220)}
            pointerEvents="none"
            style={[styles.toastSlot, { bottom: insets.bottom + 32 }]}>
            <SavedToast />
          </Animated.View>
        ) : null}
      </View>
    </Modal>
  );
});

function SavedToast() {
  const content = (
    <View style={styles.toastRow}>
      <SymbolView
        name={{ ios: 'checkmark.circle.fill', android: 'check_circle' }}
        size={18}
        tintColor="#34C759"
        weight="semibold"
      />
      <Text style={styles.toastText}>Saved to Photos</Text>
    </View>
  );

  if (process.env.EXPO_OS === 'ios' && isLiquidGlassAvailable()) {
    return (
      <GlassView glassEffectStyle="regular" style={styles.toastCapsule}>
        {content}
      </GlassView>
    );
  }
  if (process.env.EXPO_OS === 'ios') {
    return (
      <BlurView tint="systemChromeMaterial" intensity={60} style={styles.toastCapsule}>
        {content}
      </BlurView>
    );
  }
  return <View style={[styles.toastCapsule, styles.toastCapsuleFallback]}>{content}</View>;
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: '#000000',
    flex: 1,
  },
  image: {
    flex: 1,
  },
  toastCapsule: {
    borderRadius: 999,
    overflow: 'hidden',
  },
  toastCapsuleFallback: {
    backgroundColor: 'rgba(28, 28, 30, 0.92)',
  },
  toastRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  toastSlot: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  toolbarSlot: {
    position: 'absolute',
  },
});
