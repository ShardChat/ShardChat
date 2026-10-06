// SHARD — one message bubble: theme-aware zinc bubbles, reply quotes,
// over actions with inline quick-reactions, markdown rendering, polls,
// view-once media, ticks and search highlighting.
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CornerUpLeft, Flame, Maximize2, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import type { ChatMessage } from "../../types/chat";
import { formatTime } from "../../lib/utils";
import { AudioPlayer } from "./AudioPlayer";
import { FileMessageCard } from "./FileMessageCard";
import { MessageMarkdown } from "./MessageMarkdown";
import { PollView } from "./PollView";
import { ViewOnceMedia } from "./ViewOnceMedia";

const REACTIONS = ["👍", "❤️", "🔥", "😂", "😮"] as const;

// over actions beside a bubble (reply/react/edit/pin/delete): 28px targets
// with 16px icons — comfortable, messenger-style, right next to the bubble.
const actionBtn =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-secondary transition-all duration-150 hover:bg-black/[0.08] hover:text-heading active:scale-90 dark:hover:bg-white/10";
const actionBtnDanger =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-secondary transition-all duration-150 hover:bg-red-500/10 hover:text-red-600 active:scale-90 dark:hover:text-red-400";
// Touch action bar: 36px targets (hover column stays 28px), no hover styles.
const actionBtnTouch =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-secondary active:scale-90";
const actionBtnDangerTouch =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-red-500/90 active:scale-90 dark:text-red-400/90";

interface MessageBubbleProps {
  message: ChatMessage;
  /** Last in a run from the same sender (kept for future grouping tweaks). */
  isGroupEnd: boolean;
  highlighted: boolean; // active search hit
  dimmed: boolean; // non-matching while a search is active
  onReply: (m: ChatMessage) => void;
  onReact: (id: string, emoji: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string | null) => void;
  onVote: (id: string, optionIndex: number) => void;
  onOpenViewOnce: (id: string) => void;
  onOpenImage: (src: string) => void;
  onJumpTo: (id: string) => void;
}

