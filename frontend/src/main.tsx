import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// theme bootstrap first: applies system/localStorage theme to <html>.
import "./lib/themeBase";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
