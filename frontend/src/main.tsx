import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { setupViewportClass } from "./lib/viewport";
import { setupApiClient, setupDesktop } from "./lib/desktop";
import { setupEnvFavicon } from "./lib/envFavicon";

setupEnvFavicon();
setupApiClient();
setupViewportClass();
setupDesktop();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
