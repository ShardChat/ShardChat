// SHARD — shared shell for standalone documentation pages (/security,
// /terms): strict Apple/OpenAI monochrome, one centered max-w-3xl column,
// shared Navbar/Footer, theme tokens only. The exported DocSection keeps
// both pages structurally identical — hairline-divided sections, one h2.
import { useEffect, type ReactNode } from "react";
import Navbar from "./Navbar";
import Footer from "./Footer";

export default function DocShell({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  // documentation pages always open at the top, even when reached from
  // deep inside a scrolled landing page.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="page-bg flex min-h-full flex-col text-secondary transition-colors duration-200">
      {/* Fading dot grid, same as every other page. */}
      <div
        aria-hidden
        className="page-grid pointer-events-none fixed inset-0 -z-10 transition-colors duration-200"
        style={{
          maskImage: "radial-gradient(ellipse 90% 60% at 50% 0%, black 30%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse 90% 60% at 50% 0%, black 30%, transparent 75%)",
        }}
      />

      {/* ============ NAVBAR: shared across pages ============ */}
      <Navbar />

      {/* ============ PAGE: centered narrow reading column ============ */}
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-24 pt-28">
        <span className="well inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-secondary">
          <span className="h-1.5 w-1.5 rounded-full bg-line-strong" aria-hidden />
          {eyebrow}
        </span>

        <h1 className="mt-6 text-4xl font-bold tracking-tight text-zinc-900 dark:text-white lg:text-5xl">
          {title}
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
          {subtitle}
        </p>
        <p className="mt-4 text-xs text-tertiary">Last updated · October 1, 2026</p>

        <div className="mt-14">{children}</div>
      </main>

      {/* ============ FOOTER: shared across pages ============ */}
      <Footer />
    </div>
  );
}

/** Hairline-divided section — identical rhythm on every documentation page. */
export function DocSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-14 border-t border-line pt-10 first:mt-0 first:border-t-0 first:pt-0">
      <h2 className="text-xl font-semibold tracking-tight text-heading sm:text-2xl">{title}</h2>
      <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-secondary">{children}</div>
    </section>
  );
}