export function MessageBubble({
  message: m,
  isGroupEnd: _isGroupEnd,
  highlighted,
  dimmed,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onPin,
  onVote,
  onOpenViewOnce,
  onOpenImage,
  onJumpTo,
}: MessageBubbleProps) {
  const mine = m.sender === "self";

  // Touch devices have no hover, so the reply/react/edit column can't be
  // hover-revealed there: a tap on the message toggles a compact action
  // bar under the bubble instead (desktop keeps the hover column).
  const [isTouch] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(hover: none)").matches === true,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  // tap outside the row (or Esc) closes the touch action bar
  useEffect(() => {
    if (!menuOpen || !isTouch) return;
    const close = (e: PointerEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, isTouch]);

  // wrap an action so the touch bar closes right after it runs
  const withClose = (fn: () => void) => () => {
    fn();
    setMenuOpen(false);
  };

  // A tap on the message toggles the touch bar. Media (photos, videos) is
  // excluded from the "keep your own behavior" rule: on phones a tap on a
  // photo/video OPENS THE ACTION BAR first (reactions, reply, delete and an
  // explicit Open button) instead of launching the viewer, otherwise the
  // actions stay unreachable. View-once tiles keep the burn-open gesture.
  const onRowClick = (e: ReactMouseEvent) => {
    if (!isTouch) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-view-once]")) return;
    if (t.closest("button, a, input, textarea, [role='button']") && !t.closest("[data-media-tap]")) return;
    setMenuOpen((v) => !v);
  };

  // bubbles: raised graphite for self / deep graphite for peer in dark;
  // soft near-white for self / pure white for peer in light. A soft shadow
  // + faint ring give both tones quiet depth without shouting.
  const bubbleTone = mine
    ? "bg-zinc-100 text-zinc-900 shadow-sm ring-1 ring-black/[0.04] dark:bg-zinc-800 dark:text-zinc-100 dark:ring-white/[0.05]"
    : "card text-zinc-700 dark:text-zinc-200";
  // are photos and generic attachment cards skip the bubble chrome —
  // the card supplies its own surface (caption included), a wrapper would
  // double-frame it.
  const isBarePhoto =
    (m.body.kind === "image" ||
      (m.body.kind === "file" && (m.body.attachment || m.body.mime.startsWith("image/")))) &&
    !m.body.replyTo;
  // attachment files and voice notes render as self-contained media bubbles.
  const isMediaBubble =
    (m.body.kind === "file" && m.body.attachment) || m.body.kind === "audio";
  const photoRound = mine ? "rounded-2xl rounded-br-md" : "rounded-2xl rounded-bl-md";
  const highlightTone = highlighted
    ? " outline outline-2 outline-emerald-500/70 outline-offset-2 dark:outline-emerald-400/70"
    : dimmed
      ? " opacity-40"
      : "";

  const canEdit = mine && m.body.kind === "text";
  const canPin = m.body.kind === "text" || m.body.kind === "poll";
  // The touch bar shows an explicit Open button for photos (tap-on-photo
  // opens the bar instead of the viewer on touch devices).
  const isImageMsg =
    m.body.kind === "image" || (m.body.kind === "file" && m.body.mime.startsWith("image/"));

  return (
    <div
      ref={rowRef}
      id={`msg-${m.id}`}
      onClick={onRowClick}
      className={`group flex items-center transition-opacity ${mine ? "justify-end" : "justify-start"}${highlightTone}`}
    >
      {/* Hover actions sit right NEXT to the bubble (Telegram-style):
          to the LEFT of self bubbles, to the RIGHT of peer bubbles.
          Quick reactions show inline — no extra smile-button step. */}
      {mine && !isTouch && (
        <div className="flex shrink-0 flex-col items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <div className="card shadow-pop flex gap-1 rounded-full px-2 py-1">
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="text-lg leading-none transition-transform hover:scale-125"
                onClick={() => onReact(m.id, emoji)}
                aria-label={`React ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onReply(m)}
              aria-label="Reply"
              title="Reply"
              className={actionBtn}
            >
              <CornerUpLeft className="h-4 w-4" aria-hidden />
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={() => onEdit(m.id, m.body.kind === "text" ? m.body.text : "")}
                aria-label="Edit"
                title="Edit"
                className={actionBtn}
              >
                <Pencil className="h-4 w-4" aria-hidden />
              </button>
            )}
            {canPin && (
              <button
                type="button"
                onClick={() => onPin(m.id)}
                aria-label="Pin"
                title="Pin"
                className={actionBtn}
              >
                <Pin className="h-4 w-4" aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={() => onDelete(m.id)}
              aria-label="Delete for everyone"
              title="Delete for everyone"
              className={actionBtnDanger}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      )}

      <div className={`relative flex min-w-0 flex-col ${m.body.kind === "poll" ? "max-w-[88%] sm:max-w-[80%]" : "max-w-[80%]"}`}>
        {/* Media bubbles (attachment cards / voice notes) carry their own
            compact surfaces — no extra chrome, timestamp lives inside. */}
        {isMediaBubble ? (
          <div className={mine ? "rounded-br-md" : "rounded-bl-md"}>
            {m.body.replyTo && (
              <button
                type="button"
                onClick={() => onJumpTo(m.body.replyTo!.id)}
                className="mb-1 block rounded-md border-l-2 border-line-strong bg-black/[0.04] px-2 py-1 text-left text-xs text-secondary dark:bg-black/20"
              >
                <span className="block opacity-75">{m.body.replyTo.sender === "self" ? "You" : "Peer"}</span>
                <span className="line-clamp-2">{m.body.replyTo.snippet}</span>
              </button>
            )}
            {m.body.kind === "file" && m.body.attachment && (
              <FileMessageCard
                url={m.body.url}
                name={m.body.name}
                mime={m.body.mime}
                size={m.body.size}
                caption={m.body.caption}
                time={formatTime(m.timestamp)}
                mine={mine}
                mediaTap={isTouch}
              />
            )}
            {m.body.kind === "audio" && (
              <AudioPlayer
                audioBase64={m.body.audioBase64}
                wave={m.body.wave}
                durationMs={m.body.durationMs}
                mine={mine}
              />
            )}
          </div>
        ) : isBarePhoto ? (
          <div data-media-tap className={`overflow-hidden shadow-sm transition-all duration-200 ${photoRound} ${
            m.body.kind === "file" && !m.body.attachment && m.body.caption
              ? "bg-white ring-1 ring-black/[0.08] dark:bg-zinc-900 dark:ring-white/[0.08]"
              : ""
          }`}>
            <PhotoContent
              message={m}
              onOpenImage={onOpenImage}
              onOpenViewOnce={() => onOpenViewOnce(m.id)}
              mine={mine}
              time={formatTime(m.timestamp)}
              mediaTap={isTouch}
            />
          </div>
        ) : (
        <div
          className={`rounded-[20px] px-3.5 py-2.5 transition-all duration-200 ${bubbleTone} ${mine ? "rounded-br-md" : "rounded-bl-md"}`}
        >
          {m.body.replyTo && (
            <button
              type="button"
              onClick={() => onJumpTo(m.body.replyTo!.id)}
              className="mb-1.5 block w-full rounded-md border-l-2 border-line-strong bg-black/[0.04] px-2 py-1 text-left text-xs text-secondary dark:bg-black/20"
            >
              <span className="block opacity-75">{m.body.replyTo.sender === "self" ? "You" : "Peer"}</span>
              <span className="line-clamp-2">{m.body.replyTo.snippet}</span>
            </button>
          )}

          {m.body.kind === "text" && (
            <>
              <MessageMarkdown text={m.body.text} />
              {m.body.edited && <span className="ml-1 align-baseline text-[10px] text-tertiary">(edited)</span>}
            </>
          )}

          {m.body.kind === "image" && <ImageAttachment b64={m.body.imageBase64} onOpenImage={onOpenImage} mediaTap={isTouch} />}

          {m.body.kind === "file" && m.body.caption && m.body.mime.startsWith("image/") && (() => {
            const file = m.body;
            return (
            <div className="-mx-1 -mt-0.5" data-media-tap={isTouch ? true : undefined}>
              {!file.viewOnce && (
                <button
                  type="button"
                  onClick={() => {
                    if (isTouch) return;
                    onOpenImage(file.url);
                  }}
                  className="block w-full"
                >
                  <img
                    src={file.url}
                    alt={file.name}
                    className="max-h-80 w-full cursor-zoom-in rounded-xl object-cover"
                    loading="lazy"
                  />
                </button>
              )}
              {file.viewOnce && (
                <ViewOnceMedia
                  src={file.url}
                  alt={file.name}
                  burned={file.revealedAt === -1}
                  onOpen={() => onOpenViewOnce(m.id)}
                  onBurn={() => onOpenViewOnce(m.id)}
                />
              )}
              <p className="mt-2 whitespace-pre-wrap break-words px-1 pb-0.5 text-[13px] leading-5 text-zinc-800 dark:text-zinc-100">
                {file.caption}
              </p>
            </div>
            );
          })()}

          {m.body.kind === "poll" &&            <PollView body={m.body} onVote={(i) => onVote(m.id, i)} />}

          {m.body.kind === "file" && !m.body.attachment && !(m.body.caption && m.body.mime.startsWith("image/")) && (
            <FileAttachment mediaTap={isTouch}
              body={m.body}
              onOpenImage={onOpenImage}
              onOpenViewOnce={() => onOpenViewOnce(m.id)}
            />
          )}

          {!(m.body.kind === "file" && m.body.attachment) && (
          <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-tertiary">
            {m.body.kind === "file" && m.body.viewOnce && (
              <span className="mr-auto inline-flex items-center gap-0.5 text-orange-600 dark:text-orange-400">
                <Flame className="h-3 w-3" aria-hidden /> view-once
              </span>
            )}
            <span>{formatTime(m.timestamp)}</span>
          </div>
          )}
        </div>
        )}

        {/* Reaction badges under the bubble. */}
        {m.reactions.size > 0 && (
          <div className={`mt-0.5 flex gap-1 ${mine ? "self-end" : "self-start"}`}>
            {[...m.reactions.entries()].map(([emoji, who]) => (
              <button
                key={emoji}
                type="button"
                onClick={() => onReact(m.id, emoji)}
                className="card flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs"
                title={who.length.toString()}
              >
                <span>{emoji}</span>
                <span className="text-[10px] text-tertiary">{who.length}</span>
              </button>
            ))}
          </div>
        )}

        {/* Touch: tap-to-reveal action bar (replaces the hover column). */}
        {isTouch && menuOpen && (
          <div
            className={`card shadow-pop mt-1 flex w-fit max-w-full flex-wrap items-center gap-x-1 gap-y-1 rounded-2xl px-2 py-1.5 ${mine ? "self-end" : "self-start"}`}
          >
            <div className="flex gap-0.5">
              {REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="p-1 text-lg leading-none active:scale-125"
                  onClick={withClose(() => onReact(m.id, emoji))}
                  aria-label={`React ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <span className="mx-0.5 h-5 w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden />
            {isImageMsg && (
              <button
                type="button"
                onClick={withClose(() => {
                  if (m.body.kind === "image") onOpenImage(`data:image;base64,${m.body.imageBase64}`);
                  if (m.body.kind === "file") onOpenImage(m.body.url);
                })}
                aria-label="Open media"
                title="Open"
                className={actionBtnTouch}
              >
                <Maximize2 className="h-4 w-4" aria-hidden />
              </button>
            )}
            <button type="button" onClick={withClose(() => onReply(m))} aria-label="Reply" title="Reply" className={actionBtnTouch}>
              <CornerUpLeft className="h-4 w-4" aria-hidden />
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={withClose(() => onEdit(m.id, m.body.kind === "text" ? m.body.text : ""))}
                aria-label="Edit"
                title="Edit"
                className={actionBtnTouch}
              >
                <Pencil className="h-4 w-4" aria-hidden />
              </button>
            )}
            {canPin && (
              <button type="button" onClick={withClose(() => onPin(m.id))} aria-label="Pin" title="Pin" className={actionBtnTouch}>
                <Pin className="h-4 w-4" aria-hidden />
              </button>
            )}
            {mine && (
              <button
                type="button"
                onClick={withClose(() => onDelete(m.id))}
                aria-label="Delete for everyone"
                title="Delete for everyone"
                className={actionBtnDangerTouch}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Peer actions: outside on the RIGHT, mirrored to self's left side. */}
      {!mine && !isTouch && (
        <div className="flex shrink-0 flex-col items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <div className="card shadow-pop flex gap-1 rounded-full px-2 py-1">
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="text-lg leading-none transition-transform hover:scale-125"
                onClick={() => onReact(m.id, emoji)}
                aria-label={`React ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onReply(m)}
              aria-label="Reply"
              title="Reply"
              className={actionBtn}
            >
              <CornerUpLeft className="h-4 w-4" aria-hidden />
            </button>
            {canPin && (
              <button
                type="button"
                onClick={() => onPin(m.id)}
                aria-label="Pin"
                title="Pin"
                className={actionBtn}
              >
                <Pin className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Shared renderer for photo content (bare or inside a captioned bubble). */
function PhotoContent({
  message: m,
  onOpenImage,
  onOpenViewOnce,
  mine,
  time,
  mediaTap,
}: {
  message: ChatMessage;
  onOpenImage: (src: string) => void;
  onOpenViewOnce: () => void;
  mine: boolean;
  time: string;
  /** Touch: the wrapper row opens the action bar on tap; the viewer
   *  launches only via the bar's Open button, not by tapping the photo. */
  mediaTap: boolean;
}) {
  const body = m.body;
  const stamp = (
    <div
      className={`pointer-events-none absolute bottom-1.5 right-2 flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm`}
    >
      <span>{formatTime(m.timestamp)}</span>
    </div>
  );

  if (body.kind === "image") {
    return (
      <div className="relative">
        <ImageAttachment b64={body.imageBase64} onOpenImage={onOpenImage} rounded mediaTap={mediaTap} />
        {stamp}
      </div>
    );
  }
  if (body.kind === "file") {
    if (body.attachment) {
      return (
        <FileMessageCard
          url={body.url}
          name={body.name}
          mime={body.mime}
          size={body.size}
          caption={body.caption}
          time={time}
          mine={mine}
          mediaTap={mediaTap}
        />
      );
    }
    if (body.viewOnce) {
      return (
        <div className={body.caption ? "bg-white dark:bg-zinc-900" : "relative"}>
          <ViewOnceMedia
            src={body.url}
            alt={body.name}
            burned={body.revealedAt === -1}
            onOpen={onOpenViewOnce}
            onBurn={onOpenViewOnce}
          />
          {body.caption && (
            <>
              <div className="flex justify-end px-3 pt-1">
                <span className="text-[10px] tabular-nums text-tertiary">{time}</span>
              </div>
              <p className="whitespace-pre-wrap break-words px-3.5 pb-2.5 pt-1 text-[13px] leading-5 text-zinc-800 dark:text-zinc-100">
                {body.caption}
              </p>
            </>
          )}
          {!body.caption && stamp}
        </div>
      );
    }
    return (
      <div className={body.caption ? "bg-white dark:bg-zinc-900" : "relative"}>
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              if (mediaTap) return;
              onOpenImage(body.url);
            }}
            aria-disabled={mediaTap || undefined}
            className="block w-full"
          >
            <img
              src={body.url}
              alt={body.name}
              className={`max-h-80 w-64 cursor-zoom-in object-cover ${
                body.caption ? "" : mine ? "rounded-2xl rounded-br-md" : "rounded-2xl rounded-bl-md"
              }`}
              loading="lazy"
            />
          </button>
          {!body.caption && stamp}
        </div>
        {body.caption && (
          <>
            <div className="flex justify-end px-3 pt-1">
              <span className="text-[10px] tabular-nums text-tertiary">{time}</span>
            </div>
            <p className="whitespace-pre-wrap break-words px-3.5 pb-2.5 pt-1 text-[13px] leading-5 text-zinc-800 dark:text-zinc-100">
              {body.caption}
            </p>
          </>
        )}
      </div>
    );
  }
  return null;
}

/** Legacy one-shot image message (pre-chunking): base64 data URL. */
function ImageAttachment({
  b64,
  onOpenImage,
  rounded = false,
  mediaTap = false,
}: {
  b64: string;
  onOpenImage: (src: string) => void;
  rounded?: boolean;
  /** Touch devices: suppress the direct open so the row tap shows the
   *  action bar first; Open then lives inside that bar. */
  mediaTap?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (mediaTap) return;
        onOpenImage(`data:image;base64,${b64}`);
      }}
      aria-disabled={mediaTap || undefined}
    >
      <img
        src={`data:image;base64,${b64}`}
        alt="Image"
        className={`max-h-80 w-64 cursor-zoom-in object-cover ${rounded ? "rounded-2xl" : "rounded-lg"}`}
        loading="lazy"
      />
    </button>
  );
}

/** File message: inline image (or view-once tile) or a download link. */
function FileAttachment({
  body,
  onOpenImage,
  onOpenViewOnce,
  mediaTap = false,
}: {
  body: Extract<ChatMessage["body"], { kind: "file" }>;
  onOpenImage: (src: string) => void;
  onOpenViewOnce: () => void;
  /** Touch: same suppression as ImageAttachment (action bar first). */
  mediaTap?: boolean;
}) {
  if (body.viewOnce) {
    const burned = body.revealedAt === -1;
    if (!body.url && !burned) return null;
    return (
      <ViewOnceMedia
        src={body.url}
        alt={body.name}
        burned={burned}
        onOpen={onOpenViewOnce}
        onBurn={onOpenViewOnce}
      />
    );
  }
  if (body.mime.startsWith("image/")) {
    return (
      <button
        type="button"
        onClick={() => {
          if (mediaTap) return;
          onOpenImage(body.url);
        }}
        aria-disabled={mediaTap || undefined}
      >
        <img src={body.url} alt={body.name} className="max-h-64 rounded-lg object-cover" loading="lazy" />
      </button>
    );
  }
  return (
    <a
      href={body.url}
      download={body.name}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 font-medium text-heading underline decoration-line-strong underline-offset-2 hover:decoration-heading"
    >
      {body.name}
    </a>
  );
}

// re-export so Room can offer an unpin affordance without importing icons twice.
export { PinOff };
