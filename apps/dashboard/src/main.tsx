import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Atkinson Hyperlegible Next: drawn by the Braille Institute for low-vision readers,
// self-hosted so the dashboard renders the same with or without a network.
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/600.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
