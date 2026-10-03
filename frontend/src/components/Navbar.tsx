// SHARD — shared top navigation bar. One component, pixel-identical on
// very page: logo home, section links (from another route they hop back
// to slash first, then scroll to the section once it has mounted), GitHub
// pill, theme toggle, and the session CTA. Below the md breakpoint the
// enter links collapse into a hamburger dropdown; the GitHub pill hides
// on narrow screens to keep the bar uncluttered. The current page's link
// (/donate, /security, /terms) is subtly highlighted via aria-current.
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { CrystalLogo } from "./CrystalLogo";
import { ThemeToggle } from "./ThemeToggle";
import { navigate } from "../App";

const LINKS = [
  { label: "Architecture", href: "#architecture" },
  { label: "Security", href: "/security" },
  { label: "FAQ", href: "#faq" },
  { label: "Donate", href: "/donate" },
] as const;

export default function Navbar() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const sync = () => {
      setPath(window.location.pathname);
      setMenuOpen(false);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  function onNavClick(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
    setMenuOpen(false);
    if (href.startsWith("#")) {
      // On the landing the browser jumps to the section natively; from
      // other routes route to "/#section" — the landing scrolls to the
      // hash once its sections have mounted (see Landing's mount effect).
      if (window.location.pathname !== "/") {
        e.preventDefault();
        navigate("/" + href);
      }
      return;
    }
    e.preventDefault();
    navigate(href);
  }

  return (
    <nav className="safe-pt fixed inset-x-0 top-0 z-50 line-b bg-page/80 backdrop-blur-xl transition-colors duration-200">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <button
          type="button"
          onClick={() => {
            setMenuOpen(false);
            navigate("/");
          }}
          className="flex items-center gap-2.5 transition-opacity duration-200 hover:opacity-80 active:scale-95"
        >
          <CrystalLogo className="logo-intro h-8 w-8" />
          <span className="text-base font-semibold tracking-wider text-heading">SHARD</span>
        </button>

        {/* Desktop: inline links */}
        <div className="hidden items-center gap-7 text-sm text-secondary md:flex">
          {LINKS.map(({ label, href }) => {
            const active = href.startsWith("/") && href === path;
            return (
              <a
                key={href}
                href={href}
                onClick={(e) => onNavClick(e, href)}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-1 py-0.5 transition-colors duration-200 hover:text-heading active:scale-95 ${
                  active ? "font-medium text-heading" : ""
                }`}
              >
                {label}
              </a>
            );
          })}
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <a
            href="https://github.com/ShardChat/ShardChat"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden items-center gap-1.5 rounded-full border border-line bg-page/60 px-3 py-1.5 text-xs font-medium text-secondary backdrop-blur-md transition-all duration-200 hover:border-line-strong hover:bg-page/80 hover:text-heading active:scale-95 sm:flex"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            GitHub
          </a>
          <ThemeToggle />
          {/* The session CTA is redundant on /new — the page IS the CTA. */}
          {path !== "/new" && (
            <button
              type="button"
              onClick={() => navigate("/new")}
              className="rounded-full bg-black px-3.5 py-1.5 text-xs font-medium text-white transition-colors duration-200 hover:bg-zinc-800 active:scale-95 dark:bg-white dark:text-black dark:hover:bg-zinc-200 sm:px-4"
            >
              Start session
            </button>
          )}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="card card-hover flex h-9 w-9 items-center justify-center rounded-full text-secondary transition-all duration-200 hover:text-heading active:scale-90 md:hidden"
          >
            {menuOpen ? <X className="h-4.5 w-4.5" aria-hidden /> : <Menu className="h-4.5 w-4.5" aria-hidden />}
          </button>
        </div>
      </div>

      {/* Mobile: dropdown panel with the same links */}
      {menuOpen && (
        <div
          id="mobile-menu"
          className="safe-pb border-t border-line bg-page/95 backdrop-blur-xl transition-colors duration-200 md:hidden"
        >
          <div className="mx-auto flex max-w-6xl flex-col px-4 py-2">
            {LINKS.map(({ label, href }) => {
              const active = href.startsWith("/") && href === path;
              return (
                <a
                  key={href}
                  href={href}
                  onClick={(e) => onNavClick(e, href)}
                  aria-current={active ? "page" : undefined}
                  className={`border-b border-line py-3 text-sm text-secondary transition-colors duration-200 last:border-b-0 hover:text-heading ${
                    active ? "font-medium text-heading" : ""
                  }`}
                >
                  {label}
                </a>
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
}
