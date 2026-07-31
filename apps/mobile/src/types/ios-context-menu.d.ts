// react-native-ios-context-menu (and its sibling react-native-ios-utilities)
// ship as source-only packages; their package.json `types` field points at a
// `lib/` directory that isn't published. Metro bundles the source fine, but
// TypeScript needs these shims to resolve the module names.

declare module 'react-native-ios-context-menu' {
  import { ComponentType, ReactNode } from 'react';
  import { ViewProps } from 'react-native';

  export interface MenuItemIcon {
    type: 'IMAGE_SYSTEM';
    imageValue: { systemName: string };
  }

  export interface MenuItem {
    actionKey: string;
    actionTitle: string;
    menuAttributes?: ('destructive' | 'disabled' | 'hidden')[];
    icon?: MenuItemIcon;
  }

  export interface MenuConfig {
    menuTitle?: string;
    menuItems: MenuItem[];
  }

  export type AuxiliaryPreviewSizeValue =
    | { mode: 'constant'; value: number }
    | { mode: 'percentRelativeToWindow'; percent: number }
    | { mode: 'percentRelativeToPreview'; percent: number }
    | { mode: 'multipleValues'; values: [AuxiliaryPreviewSizeValue] };

  export interface AuxiliaryPreviewConfig {
    verticalAnchorPosition?: 'automatic' | 'top' | 'bottom';
    horizontalAlignment?:
      | 'targetLeading'
      | 'targetTrailing'
      | 'targetCenter'
      | 'previewLeading'
      | 'previewTrailing'
      | 'previewCenter'
      | 'stretchPreview'
      | 'stretchScreen';
    marginPreview?: number;
    preferredWidth?: AuxiliaryPreviewSizeValue;
    preferredHeight?: AuxiliaryPreviewSizeValue;
    marginVerticalInner?: number;
    marginVerticalOuter?: number;
    transitionConfigEntrance?: Record<string, unknown>;
    transitionExitPreset?: Record<string, unknown>;
  }

  export interface ContextMenuViewProps extends ViewProps {
    menuConfig?: MenuConfig;
    previewConfig?: Record<string, unknown>;
    renderPreview?: () => ReactNode;
    isAuxiliaryPreviewEnabled?: boolean;
    auxiliaryPreviewConfig?: AuxiliaryPreviewConfig;
    renderAuxiliaryPreview?: () => ReactNode;
    onPressMenuItem?: (event: { nativeEvent: { actionKey: string } }) => void;
    children?: ReactNode;
  }

  export const ContextMenuView: ComponentType<ContextMenuViewProps>;

  export interface ContextMenuButtonProps extends ViewProps {
    menuConfig?: MenuConfig;
    isMenuPrimaryAction?: boolean;
    isContextMenuEnabled?: boolean;
    onPressMenuItem?: (event: { nativeEvent: { actionKey: string } }) => void;
    children?: ReactNode;
  }

  export const ContextMenuButton: ComponentType<ContextMenuButtonProps>;
}

declare module 'react-native-ios-utilities';
