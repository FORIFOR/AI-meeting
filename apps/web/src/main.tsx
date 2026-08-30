import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles/global.css";
import { installAudioDebugRegistry } from "./audio/debugRegistry.js";

// Dev / `?debug=1`: track every AudioContext and MediaStreamTrack (window.__rcaiAudio.live()).
installAudioDebugRegistry();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
