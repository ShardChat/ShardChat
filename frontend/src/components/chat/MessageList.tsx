// SHARD — scrollable message list with smooth bottom pinning, search
// highlighting, chunked-transfer progress bars and the typing indicator.
import { useEffect, useRef } from "react";
import type { ChatMessage, TransferState } from "../../types/chat";
import { MessageBubble } from "./MessageBubble";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";

interface MessageListProps {
  messages: ChatMessage[];
  peerTyping: boolean;
  transfers: TransferState[];
  /** Active search term ("" = no search). */
  search: string;
  /** id of the message currently highlighted as the active search hit. */
  highlightId: string | null;
  /** Messages whose 10s view-once burn has completed → wipe locally. */
  onBurnViewOnce: (id: string) => void;
  onReply: (m: ChatMessage) => void;
  onReact: (id: string, emoji: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string | null) => void;
  onVote: (id: string, optionIndex: number) => void;
  onOpenViewOnce: (id: string) => void;
  onOpenImage: (src: string) => void;
  onJumpTo: (id: string) => void;
  markRead: (id: string) => void;
  /** True while an input-dock panel (emoji / "+") is open above the input. */
  dockPanelsOpen: boolean;
}

function textOf(m: ChatMessage): string {
  return m.body.kind === "text" ? m.body.text : m.body.kind === "poll" ? m.body.question : "";
}

export function MessageList({
  messages,
  peerTyping,
  transfers,
  search,
  highlightId,
  onBurnViewOnce,
  onReply,
  onReact,
  onEdit,
  onDelete,
  onPin,
  onVote,
  onOpenViewOnce,
  onOpenImage,
  onJumpTo,
  markRead,
  dockPanelsOpen,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const markedRef = useRef(new Set<string>());

  // phones: when the on-screen keyboard opens, the visible area shrinks and
  // the newest messages would hide behind it — re-pin to the bottom once
  // (the input dock itself lifts by the same inset, see InputBar).
  const { keyboardActive } = useKeyboardInset();
  const wasKb = useRef(false);
  useEffect(() => {
    if (keyboardActive && !wasKb.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
    wasKb.current = keyboardActive;
  }, [keyboardActive]);

  // smooth pin: scroll to bottom whenever the list or typing state changes.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, peerTyping]);

  // When a dock panel (emoji / plus menu) opens, the input area grows and
  // the scrollport shrinks — re-pin to the bottom so the freshest messages
  // stay visible instead of being clipped by the panel.
  useEffect(() => {
    if (!dockPanelsOpen) return;
    const id = window.setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }, 60);
    return () => window.clearTimeout(id);
  }, [dockPanelsOpen]);

  // peer messages become READ_RECEIPTs once they hit the viewport list.
  useEffect(() => {
    for (const m of messages) {
      if (m.sender === "peer" && !markedRef.current.has(m.id)) {
        markedRef.current.add(m.id);
        markRead(m.id);
      }
    }
  }, [messages, markRead]);

  // view-once burn: when a revealed media's 10s clock expires, the message
  // is wiped from local memory and the DOM (both sides keep their clocks).
  useEffect(() => {
    for (const m of messages) {
      const b = m.body;
      const revealedAt = b.kind === "file" ? b.revealedAt : undefined;
      if (b.kind === "file" && b.viewOnce && typeof revealedAt === "number" && revealedAt > 0) {
        const left = revealedAt + 10_000 - Date.now();
        if (left <= 0) {
          onBurnViewOnce(m.id);
        } else {
          const t = window.setTimeout(() => onBurnViewOnce(m.id), left);
          return () => window.clearTimeout(t);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const q = search.trim().toLowerCase();

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 pt-3 sm:px-4 sm:pt-4"
      style={{ overscrollBehavior: "contain" }}
      aria-live="polite"
    >
      {messages.length === 0 && !peerTyping && transfers.length === 0 && (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-tertiary">No messages yet — the channel is secure, say hello.</p>
        </div>
      )}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-1 sm:px-4">
        {messages.map((m, i) => {
          const isGroupEnd = i === messages.length - 1 || messages[i + 1]!.sender !== m.sender;
          const matches = q.length > 0 && textOf(m).toLowerCase().includes(q);
          return (
            <MessageBubble
              key={m.id}
              message={m}
              isGroupEnd={isGroupEnd}
              highlighted={highlightId === m.id}
              dimmed={q.length > 0 && !matches}
              onReply={onReply}
              onReact={onReact}
              onEdit={onEdit}
              onDelete={onDelete}
              onPin={onPin}
              onVote={onVote}
              onOpenViewOnce={onOpenViewOnce}
              onOpenImage={onOpenImage}
              onJumpTo={onJumpTo}
            />
          );
        })}

        {/* Live chunked-transfer progress bars (upload ↑ / download ↓). */}
        {transfers.map((t) => (
          <div key={t.fileId} className={`flex ${t.direction === "up" ? "justify-end" : "justify-start"}`}>
            <div className="card w-56 rounded-2xl px-3 py-2">
              <div className="mb-1 flex justify-between text-[10px] text-tertiary">
                <span className="truncate">{t.direction === "up" ? "↑" : "↓"} {t.name}</span>
                {/* Before the first byte is encrypted the percentage would sit
                    frozen on 0% and read as "stalled". Name the phase instead. */}
                <span>{t.phase === "prepare" ? "preparing…" : `${Math.round(t.progress * 100)}%`}</span>
              </div>
              <div className="well h-1.5 overflow-hidden rounded-full">
                {t.phase === "prepare" ? (
                  <div className="h-full w-full animate-pulse rounded-full bg-zinc-400/50 dark:bg-zinc-500/50" />
                ) : (
                  <div
                    className="h-full rounded-full bg-zinc-500 transition-all duration-150 dark:bg-zinc-400"
                    style={{ width: `${t.progress * 100}%` }}
                  />
                )}
              </div>
            </div>
          </div>
        ))}

        {peerTyping && (
          <div className="flex items-center gap-1.5 pl-9" aria-label="Peer is typing">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-600"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
            <span className="ml-1 text-xs text-tertiary">typing…</span>
          </div>
        )}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
