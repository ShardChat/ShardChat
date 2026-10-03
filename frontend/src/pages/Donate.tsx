// SHARD — donation page (/donate): strict Apple/OpenAI monochrome in light
// and dark. Hero mission, three transparency cards, an interactive crypto
// terminal (segmented tabs → network pill → QR → copy address), and
// on-financial ways to help. Wallet addresses live in../config/donate.
import { useEffect, useRef, useState } from "react";
import {
  Check, Code, Copy, Heart, Server, Share2, Shield, Star, TriangleAlert,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import { DONATE_WALLETS, GITHUB_URL, type DonationWallet } from "../config/donate";

const TRANSPARENCY = [
  {
    icon: Shield,
    title: "0% Tracking",
    text: "We never sell data, serve ads, or embed trackers.",
  },
  {
    icon: Server,
    title: "Direct Server Costs",
    text: "100% of funds go towards hosting, TURN relays, and domains.",
  },
  {
    icon: Code,
    title: "100% Open Source",
    text: "The entire codebase is free, public, and licensed under AGPLv3.",
  },
] as const;

export default function Donate() {
  const [walletId, setWalletId] = useState(DONATE_WALLETS[0].id);
  const wallet = DONATE_WALLETS.find((w) => w.id === walletId) ?? DONATE_WALLETS[0];

  return (
    <div className="page-bg flex min-h-full flex-col text-secondary transition-colors duration-200">
      {/* Fading dot grid, same as the landing page. */}
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

      {/* ============ PAGE: centered column ============ */}
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-20 pt-28 text-center">
        {/* ---- Hero: mission ---- */}
        <span className="well inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-secondary">
          <span className="h-1.5 w-1.5 rounded-full bg-line-strong" aria-hidden />
          100% Free &amp; Open Source
        </span>

        <h1 className="mt-6 text-4xl font-bold tracking-tight text-zinc-900 dark:text-white lg:text-5xl">
          Support Independent Privacy.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-zinc-600 dark:text-zinc-400">
          SHARD operates with zero ads, zero investor surveillance, and zero data
          monetization. Every contribution directly funds relay server uptime, domain
          maintenance, and open-source development.
        </p>

        {/* ---- Transparency: three compact cards ---- */}
        <div className="my-8 grid grid-cols-1 gap-4 text-left md:grid-cols-3">
          {TRANSPARENCY.map((t) => (
            <div key={t.title} className="card rounded-2xl p-5">
              <span className="well mb-3 flex h-9 w-9 items-center justify-center rounded-xl text-tertiary">
                <t.icon className="h-4 w-4" aria-hidden />
              </span>
              <h3 className="text-sm font-semibold text-heading">{t.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-secondary">{t.text}</p>
            </div>
          ))}
        </div>

        {/* ---- Crypto terminal ---- */}
        <section
          aria-label="Crypto donation terminal"
          className="my-8 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60 md:p-8"
        >
          {/* Segmented tabs */}
          <div
            role="tablist"
            aria-label="Choose a cryptocurrency"
            className="mx-auto flex w-fit max-w-full flex-wrap justify-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-800 dark:bg-zinc-900/60"
          >
            {DONATE_WALLETS.map((w) => (
              <button
                key={w.id}
                type="button"
                role="tab"
                aria-selected={walletId === w.id}
                onClick={() => setWalletId(w.id)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-all duration-200 ${
                  walletId === w.id
                    ? "bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
                }`}
              >
                {w.tab}
              </button>
            ))}
          </div>

          {/* Active wallet panel — remounts per wallet so copy state resets. */}
          <WalletPanel key={wallet.id} wallet={wallet} />
        </section>

        {/* ---- Non-financial support ---- */}
        <section aria-label="Other ways to support SHARD" className="my-8">
          <h2 className="text-lg font-semibold text-heading">Other ways to support SHARD</h2>
          <div className="mt-4 grid gap-4 text-left md:grid-cols-2">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="card card-hover group flex items-start gap-4 rounded-2xl p-5 transition-colors duration-200"
            >
              <span className="well flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-tertiary transition-colors duration-200 group-hover:text-heading">
                <Star className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-heading">Star on GitHub</span>
                <span className="mt-1 block text-sm leading-relaxed text-secondary">
                  A star costs nothing and helps other people find the project.
                </span>
              </span>
            </a>
            <div className="card flex items-start gap-4 rounded-2xl p-5">
              <span className="well flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-tertiary">
                <Share2 className="h-4 w-4" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-heading">Spread the Word</span>
                <span className="mt-1 block text-sm leading-relaxed text-secondary">
                  Share SHARD with colleagues and friends who value private conversations.
                </span>
              </span>
            </div>
          </div>
        </section>

        <p className="pt-4 text-xs text-tertiary">
          <Heart className="mr-1 inline h-3 w-3" aria-hidden />
          Thank you for keeping SHARD independent.
        </p>
      </main>

      <Footer />
    </div>
  );
}

/** Active-tab content: network warning pill, QR on a clean tile, and the
 * address with a copy button that flips to "Copied!" for two seconds. */
function WalletPanel({ wallet }: { wallet: DonationWallet }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(wallet.address);
    } catch {
      // clipboard API denied (or missing): fall back to a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = wallet.address;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      {/* Network pill — the one thing that must not be missed. */}
      <div className="mt-6 flex justify-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-zinc-100 px-4 py-1.5 text-sm font-semibold text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
          <TriangleAlert className="h-4 w-4" aria-hidden />
          {wallet.network}
        </span>
      </div>

      {/* QR on a clean white tile in both themes: maximum scanner safety. */}
      <div className="mt-6 flex justify-center">
        <div className="rounded-2xl bg-white p-4 ring-1 ring-zinc-200 dark:ring-zinc-700/60">
          <QRCodeSVG
            value={wallet.address}
            size={168}
            marginSize={2}
            bgColor="#ffffff"
            fgColor="#09090b"
            level="H"
            imageSettings={{
              src: "/logo.png", // SHARD crystal, centered; level H keeps it scannable
              height: 38,
              width: 38,
              excavate: true,
            }}
            title={`${wallet.tab} donation address QR code`}
          />
        </div>
      </div>

      {/* Address + copy */}
      <div className="mx-auto mt-6 flex max-w-xl flex-col items-stretch gap-2 sm:flex-row">
        <code className="well min-w-0 flex-1 break-all rounded-xl px-4 py-3 text-left font-mono text-[13px] leading-relaxed text-heading">
          {wallet.address}
        </code>
        <button
          type="button"
          onClick={copyAddress}
          className={`flex shrink-0 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition-all duration-200 active:scale-[0.98] ${
            copied
              ? "bg-emerald-500 text-white dark:bg-emerald-500 dark:text-white"
              : "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          }`}
        >
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copied ? "Copied!" : "Copy Address"}
        </button>
      </div>

      <p className="mt-4 text-xs text-tertiary">
        Send only {wallet.tab.split(" ")[0]} on this network — any other asset will be lost.
      </p>
    </div>
  );
}
