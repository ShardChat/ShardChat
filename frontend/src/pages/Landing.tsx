// SHARD — presentation landing. Institutional minimalism in light and dark:
// theme-aware tokens (.page-grid,.card), white pill CTA (black in light
// mode per Apple minimalist light), zero neon or gradient ornaments.
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight, ChevronDown,
  Zap,
} from "lucide-react";
import { CrystalLogo } from "../components/CrystalLogo";
import {
  DiscordIcon, SignalIcon, TelegramIcon, WhatsAppIcon,
} from "../components/MessengerIcons";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";
import { navigate } from "../App";

const FAQS = [
  {
    q: "How private is a SHARD session?",
    a: "Completely. Every session runs Hybrid Post-Quantum E2EE (NIST ML-KEM-768 / Kyber + ECDH P-256 + AES-GCM-256). The classical handshake is computed by the native Web Crypto API, the post-quantum KEM by an audited pure-JS library — and the server still acts as a blind relay with zero mathematical ability to decrypt your data.",
  },
  {
    q: "Where are my messages and files stored?",
    a: "Exclusively in active, volatile browser memory (RAM). No application-level IP addresses, message payloads, or files are ever logged or stored.",
  },
  {
    q: "What happens when a session expires or burns?",
    a: "Destruction is immediate and unrecoverable. Active memory references are wiped, sockets are severed, and cryptographic keys are discarded. Forensic recovery is mathematically and practically impossible.",
  },
  {
    q: "How do I know the connection is authentic?",
    a: "Both participants see an identical 4-emoji safety fingerprint derived from the combined hybrid secret (ECDH ‖ ML-KEM). If the emojis match, no man-in-the-middle holds your session key.",
  },
  {
    q: "Can a third person join the room?",
    a: "No. Every channel enforces an atomic two-peer capacity gate. Any subsequent connection attempt is rejected at the protocol level with HTTP 403.",
  },
  {
    q: "How do voice notes, files, and calls work?",
    a: "Files are encrypted and streamed in 64 KB chunks to preserve server memory, while voice notes are sealed in a single encrypted envelope. Audio and video media streams directly peer-to-peer via WebRTC, while signaling is coordinated blindly through your private session relay.",
  },
];

const FEATURES = [
  {
    chip: "Privacy",
    t: "Server sees nothing",
    d: "All messages and files are sealed directly in your browser. Relay operators only ever see opaque ciphertext and hold zero decryption keys.",
    meta: "Hybrid PQ E2EE · always",
  },
  {
    chip: "Storage",
    t: "Zero database footprint",
    d: "Nothing is ever written to disk. The moment you close the tab or the timer expires, the entire session is permanently purged from RAM.",
    meta: "RAM-only · 0 on disk",
  },
  {
    chip: "Access",
    t: "Strictly two participants",
    d: "Rooms atomically lock once both peers connect. Unauthorized third parties are rejected at the gateway level with HTTP 403.",
    meta: "Exactly 2 participants",
  },
] as const;

const STEPS = [
  {
    chip: "Step 01",
    title: "Initialize session",
    text: "Generate an encrypted one-time link with a custom self-destruct timer. No phone numbers, passwords, or emails required.",
    meta: "One link · no sign-up",
  },
  {
    chip: "Step 02",
    title: "Verify safety code",
    text: "Compare the deterministic 4-emoji safety fingerprint with your peer to mathematically guarantee zero eavesdropping.",
    meta: "Channel verification",
  },
  {
    chip: "Step 03",
    title: "Communicate & vanish",
    text: "Exchange text, stream files, or start P2P audio/video calls. The second you close the browser tab, all data ceases to exist.",
    meta: "Zero trace",
  },
] as const;

/** Trust badges under the hero CTA. */
const BADGES = ["100% Open Source (AGPLv3)", "Zero Telemetry", "Hybrid Post-Quantum E2EE"] as const;

// retention-comparison chart: how far each messenger sits from "zero kept".
// pct is a position on the shared time axis; the axis itself is inset from
// the card edge so every value label fits right after its bar.
// Official brand colors keep the marks instantly recognizable; bars stay
// short enough that the full labels never clip on the right. Each label names
// the E2EE status honestly rather than implying an unencrypted channel.
const COMPANIES = [
  { Icon: SignalIcon, name: "Signal", pct: 12, value: "Phone number & metadata logged", iconClass: "text-[#3A76F0]" },
  { Icon: WhatsAppIcon, name: "WhatsApp", pct: 28, value: "E2EE · Metadata & cloud backups (Years)", iconClass: "text-[#25D366]" },
  { Icon: TelegramIcon, name: "Telegram", pct: 45, value: "Indefinite cloud storage (Default cloud chats)", iconClass: "text-[#24A1DE]" },
  { Icon: DiscordIcon, name: "Discord", pct: 55, value: "Permanent archive · No E2EE", iconClass: "text-[#5865F2]" },
] as const;

