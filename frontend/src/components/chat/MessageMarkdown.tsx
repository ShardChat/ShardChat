// SHARD — renders a text body through react-markdown (GFM enabled):
// fenced code blocks with a copy button, inline code badges with copy,
// bold/italic/strikethrough, lists and BLUE clickable links that open in
// a new tab. Output is React nodes (never HTML strings), so nothing can
// be injected; urlTransform limits protocols to http(s)/mailto.
import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, ExternalLink } from "lucide-react";

function CopyButton({ getText, label }: { getText: () => string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(getText()).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-black/10 hover:text-heading dark:hover:bg-white/10"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
    </button>
  );
}

/** Inline-code badge with one-click copy. */
export function InlineCodeSpan({ code }: { code: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 align-baseline">
      <code className="overflow-hidden rounded-md bg-black/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] text-heading dark:bg-white/10">
        {code}
      </code>
      <CopyButton getText={() => code} label="Copy code" />
    </span>
  );
}

/** Fenced code block: framed zinc surface + copy button in the corner. */
export function CodeBlockView({ code }: { code: string }) {
  return (
    <div className="group/code relative my-1.5 overflow-hidden rounded-xl border border-line bg-sunken">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-tertiary">code</span>
        <div className="flex items-center gap-1">
          <CopyButton getText={() => code} label="Copy code" />
        </div>
      </div>
      <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed text-heading">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-baseline gap-0.5 font-medium text-sky-600 underline decoration-sky-500/50 underline-offset-2 transition-colors hover:text-sky-500 hover:decoration-sky-400 dark:text-sky-400 dark:hover:text-sky-300"
    >
      <span className="truncate">{children}</span>
      <ExternalLink className="h-3 w-3 shrink-0 translate-y-[1px] opacity-70" aria-hidden />
    </a>
  ),
  code: ({ className, children, ...rest }) => {
    const isBlock = typeof className === "string" && className.includes("language-");
    // Block code is rendered by pre below; inline code becomes a badge.
    if (isBlock) return <code className={className} {...rest}>{children}</code>;
    return (
      <span className="inline-flex max-w-full items-center gap-1 align-baseline">
        <code className="overflow-hidden rounded-md bg-black/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] text-heading dark:bg-white/10">
          {children}
        </code>
        <CopyButton getText={() => String(children)} label="Copy code" />
      </span>
    );
  },
  pre: ({ children }) => {
    // Extract the fenced block's text for the copy button.
    let code = "";
    const child = children as { props?: { children?: unknown } } | undefined;
    if (child?.props) code = String(child.props.children ?? "");
    return <CodeBlockView code={code.replace(/\n$/, "")} />;
  },
};

export function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words text-sm leading-5 [&>div>p]:whitespace-pre-wrap [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        urlTransform={(url) => (/^(https?:|mailto:)/i.test(url) ? url : "")}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
