// SHARD — shared page footer: a single restrained bar used on every
// content page. Left: brand, year, license. Right: compact icon links.
// theme-aware via tokens (border-line / text-tertiary / hover:text-heading)
// so it renders correctly in light and dark without duplication.
import { Heart, Shield, FileText } from "lucide-react";
import { CrystalLogo } from "./CrystalLogo";
import { navigate } from "../App";
import { GITHUB_URL } from "../config/donate";

const GITHUB_SVG = (
  <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
);

const NAV = [
  { label: "Donate", href: "/donate", icon: <Heart className="h-3.5 w-3.5" aria-hidden /> },
  { label: "GitHub", href: GITHUB_URL, icon: GITHUB_SVG, external: true },
  { label: "Security", href: "/security", icon: <Shield className="h-3.5 w-3.5" aria-hidden /> },
  { label: "Terms", href: "/terms", icon: <FileText className="h-3.5 w-3.5" aria-hidden /> },
] as const;

export default function Footer() {
  return (
    <footer className="w-full border-t border-line transition-colors duration-200">
      <div className="mx-auto w-full max-w-4xl px-4 py-8 text-xs text-tertiary">
        <p className="mb-7 text-sm text-secondary">The conversation that never happened.</p>
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          {/* Left: brand · copyright · license */}
          <div className="flex items-center gap-1.5">
            <CrystalLogo className="h-4 w-4 shrink-0" />
            <span className="font-semibold text-secondary">SHARD</span>
            <span aria-hidden>·</span>
            <span>© 2026</span>
            <span aria-hidden>·</span>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md px-0.5 py-0.5 transition-colors duration-200 hover:text-heading"
            >
              AGPL-3.0 License
            </a>
          </div>

          {/* Right: compact icon links */}
          <nav aria-label="Footer" className="flex items-center gap-5">
            {NAV.map((item) => (
              <a
                key={item.label}
                href={item.href}
                target={"external" in item && item.external ? "_blank" : undefined}
                rel={"external" in item && item.external ? "noopener noreferrer" : undefined}
                onClick={
                  "external" in item && item.external
                    ? undefined
                    : (e) => {
                        e.preventDefault();
                        navigate(item.href);
                      }
                }
                className="flex items-center gap-1.5 rounded-md px-0.5 py-0.5 transition-colors duration-200 hover:text-heading"
              >
                {item.icon}
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
