// SHARD — the input dock: a floating messenger-style capsule that sits
// directly on the chat background (no separate footer section, no divider).
// tools are tucked into a compact "+" menu, emoji lives inside the pill,
// mic/send occupy the right end — one calm row instead of a button strip.
import { useEffect, useRef, useState } from "react";
import { BarChart3, Flame, Pencil, Paperclip, Plus, Reply, Send, Smile, X } from "lucide-react";
import type { ChatMessage } from "../../types/chat";
import { randomId } from "../../lib/utils";
import { checkFile } from "../../lib/fileSecurity";
import { categorize } from "./FileMessageCard";
import { EmojiPicker } from "./EmojiPicker";
import { VoiceRecorder } from "./VoiceRecorder";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";

interface InputBarProps {
  disabled: boolean;
  replyTo: ChatMessage | null;
  /** Present when the dock is in "edit last message" mode. */
  editing: ChatMessage | null;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onSendText: (text: string) => void;
  onEditDone: (id: string, text: string) => void;
  /** Room escalates the whole dock state: queued photos + optional caption. */
  onSendQueue: (items: Array<{ file: File; viewOnce: boolean }>, caption: string) => void;
  /** Generic attachments (docs/archives/media) go out one by one. Caption rides the last file. */
  onSendAttachment: (file: File, caption?: string) => void;
  /** Surfaces quiet security-guard rejections as a short toast. */
  onSecurityNotice?: (reason: string) => void;
  onSendAudio: (r: { blob: Blob; wave: number[]; durationMs: number }) => void;
  onSendPoll: (question: string, options: string[]) => void;
  onTyping: () => void;
  /** ArrowUp with an empty input: start editing the last self message. */
  onEditLast?: () => void;
  /** Notifies the room when any dock panel opens/closes (list re-pins). */
  onPanelsOpenChange?: (open: boolean) => void;
  /** Hands the parent a hook to push dropped photos straight into the queue. */
  registerAddToQueue?: (fn: (files: File[]) => void) => void;
}

const MAX_ROWS = 5;
/** Hard cap of the photo queue above the input. */
const MAX_QUEUE = 10;

const QUEUE_KIND: Record<string, string> = {
  video: "Video",
  audio: "Audio",
  code: "Code",
  doc: "File",
  archive: "Archive",
  pdf: "PDF",
  sheet: "Spreadsheet",
  slides: "Presentation",
};

/** One pending attachment in the queue above the input pill. */
interface QueueItem {
  id: string;
  file: File;
  url: string; // blob: preview URL (images) or object URL, revoked on removal
  viewOnce: boolean; // burns 10s after the peer opens it (photos only)
  kind: "image" | "file"; // images get thumbnails, files get matte cards
}

// shared look for the dock's round icon buttons: ghost by default, with
// press feedback and a visible keyboard-focus ring.
const iconBtn =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-tertiary transition-all duration-150 hover:bg-black/[0.06] hover:text-heading active:scale-90 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-strong dark:hover:bg-white/10";

// Same geometry for toggled-on buttons (accent colors are appended at the
// all site), minus the ghost hover colors so the accent survives hover.
const iconBtnActive =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all duration-150 active:scale-90 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-strong";

