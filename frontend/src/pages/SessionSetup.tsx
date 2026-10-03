// SHARD — focused session setup (/new): a two-column Session Hub in light
// and dark. Left: status, TTL segmented control, link field, enter CTA.
// Right: QR digital pass card - strict code on a sunken tile, no glows.
import { useState } from "react";
import {
  Check, Copy, LoaderCircle, Lock, LogIn, QrCode,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { navigate } from "../App";
import { api } from "../lib/endpoints";
import { TTL_OPTIONS, type CreateRoomResponse } from "../types/protocol";
import Navbar from "../components/Navbar";
import Footer from "../components/Footer";

type Phase =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "created"; room: CreateRoomResponse }
  | { kind: "error"; message: string };

export default function SessionSetup() {
  const [ttl, setTtl] = useState<number>(TTL_OPTIONS[0].minutes);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  const room = phase.kind === "created" ? phase.room : null;
  const link = room ? `${window.location.origin}/room/${encodeURIComponent(room.roomId)}` : "";

  async function createSession() {
    setPhase({ kind: "creating" });
    try {
      const res = await fetch(api("/api/rooms"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlMinutes: ttl }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Server responded ${res.status}`);
      }
      const created = (await res.json()) as CreateRoomResponse;
      setPhase({ kind: "created", room: created });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
    // clipboard denied: the input stays selectable.
    }
  }

  return (
    <div className="page-bg flex min-h-full flex-col text-secondary transition-colors duration-200">
      {/* ============ NAVBAR: shared across pages ============ */}
      <Navbar />

      {/* ============ SESSION HUB: two columns ============ */}
      <main className="mx-auto grid w-full max-w-4xl flex-1 grid-cols-1 items-center gap-8 px-6 pb-16 pt-28 md:grid-cols-12">
        {/* ---- LEFT: control & links ---- */}
        <section className="md:col-span-7">
          <span className="card mb-5 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-secondary">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500 dark:bg-emerald-400" />
            Session ready to join
          </span>

          <h1 className="text-3xl font-semibold tracking-tight text-heading">Share access</h1>
          <p className="mt-2.5 text-sm leading-relaxed text-secondary">
            Send the link or show the QR code to your peer. The channel locks as soon as you both
            join.
          </p>

          {/* TTL segmented control: framed track, active segment gets a raised
              surface with heading text. Locked once the session exists. */}
          <fieldset className="mt-8">
            <legend className="mb-2 text-xs font-medium uppercase tracking-wider text-tertiary">
              Burn time
            </legend>
            <div
              role="radiogroup"
              aria-label="Burn time"
              aria-disabled={!!room}
              className={`well relative grid max-w-sm grid-cols-3 rounded-xl p-1 ${room ? "opacity-60" : ""}`}
            >
              {/* sliding thumb: raised surface, heading text on top */}
              <span
                aria-hidden
                className="card absolute inset-y-1 left-1 rounded-lg transition-transform duration-300 ease-out"
                style={{
                  width: "calc((100% - 8px) / 3)",
                  transform: `translateX(${TTL_OPTIONS.findIndex((o) => o.minutes === ttl) * 100}%)`,
                }}
              />
              {TTL_OPTIONS.map((opt) => (
                <button
                  key={opt.minutes}
                  type="button"
                  role="radio"
                  aria-checked={ttl === opt.minutes}
                  disabled={!!room}
                  onClick={() => setTtl(opt.minutes)}
                  className={`relative z-10 rounded-lg px-2 py-2 text-sm transition-colors duration-200 ${
                    ttl === opt.minutes ? "font-semibold text-heading" : "text-secondary hover:text-heading"
                  } ${room ? "cursor-not-allowed" : ""}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {room && (
              <p className="mt-2 text-[11px] text-tertiary">
                The lifetime is fixed the moment the session is created.
              </p>
            )}
          </fieldset>

          {/* Link field + copy */}
          <div className="mt-8">
            <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-tertiary">
              Invite link
            </label>
            {room ? (
              <div className="flex gap-2">
                <input
                  readOnly
                  value={link}
                  onFocus={(e) => e.currentTarget.select()}
                  className="card min-w-0 flex-1 rounded-xl px-4 py-3 font-mono text-sm text-heading focus:border-line-strong focus:outline-none"
                />
                <button
                  type="button"
                  onClick={copyLink}
                  className={`card card-hover flex shrink-0 items-center gap-1.5 rounded-xl px-4 py-3 text-sm font-medium transition-colors duration-200 active:scale-95 ${
                    copied ? "text-secondary" : "text-heading"
                  }`}
                >
                  {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
            ) : (
              <div className="well flex items-center rounded-xl border-dashed px-4 py-3 font-mono text-sm text-tertiary">
                the link appears after creation…
              </div>
            )}
          </div>

          {/* Create / Enter CTA */}
          <div className="mt-8">
            {!room && (
              <button
                type="button"
                onClick={createSession}
                disabled={phase.kind === "creating"}
                className="flex w-full max-w-sm items-center justify-center gap-2.5 rounded-full bg-black px-6 py-3 font-medium text-white transition-all duration-200 hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              >
                {phase.kind === "creating" ? (
                  <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden />
                ) : (
                  <Lock className="h-5 w-5" aria-hidden />
                )}
                {phase.kind === "creating" ? "Initializing…" : "Create session"}
              </button>
            )}

            {room && (
              <button
                type="button"
                onClick={() => navigate(`/room/${room.roomId}`)}
                className="flex w-full max-w-sm items-center justify-center gap-2.5 rounded-full bg-black px-6 py-3 font-medium text-white transition-all duration-200 hover:bg-zinc-800 active:scale-[0.98] sm:w-auto dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              >
                Enter session
                <LogIn className="h-5 w-5" aria-hidden />
              </button>
            )}

            {phase.kind === "error" && (
              <p role="alert" className="card mt-3 rounded-lg px-3 py-2 text-sm text-red-600 dark:text-red-400">
                {phase.message}
              </p>
            )}
          </div>
        </section>

        {/* ---- RIGHT: QR digital pass ---- */}
        <section className="md:col-span-5">
          <div className="card flex flex-col items-center rounded-3xl p-6">
            <div className="mb-4 flex items-center gap-2 self-start text-xs font-medium uppercase tracking-wider text-tertiary">
              <QrCode className="h-3.5 w-3.5" aria-hidden />
              QR pass
            </div>

            {room ? (
              <>
                {/* Strict QR: black modules on white in light mode, white on
                    deep graphite in dark — crisp scan contrast either way. */}
                <div className="well rounded-2xl p-5">
                  <QRCodeSVG
                    value={link}
                    size={190}
                    fgColor="currentColor"
                    bgColor="transparent"
                    level="H"
                    imageSettings={{
                      src: "/logo.png", // SHARD crystal, centered; level H keeps it scannable
                      height: 38,
                      width: 38,
                      excavate: true,
                    }}
                    className="text-zinc-950 dark:text-zinc-50"
                  />
                </div>
                <p className="mt-5 text-xs text-secondary">
                  Point a phone camera at it
                </p>
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
                  Ready to scan
                </p>
              </>
            ) : (
              /* Idle placeholder: keeps the card composition before create */
              <div className="well flex h-[240px] w-[220px] flex-col items-center justify-center gap-3 rounded-2xl border-dashed">
                <QrCode className="h-10 w-10 text-tertiary" aria-hidden />
                <p className="max-w-[150px] text-center text-xs leading-relaxed text-tertiary">
                  Create a session to get your QR pass
                </p>
              </div>
            )}
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
