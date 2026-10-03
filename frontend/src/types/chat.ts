// SHARD — room domain models decrypted on the client. The server never
// sees any of these: they live inside AES-GCM ciphertext envelopes.
export type MessageSender = "self" | "peer";

export interface ReplyQuote {
  id: string;
  snippet: string;
  sender: MessageSender; // sender as seen by the quoting client
}

export interface TextBody {
  kind: "text";
  text: string;   /** Set after EDIT_MESSAGE — renders the small "(edited)" badge. */
  edited?: boolean;
  replyTo?: ReplyQuote;
}

export interface ImageBody {
  kind: "image";
  imageBase64: string; // raw bytes base64, decrypted on arrival
  /** View-once: blurred until opened, wiped 10s after the reveal. */
  viewOnce?: boolean;
  revealedAt?: number | null; // receiver-side reveal timestamp
  replyTo?: ReplyQuote;
}

export interface AudioBody {
  kind: "audio";
  audioBase64: string; // encrypted audio/webm bytes, base64
  wave: number[]; // 0..1 normalized peaks for the visualizer
  durationMs: number;
  replyTo?: ReplyQuote;
}

export interface FileBody {
  kind: "file";
  name: string;
  mime: string;
  /** True for generic attachments (video/audio/docs/archives) → card UI. */
  attachment?: boolean;
  /** Caption rendered inside the photo bubble under the image. */
  caption?: string;
  /** Object URL of the reassembled decrypted blob (memory-only, never persisted). */
  url: string;
  size: number;
  /** View-once images ride the file pipeline; same burn-after-viewing rules. */
  viewOnce?: boolean;
  revealedAt?: number | null;
  replyTo?: ReplyQuote;
}

export interface PollBody {
  kind: "poll";
  question: string;
  options: string[]; // 2..4 options
  /** optionIndex → sender labels ("self" | "peer") of the voters. */
  votes: Record<number, MessageSender[]>;
  replyTo?: ReplyQuote;
}

export type MessageBody = TextBody | ImageBody | AudioBody | FileBody | PollBody;

/** Delivery state: sent (✓) → delivered/read (✓✓). */
export type ReceiptState = "sent" | "read";

/** Live chunked-transfer progress bar attached to a pending bubble. */
export interface TransferState {
  fileId: string;
  progress: number; // 0..1
  direction: "up" | "down";
  name: string;
}

export interface ChatMessage {
  id: string;
  sender: MessageSender;
  body: MessageBody;
  timestamp: number;
  receipt: ReceiptState;
  /** emoji → who reacted (sender labels), drives the badge counters. */
  reactions: Map<string, MessageSender[]>;
}

/** Inner payload of a REACTION packet (already decrypted by the relay users). */
export interface ReactionUpdate {
  messageId: string;
  emoji: string;
  op: "add" | "remove";
}