/** Fire-once IntersectionObserver hook for scroll-triggered reveals. */
function useInView<T extends HTMLElement>(threshold = 0.25) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, inView };
}

/** Primary action: white pill on dark canvas, black pill in light mode. */
function PrimaryButton({
  onClick,
  children,
  className = "",
}: {
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-center gap-2.5 rounded-full bg-white px-6 py-3 font-medium text-black transition-all duration-200 hover:bg-zinc-200 active:scale-[0.98] dark:bg-white dark:text-black dark:hover:bg-zinc-200 light:bg-black light:text-white light:hover:bg-zinc-800 ${className}`}
    >
      {children}
    </button>
  );
}

export default function Landing() {
  // hash link from another route (e.g. /donate) lands here with
  // "/#section" in the URL — scroll to the section once it has mounted.
  useEffect(() => {
    if (!window.location.hash) return;
    const t = window.setTimeout(() => {
      document
        .querySelector(window.location.hash)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="page-bg min-h-full text-secondary transition-colors duration-200">
      {/* Fading dot grid: barely visible gray in light, soft white in dark. */}
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

      {/* ============ HERO: strict, clean ============ */}
      <section className="safe-px mx-auto flex max-w-4xl flex-col items-center px-6 pb-24 pt-28 text-center sm:pb-32 sm:pt-44">
        <h1 className="text-balance text-4xl font-semibold tracking-tight text-heading sm:text-5xl lg:text-7xl">
          Private conversations
          <br />
          that <span className="text-lead">vanish without a trace</span>.
        </h1>
        <p className="mt-7 max-w-2xl text-balance text-base leading-relaxed text-secondary sm:text-lg">
          A zero-knowledge, ephemeral communications relay. No accounts, no database, and zero disk
          footprint — sessions exist purely in volatile memory.
        </p>

        <PrimaryButton onClick={() => navigate("/new")} className="mt-10">
          <Zap className="h-5 w-5" aria-hidden />
          Start a private session
        </PrimaryButton>
        <p className="mt-4 text-xs text-tertiary">No sign-up required</p>

        {/* Trust badges: stacked on phones, inline from sm up. The separator
            lives inside its item and is hidden on mobile, so a narrow screen
            can never start a line with a dangling bullet. */}
        <ul className="mt-8 flex flex-col items-center gap-2 text-xs text-tertiary sm:flex-row sm:flex-wrap sm:justify-center sm:gap-x-3 sm:gap-y-2">
          {BADGES.map((b, i) => (
            <li key={b} className="flex items-center gap-3">
              {i > 0 && (
                <span aria-hidden className="hidden sm:inline">
                  •
                </span>
              )}
              <span>
                <span aria-hidden>✓</span> {b}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ============ WHY SAFE ============ */}
      <section id="architecture" className="mx-auto max-w-5xl scroll-mt-24 px-6 pb-28">
        <h2 className="mb-12 text-center text-3xl font-semibold tracking-tight text-heading sm:text-4xl">
          Why it's secure
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <PremiumCard key={f.t} chip={f.chip} title={f.t} text={f.d} meta={f.meta} />
          ))}
        </div>
      </section>

      {/* ============ DIGITAL FOOTPRINT COMPARISON ============ */}
      <section className="mx-auto max-w-5xl scroll-mt-24 px-6 pb-28">
        <h2 className="text-center text-3xl font-bold tracking-tight text-heading sm:text-4xl">
          Digital footprint on servers
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-balance text-center text-sm text-secondary sm:text-base">
          Everyday messengers are built to remember. SHARD is built to forget. See the difference in
          digital footprint when transmitting sensitive data.
        </p>
        <StorageChart />
      </section>

      {/* ============ HOW IT WORKS ============ */}
      <section id="security" className="mx-auto max-w-5xl scroll-mt-24 px-6 pb-28">
        <h2 className="mb-12 text-center text-3xl font-semibold tracking-tight text-heading sm:text-4xl">
          How it works
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <PremiumCard key={s.title} chip={s.chip} title={s.title} text={s.text} meta={s.meta} />
          ))}
        </div>
        <div className="mt-12 flex justify-center">
          <PrimaryButton onClick={() => navigate("/new")}>
            Start a private session
            <ArrowRight className="h-5 w-5" aria-hidden />
          </PrimaryButton>
        </div>
      </section>

      {/* ============ FAQS ============ */}
      <section id="faq" className="mx-auto max-w-3xl scroll-mt-24 px-6 pb-32">
        <h2 className="mb-12 text-center text-3xl font-semibold tracking-tight text-heading sm:text-4xl">
          FAQs
        </h2>
        <div className="flex flex-col">
          {FAQS.map((f, i) => (
            <FaqItem key={i} index={i + 1} q={f.q} a={f.a} />
          ))}
        </div>
      </section>

      {/* ============ FOOTER: shared compact bar ============ */}
      <Footer />
    </div>
  );
}

/** Retention comparison card: white in light mode, matte dark block in
 * dark; one glowing emerald tick for SHARD, brand-colored marks, and red
 * gradient retention bars for everyone else. Bar widths reveal smoothly
 * once the card scrolls in.
 * Phone layout stacks each row (name → verdict → bar) because the labels are
 * longer than the widest narrow viewport; `sm:` folds the bar back inline with
 * the label. Every row's bar still starts at the same x, so the shared
 * time axis stays comparable at both sizes. */
function StorageChart() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  return (
    <div
      ref={ref}
      className="mx-auto my-12 max-w-3xl rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm backdrop-blur-md transition-colors duration-300 sm:p-8 dark:border-zinc-800 dark:bg-zinc-900/60 dark:shadow-none"
    >
      {/* SHARD row — zero retention: a glowing emerald tick, not a bar. */}
      <div className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex items-center gap-2.5 sm:w-36 sm:shrink-0">
          <CrystalLogo className="h-5 w-5 shrink-0" />
          <span className="text-sm font-semibold text-zinc-900 dark:text-white">SHARD</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span
            className={`h-6 w-[3px] shrink-0 rounded-full bg-emerald-400 shadow-[0_0_15px_rgba(52,211,153,0.8)] transition-opacity duration-700 ${inView ? "opacity-100" : "opacity-0"}`}
          />
          <span
            className={`whitespace-nowrap font-mono text-sm font-medium text-emerald-600 transition-all duration-700 dark:text-emerald-400 ${inView ? "translate-x-0 opacity-100" : "-translate-x-2 opacity-0"}`}
          >
            0 bytes · 0 days
          </span>
        </div>
      </div>

      {/* Competitors: red gradient retention bars, revealed on scroll. */}
      {COMPANIES.map((c) => (
        <div key={c.name} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex items-center gap-2.5 sm:w-36 sm:shrink-0">
            <c.Icon className={`h-5 w-5 shrink-0 ${c.iconClass}`} />
            <span className="text-sm text-zinc-800 dark:text-zinc-200">{c.name}</span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
            <span className="order-1 min-w-0 font-mono text-xs leading-snug text-zinc-500 sm:order-2 sm:shrink-0 sm:whitespace-nowrap dark:text-zinc-400">
              {c.value}
            </span>
            <div
              className="order-2 h-2 shrink-0 rounded-r-full bg-gradient-to-r from-red-700/80 to-red-500 transition-[width] duration-1000 ease-out sm:order-1 sm:h-6 dark:from-red-950/40 dark:to-red-500/80"
              style={{ width: inView ? `${c.pct}%` : "0%" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Restrained surface card: hairline border, soft shadow in light mode,
 * matte graphite in dark. */
function PremiumCard({
  chip,
  title,
  text,
  meta,
}: {
  chip: string;
  title: string;
  text: string;
  meta: string;
}) {
  return (
    <div className="card card-hover group flex min-h-[15rem] flex-col rounded-2xl p-6 transition-colors duration-200">
      <span className="well mb-5 w-fit rounded-full px-2.5 py-1 text-[11px] font-medium text-secondary">
        {chip}
      </span>
      <h3 className="mb-3 text-balance text-xl font-semibold leading-snug text-heading">{title}</h3>
      <p className="text-pretty text-sm leading-relaxed text-secondary">{text}</p>
      <div className="mt-auto flex items-center justify-between pt-6 text-[11px] text-tertiary">
        <span>{meta}</span>
        <ArrowRight className="h-4 w-4 -rotate-45 text-tertiary transition-colors duration-200 group-hover:text-heading" aria-hidden />
      </div>
    </div>
  );
}

function FaqItem({ index, q, a }: { index: number; q: string; a: string }) {
  const [open, setOpen] = useState(index === 1);
  return (
    <div className="line-b">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-6 py-5 text-left transition-colors duration-200 hover:text-heading active:scale-[0.99]"
      >
        <span className="font-mono text-xs text-tertiary">{String(index).padStart(2, "0")}</span>
        <span className="flex-1 text-pretty text-base font-medium text-secondary">{q}</span>
        <ChevronDown className={`h-4 w-4 text-tertiary transition-transform duration-300 ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className="mb-5 ml-10 border-l-2 border-line pl-4">
          <p className="text-pretty text-sm leading-relaxed text-secondary">{a}</p>
        </div>
      )}
    </div>
  );
}
