import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { setupViewportClass } from "./lib/viewport";
import {
  setupDesktopAttributes,
  setupFullscreenSync,
  applyStoredAppBgTransparent,
  applyStoredZoom,
  setupApiClient,
  setupDeepLinkListener,
  setupZoomShortcuts,
  syncStoredRecentChannels,
} from "./lib/desktop";

setupApiClient();
setupViewportClass();
setupDesktopAttributes();
applyStoredAppBgTransparent();
void applyStoredZoom();
void setupFullscreenSync();
void setupDeepLinkListener();
void setupZoomShortcuts();
void syncStoredRecentChannels();

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