/** One row of the "+" popover menu. */
function MenuItem({
  icon: Icon,
  label,
  hint,
  accent,
  disabled,
  onClick,
}: {
  icon: typeof Paperclip;
  label: string;
  hint?: string;
  accent?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-secondary transition-colors hover:bg-black/[0.06] hover:text-heading disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-white/10"
    >
      <Icon
        className={`h-4 w-4 shrink-0 ${accent ? "text-orange-600 dark:text-orange-400" : "text-tertiary"}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block leading-4">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-3.5 text-tertiary">{hint}</span>}
      </span>
    </button>
  );
}

export function InputBar({
  disabled,
  replyTo,
  editing,
  onCancelReply,
  onCancelEdit,
  onSendText,
  onSendQueue,
  onSendAttachment,
  onSecurityNotice,
  onEditDone,
  onSendAudio,
  onSendPoll,
  onTyping,
  onEditLast,
  onPanelsOpenChange,
  registerAddToQueue,
}: InputBarProps) {
  const [text, setText] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  /** Photo queue waiting to be sent (thumbnails above the input). */
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  /** What the hidden file picker was opened for: plain photo or view-once. */
  const pickIntentRef = useRef<"photo" | "once">("photo");
  const plusWrapRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // mirrors the queue for capacity checks and unmount cleanup.
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const isEditing = !!editing;

  // On phones the on-screen keyboard must never cover the composer: the
  // dock lifts itself by the measured keyboard height (mainstream-
  // messenger behavior; a no-op on desktop where the inset is always 0).
  const { keyboardInset, keyboardActive } = useKeyboardInset();

  // textarea autosize: grows 1 → 5 rows with content, then scrolls internally.
  function resize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const lh = parseFloat(getComputedStyle(ta).lineHeight || "20") || 20;
    ta.style.height = `${Math.min(ta.scrollHeight, lh * MAX_ROWS + 16)}px`;
    ta.style.overflowY = ta.scrollHeight > lh * MAX_ROWS + 16 ? "auto" : "hidden";
  }

  useEffect(() => {
    if (editing) {
      setText(editing.body.kind === "text" ? editing.body.text : "");
      requestAnimationFrame(() => {
        taRef.current?.focus();
        taRef.current?.setSelectionRange(text.length, text.length);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(resize, [text]);

  // Revoke any leftover preview URLs when the dock unmounts.
  useEffect(
    () => () => {
      for (const q of queueRef.current) URL.revokeObjectURL(q.url);
    },
    [],
  );

  // Report panel activity up to the room (message list re-pin).
  useEffect(() => {
    onPanelsOpenChange?.(emojiOpen || plusOpen || pollOpen);
  }, [emojiOpen, plusOpen, pollOpen, onPanelsOpenChange]);

  // expose queue-adding to the parent: drag&dropped files land in the same
  // gray as picked ones (through the security gate) instead of going out instantly.
  useEffect(() => {
    registerAddToQueue?.((files: File[]) => {
      handleFiles(files);
    });
  }, [registerAddToQueue]);

  // "+" menu: close on outside click / Escape.
  useEffect(() => {
    if (!plusOpen) return;
    const onDown = (e: MouseEvent) => {
      if (plusWrapRef.current && !plusWrapRef.current.contains(e.target as Node)) setPlusOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlusOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [plusOpen]);

  function submit() {
    const trimmed = text.trim();
    if (isEditing) {
      if (trimmed && editing) onEditDone(editing.id, trimmed);
      setText("");
      return;
    }
    if (disabled) return;
    if (queueRef.current.length > 0) {
      // caption rides the LAST queued item — photo or any other file.
      const images = queueRef.current.filter((q) => q.kind === "image");
      const files = queueRef.current.filter((q) => q.kind === "file");
      const last = queueRef.current[queueRef.current.length - 1];
      const caption = trimmed;
      for (const q of queueRef.current) URL.revokeObjectURL(q.url);
      if (images.length > 0) {
        onSendQueue(
          images.map((q) => ({ file: q.file, viewOnce: q.viewOnce })),
          last?.kind === "image" ? caption : "",
        );
      }
      files.forEach((q) => onSendAttachment(q.file, q.id === last?.id ? caption : undefined));
      setQueue([]);
      setText("");
      return;
    }
    if (trimmed) {
      onSendText(trimmed);
      setText("");
    }
  }

  /** Opens the hidden file picker; the intent decides the confirm flow. */
  function openPicker(intent: "photo" | "once") {
    pickIntentRef.current = intent;
    fileRef.current?.click();
  }

  /** Files picked via the hidden input: every file passes the quiet    *  security gate (blocklist / magic bytes / zip scan / 25 MB) BEFORE
   *  enqueueing; rejections surface as a short toast, not scary badges. */
  function handleFiles(files: File[]) {
    const once = pickIntentRef.current === "once" && files.length === 1;
    const capacity = Math.max(0, MAX_QUEUE - queueRef.current.length);
    const fitting = files.slice(0, capacity);
    files.slice(capacity).forEach(() => onSecurityNotice?.("Queue holds at most 10 files"));
    void Promise.all(
      fitting.map(async (file) => {
        const gate = await checkFile(file);
        if (!gate.ok) {
          onSecurityNotice?.(gate.reason);
          return null;
        }
        const isImage = file.type.startsWith("image/");
        const item: QueueItem = {
          id: randomId(),
          file,
          url: URL.createObjectURL(file),
          viewOnce: once && isImage,
          kind: isImage ? "image" : "file",
        };
        return item;
      }),
    ).then((items) => {
      const clean = items.filter((q): q is QueueItem => q !== null);
      if (clean.length > 0) setQueue((prev) => [...prev, ...clean]);
    });
  }

  /** Drops one photo from the queue and frees its preview URL. */
  function removeFromQueue(id: string) {
    setQueue((prev) => {
      const item = prev.find((q) => q.id === id);
      if (item) URL.revokeObjectURL(item.url);
      return prev.filter((q) => q.id !== id);
    });
  }

  function submitPoll() {
    const opts = pollOptions.map((o) => o.trim()).filter(Boolean);
    if (!pollQuestion.trim() || opts.length < 2) return;
    onSendPoll(pollQuestion, opts);
    setPollOpen(false);
    setPollQuestion("");
    setPollOptions(["", ""]);
  }

  const toolsDisabled = disabled || isEditing;

  return (
    <div
      className="safe-px px-4 pb-4 pt-1"
      style={{
        paddingBottom:
          keyboardActive && keyboardInset > 0 ? `calc(${keyboardInset}px + 8px)` : undefined,
      }}
    >
      <div className="relative mx-auto w-full max-w-3xl">
        {/* Edit banner */}
        {editing && (
          <div className="well mb-2 flex items-center gap-2 rounded-2xl border-l-2 border-l-line-strong px-3 py-1.5 text-xs text-secondary">
            <Pencil className="h-3.5 w-3.5 shrink-0 text-tertiary" aria-hidden />
            <span className="shrink-0 font-medium text-secondary">Editing message</span>
            <span className="min-w-0 flex-1 truncate">{editing.body.kind === "text" ? editing.body.text : ""}</span>
            <button
              type="button"
              onClick={onCancelEdit}
              aria-label="Cancel editing (Esc)"
              className="shrink-0 rounded-full p-1 text-tertiary transition-colors hover:bg-black/[0.06] hover:text-heading dark:hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              <span className="ml-1 hidden text-[10px] sm:inline">Esc</span>
            </button>
          </div>
        )}

        {/* Reply banner */}
        {replyTo && !editing && (
          <div className="well mb-2 flex items-center gap-2 rounded-2xl border-l-2 border-l-line-strong px-3 py-1.5 text-xs text-secondary">
            <Reply className="h-3.5 w-3.5 shrink-0 text-tertiary" aria-hidden />
            <span className="shrink-0 font-medium text-secondary">{replyTo.sender === "self" ? "You" : "Peer"}</span>
            <span className="min-w-0 flex-1 truncate">
              {replyTo.body.kind === "text" ? replyTo.body.text : replyTo.body.kind === "image" ? "Image" : replyTo.body.kind === "file" ? replyTo.body.name : replyTo.body.kind === "poll" ? `📊 ${replyTo.body.question}` : "Voice"}
            </span>
            <button
              type="button"
              onClick={onCancelReply}
              aria-label="Cancel reply"
              className="rounded-full p-1 text-tertiary transition-colors hover:bg-black/[0.06] hover:text-heading dark:hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        )}

        {/* Emoji panel: right-aligned like its toggle, rendered ABOVE the
            photo queue in normal flow — nothing overlaps anything. */}
        {emojiOpen && (
          <div className="mb-2 flex justify-end">
            <EmojiPicker
              onPick={(e) => {
                setText((t) => t + e);
                taRef.current?.focus();
              }}
              onClose={() => setEmojiOpen(false)}
            />
          </div>
        )}

        {/* Attachment queue: images as thumbnails, other files as matte
            mini-cards. Security-rejected items show the reason and never leave. */}
        {queue.length > 0 && (
          <div className="card mb-2 rounded-2xl p-2">
            <div className="flex flex-wrap items-center gap-2">
              {queue.map((q) => (
                <div key={q.id} className="relative">
                  {q.kind === "image" ? (
                    <div className="relative h-16 w-16">
                      <img
                        src={q.url}
                        alt={q.file.name}
                        className="well h-16 w-16 rounded-xl object-cover"
                      />
                      {q.viewOnce && (
                        <span
                          title="Burns 10 sec after being viewed"
                          aria-label="View-once photo"
                          className="absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm dark:bg-black/70"
                        >
                          <Flame className="h-3 w-3" aria-hidden />
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="flex h-16 w-44 items-center gap-2.5 rounded-xl bg-white px-2.5 ring-1 ring-black/[0.08] dark:bg-zinc-900 dark:ring-white/[0.08]">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {(q.file.name.split(".").pop() ?? "file").slice(0, 4)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] font-medium text-heading" title={q.file.name}>
                          {q.file.name}
                        </p>
                        <p className="mt-0.5 truncate text-[10px] text-tertiary">
                          {QUEUE_KIND[categorize(q.file.name, q.file.type)]}
                        </p>
                      </div>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeFromQueue(q.id)}
                    aria-label={`Remove ${q.file.name} from queue`}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black text-white shadow-pop transition-all duration-150 hover:bg-zinc-700 active:scale-90 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Poll composer */}
        {pollOpen && (
          <div className="card mb-2 rounded-2xl p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-tertiary">New poll · E2EE</p>
            <input
              value={pollQuestion}
              onChange={(e) => setPollQuestion(e.target.value)}
              placeholder="Question…"
              className="well mb-2 w-full rounded-xl px-3 py-2 text-sm text-heading placeholder:text-tertiary transition-colors focus:border-line-strong focus:outline-none"
            />
            <div className="flex flex-col gap-1.5">
              {pollOptions.map((opt, i) => (
                <div key={i} className="flex gap-1.5">
                  <input
                    value={opt}
                    onChange={(e) => setPollOptions((prev) => prev.map((o, j) => (j === i ? e.target.value : o)))}
                    placeholder={`Option ${i + 1}`}
                    className="well min-w-0 flex-1 rounded-xl px-3 py-1.5 text-sm text-heading placeholder:text-tertiary transition-colors focus:border-line-strong focus:outline-none"
                  />
                  {pollOptions.length > 2 && (
                    <button
                      type="button"
                      aria-label="Remove option"
                      onClick={() => setPollOptions((prev) => prev.filter((_, j) => j !== i))}
                      className="rounded-full p-1.5 text-tertiary transition-colors hover:bg-black/[0.06] hover:text-heading dark:hover:bg-white/10"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2.5 flex items-center justify-between">
              <button
                type="button"
                disabled={pollOptions.length >= 4}
                onClick={() => setPollOptions((prev) => [...prev, ""])}
                className="text-xs text-secondary transition-colors hover:text-heading disabled:opacity-40"
              >
                + option
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPollOpen(false)}
                  className="rounded-full px-3 py-1.5 text-xs text-secondary transition-colors hover:text-heading"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitPoll}
                  disabled={disabled}
                  className="rounded-full bg-black px-3.5 py-1.5 text-xs font-medium text-white transition-all duration-150 hover:bg-zinc-800 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                >
                  Send poll
                </button>
              </div>
            </div>
          </div>
        )}

        {/* The dock row: tools menu · input pill · voice / send.
            h-9 icons + h-9 send inside a self-center wrapper keep every
            control optically centered against the 1-row pill. */}
        <div className="flex items-end gap-2">
          <div ref={plusWrapRef} className="relative shrink-0 self-center">
            {plusOpen && (
              <div
                className="card shadow-pop absolute bottom-full left-0 z-30 mb-2 w-64 rounded-2xl p-1.5"
                role="menu"
                aria-label="Message actions"
              >
                <MenuItem
                  icon={Paperclip}
                  label="Attach file"
                  hint="anything but programs · up to 25 MB"
                  disabled={toolsDisabled}
                  onClick={() => {
                    setPlusOpen(false);
                    openPicker("photo");
                  }}
                />
                <MenuItem
                  icon={Flame}
                  label="View-once photo"
                  hint="burns 10 sec after being viewed"
                  accent
                  disabled={toolsDisabled}
                  onClick={() => {
                    setPlusOpen(false);
                    openPicker("once");
                  }}
                />
                <MenuItem
                  icon={BarChart3}
                  label="Poll"
                  disabled={toolsDisabled}
                  onClick={() => {
                    setPlusOpen(false);
                    setPollOpen(true);
                  }}
                />
              </div>
            )}
            <button
              type="button"
              onClick={() => setPlusOpen((v) => !v)}
              disabled={toolsDisabled}
              aria-label="More actions"
              aria-expanded={plusOpen}
              title="More"
              className={plusOpen ? `${iconBtnActive} bg-black/[0.08] text-heading dark:bg-white/10` : iconBtn}
            >
              <Plus className="h-5 w-5" aria-hidden />
            </button>
          </div>

          <div className="well relative flex min-w-0 flex-1 items-end gap-0.5 rounded-3xl p-1.5 transition-colors duration-200 focus-within:border-line-strong">
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                if (picked.length > 0) handleFiles(picked);
                e.target.value = "";
              }}
            />
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              disabled={disabled}
              placeholder={
                disabled
                  ? "Waiting for your peer…"
                  : queue.length > 0
                    ? "Caption for the file…"
                    : "Message…"
              }
              onChange={(e) => {
                setText(e.target.value);
                onTyping();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
                if (e.key === "ArrowUp" && !text && onEditLast) {
                  e.preventDefault();
                  onEditLast();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  if (isEditing) onCancelEdit();
                  else if (replyTo) onCancelReply();
                }
              }}
              className="min-h-[36px] max-h-[116px] min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-5 text-heading placeholder:text-tertiary focus:outline-none disabled:opacity-60"
            />
            <button
              type="button"
              data-emoji-toggle
              onClick={() => setEmojiOpen((v) => !v)}
              disabled={disabled || isEditing}
              aria-label="Emoji panel"
              title={disabled ? "The panel opens once your peer joins" : "Emoji"}
              className={emojiOpen ? `${iconBtnActive} bg-black/[0.08] text-heading dark:bg-white/10` : iconBtn}
            >
              <Smile className="h-5 w-5" aria-hidden />
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-0.5 self-center">
            {!text.trim() && !isEditing && queue.length === 0 && <VoiceRecorder onSend={onSendAudio} disabled={disabled} />}

            {(text.trim() || isEditing || queue.length > 0) && (
              <button
                type="button"
                onClick={submit}
                disabled={disabled}
                aria-label={isEditing ? "Save" : "Send message"}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black text-white shadow-card transition-all duration-150 hover:bg-zinc-800 active:scale-90 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-strong dark:bg-white dark:text-black dark:hover:bg-zinc-200"
              >
                <Send className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
