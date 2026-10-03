// SHARD — brand mark: a flat faceted shard with hairline facet cuts.
// strictly monochrome; scales cleanly at any size. Colors follow the
// active theme via CSS variables — no invert filters needed:
// body = heading color (white in dark, coal in light),
// facet cuts = page background, so they stay visible in both themes.
export function CrystalLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      {/* main faceted body */}
      <polygon
        points="12,1.5 19.5,6 17.5,18.5 12,22.5 6.5,18.5 4.5,6"
        fill="var(--text-heading)"
      />
      {/* facet cuts, drawn in the background color */}
      <polyline
        points="4.5,6 12,9.5 19.5,6"
        stroke="var(--bg-page)"
        strokeWidth="0.7"
        fill="none"
      />
      <line x1="12" y1="9.5" x2="12" y2="22.5" stroke="var(--bg-page)" strokeWidth="0.7" />
    </svg>
  );
}
