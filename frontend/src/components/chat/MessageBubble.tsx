// SHARD — one message bubble: theme-aware zinc bubbles, reply quotes,
// over actions with inline quick-reactions, markdown rendering, polls,
// view-once media, ticks and search highlighting.
import { useRef } from "react";
import { CornerUpLeft, Flame, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
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

  // (Reaction quick-bar needs no outside-click handling: it lives and dies
  // with the row hover, so there is no open state to manage.)
  const reactWrapRef = useRef<HTMLDivElement>(null);

  return (
    <div
      id={`msg-${m.id}`}
      className={`group flex items-center transition-opacity ${mine ? "justify-end" : "justify-start"}${highlightTone}`}
    >
      {/* Hover actions sit right NEXT to the bubble (Telegram-style):
          to the LEFT of self bubbles, to the RIGHT of peer bubbles.
          Quick reactions show inline — no extra smile-button step. */}
      {mine && (
        <div ref={reactWrapRef} className="touch-visible flex shrink-0 flex-col items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
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

      <div className="relative flex min-w-0 max-w-[80%] flex-col">
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
          <div className={`overflow-hidden shadow-sm transition-all duration-200 ${photoRound} ${
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

          {m.body.kind === "image" && <ImageAttachment b64={m.body.imageBase64} onOpenImage={onOpenImage} />}

          {m.body.kind === "file" && m.body.caption && m.body.mime.startsWith("image/") && (() => {
            const file = m.body;
            return (
            <div className="-mx-1 -mt-0.5">
              {!file.viewOnce && (
                <button type="button" onClick={() => onOpenImage(file.url)} className="block w-full">
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
            <FileAttachment
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
      </div>

      {/* Peer actions: outside on the RIGHT, mirrored to self's left side. */}
      {!mine && (
        <div ref={reactWrapRef} className="touch-visible flex shrink-0 flex-col items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
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
}: {
  message: ChatMessage;
  onOpenImage: (src: string) => void;
  onOpenViewOnce: () => void;
  mine: boolean;
  time: string;
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
        <ImageAttachment b64={body.imageBase64} onOpenImage={onOpenImage} rounded />
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
          <button type="button" onClick={() => onOpenImage(body.url)} className="block w-full">
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
}: {
  b64: string;
  onOpenImage: (src: string) => void;
  rounded?: boolean;
}) {
  return (
    <button type="button" onClick={() => onOpenImage(`data:image;base64,${b64}`)}>
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
}: {
  body: Extract<ChatMessage["body"], { kind: "file" }>;
  onOpenImage: (src: string) => void;
  onOpenViewOnce: () => void;
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
      <button type="button" onClick={() => onOpenImage(body.url)}>
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
