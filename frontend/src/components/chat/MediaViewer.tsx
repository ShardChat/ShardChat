// SHARD — fullscreen lightbox for decrypted images.
import { useEffect } from "react";
import { X } from "lucide-react";

interface MediaViewerProps {
  imageSrc: string;
  onClose: () => void;
}

export function MediaViewer({ imageSrc, onClose }: MediaViewerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{ top: "max(1rem, env(safe-area-inset-top))" }}
        className="absolute right-4 rounded-lg border border-white/10 bg-zinc-900 p-2 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
      >
        <X className="h-5 w-5" aria-hidden />
      </button>
      <img
        src={imageSrc}
        alt="Decrypted image"
        className="max-h-full max-w-full rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
