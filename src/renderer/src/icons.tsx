/**
 * Icon set, inline.
 *
 * Everything is drawn from local paths rather than an icon font or a CDN
 * sprite, because the renderer runs under a strict Content-Security-Policy
 * that blocks external requests. Each glyph is a 16px stroked path on a
 * consistent grid so weights match across the toolbar.
 */

interface IconProps {
  /** Pixel size; icons are square. */
  size?: number;
  className?: string;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false as const,
});

export function IconFile({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M9 1.75H4.25a1.5 1.5 0 0 0-1.5 1.5v9.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V6z" />
      <path d="M9 1.75V6h4.25" />
    </svg>
  );
}

export function IconFolder({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h2.9l1.4 1.75h5.2a1.5 1.5 0 0 1 1.5 1.5v6.75a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5z" />
    </svg>
  );
}

export function IconFit({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2 5.75V3a1 1 0 0 1 1-1h2.75M10.25 2H13a1 1 0 0 1 1 1v2.75M14 10.25V13a1 1 0 0 1-1 1h-2.75M5.75 14H3a1 1 0 0 1-1-1v-2.75" />
    </svg>
  );
}

export function IconHand({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4.5 7V3.8a1 1 0 0 1 2 0V6M6.5 6V2.8a1 1 0 0 1 2 0V6M8.5 6V3.35a1 1 0 0 1 2 0v3.1M10.5 6.45V4.7a1 1 0 0 1 2 0v4.05c0 3.3-1.75 5.25-4.75 5.25-1.55 0-2.7-.62-3.55-1.85L1.9 8.8a1.15 1.15 0 0 1 1.8-1.42L5 8.8" />
    </svg>
  );
}

export function IconUndo({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.75 5.5h7a3.75 3.75 0 0 1 0 7.5H6" />
      <path d="M5.5 2.5 2.5 5.5l3 3" />
    </svg>
  );
}

export function IconRedo({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M13.25 5.5h-7a3.75 3.75 0 0 0 0 7.5H10" />
      <path d="M10.5 2.5l3 3-3 3" />
    </svg>
  );
}

export function IconSave({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.75 3.25a1.5 1.5 0 0 1 1.5-1.5h6.13l2.87 2.87v7.13a1.5 1.5 0 0 1-1.5 1.5h-7.5a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M5.25 1.75v3.5h4.5v-3.5M5.25 14.25v-4h5.5v4" />
    </svg>
  );
}

export function IconExport({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 10.5V2.25M5.25 5 8 2.25 10.75 5" />
      <path d="M2.75 10.5v2.25a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V10.5" />
    </svg>
  );
}

export function IconSun({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1" />
    </svg>
  );
}

export function IconMoon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" />
    </svg>
  );
}

export function IconDuplicate({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.5" />
      <path d="M10.25 5.75v-2a1.5 1.5 0 0 0-1.5-1.5h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h2" />
    </svg>
  );
}

export function IconCopy({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="5.25" y="4.75" width="8" height="8.5" rx="1.25" />
      <path d="M10.75 4.75V3.5a1.25 1.25 0 0 0-1.25-1.25H3.5A1.25 1.25 0 0 0 2.25 3.5v7A1.25 1.25 0 0 0 3.5 11.75h1.75" />
    </svg>
  );
}

export function IconPaste({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M5.25 3.25H3.75A1.5 1.5 0 0 0 2.25 4.75v8A1.5 1.5 0 0 0 3.75 14.25h7.5a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5h-1.5" />
      <rect x="5.25" y="1.75" width="4.5" height="3" rx="1" />
      <path d="M5.25 8h5.5M5.25 10.75h4" />
    </svg>
  );
}

export function IconTrash({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.75 4.25h10.5M6.5 4.25V2.75h3v1.5M4.25 4.25l.6 9a1 1 0 0 0 1 .95h4.3a1 1 0 0 0 1-.95l.6-9" />
    </svg>
  );
}

export function IconPlus({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  );
}

export function IconMinus({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3.25 8h9.5" />
    </svg>
  );
}

export function IconSearch({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="7.25" cy="7.25" r="4.5" />
      <path d="M10.6 10.6 13.75 13.75" />
    </svg>
  );
}

export function IconLock({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3.25" y="7" width="9.5" height="7" rx="1.5" />
      <path d="M5.5 7V4.75a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}

export function IconEye({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M1.5 8s2.3-3.75 6.5-3.75S14.5 8 14.5 8s-2.3 3.75-6.5 3.75S1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="1.75" />
    </svg>
  );
}

export function IconChair({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 2.25v5.5h7.25a1.5 1.5 0 0 1 1.5 1.5v1.5H4.5A2.25 2.25 0 0 1 2.25 8.5V5.25" />
      <path d="M4.5 10.75v3M11.5 10.75v3M4 7.75h7.5" />
    </svg>
  );
}

/** White-arrow/direct-selection tool with an editable anchor. */
export function IconDirectSelect({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 1.75 11.5 8 7.3 8.8 5.25 13.5 3 1.75Z" fill="none" />
      <rect x="10.75" y="1.75" width="3" height="3" rx=".35" fill="currentColor" stroke="none" />
      <path d="M8.2 5.2 11.2 3.3" strokeDasharray="1.2 1.2" />
    </svg>
  );
}

export function IconCalculator({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />
      <rect x="4.25" y="3.25" width="7.5" height="2.5" rx=".4" />
      <path d="M4.5 8h1M7.5 8h1M10.5 8h1M4.5 10.5h1M7.5 10.5h1M10.5 10.5h1M4.5 13h1M7.5 13h4" />
    </svg>
  );
}

export function IconWarning({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7.1 2.4 1.7 11.6a1 1 0 0 0 .9 1.5h10.8a1 1 0 0 0 .9-1.5L8.9 2.4a1 1 0 0 0-1.8 0z" />
      <path d="M8 6.25v3M8 11.4h.01" />
    </svg>
  );
}

export function IconRuler({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="1.5" y="5.5" width="13" height="5" rx="1" transform="rotate(-20 8 8)" />
      <path d="M4.4 6.4v1.8M6.9 5.5v2.6M9.4 4.6v1.8M11.9 3.7v2.6" />
    </svg>
  );
}

export function IconMagnet({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3.75 2.5v6a4.25 4.25 0 0 0 8.5 0v-6" />
      <path d="M3.75 6.75h3.5M8.75 6.75h3.5" />
    </svg>
  );
}

export function IconGrid({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.25" />
      <path d="M2.25 6.5h11.5M2.25 10.5h11.5M6.5 2.25v11.5M10.5 2.25v11.5" />
    </svg>
  );
}

/** Stacked drawing sheets, used for layer visibility and layer selection. */
export function IconLayers({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 2 13.5 5 8 8 2.5 5 8 2Z" />
      <path d="m2.5 8 5.5 3 5.5-3" />
      <path d="m2.5 11 5.5 3 5.5-3" />
    </svg>
  );
}

export function IconPrint({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4.25 6.25V2.25h7.5v4" />
      <path d="M4.25 12h-1.5a1 1 0 0 1-1-1V7.25a1 1 0 0 1 1-1h10.5a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1h-1.5" />
      <rect x="4.25" y="9.75" width="7.5" height="4" rx="0.75" />
    </svg>
  );
}

export function IconSidebarLeft({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
      <path d="M5.5 2.25v11.5M3.4 5.25h.01M3.4 8h.01M3.4 10.75h.01" />
    </svg>
  );
}

export function IconSidebarRight({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" />
      <path d="M10.5 2.25v11.5M12.6 5.25h.01M12.6 8h.01M12.6 10.75h.01" />
    </svg>
  );
}

/** The app mark: a plan sheet with a room outline. */
export function Mark({ size = 18, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden
      focusable={false}
    >
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.75 11.25V6.5h3.1v4.75M7.85 8.6h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconEdit({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden focusable={false}>
      <path
        d="M11.2 2.9a1.4 1.4 0 0 1 2 2L6.4 11.7l-2.7.6.6-2.7 6.9-6.7Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The draw tools, matching Room Viewer's Draw menu: Line, Rectangle, Ellipse.
 *
 * Drawn as outlines at the same weight as the rest of the set so the toolbar
 * reads as one family rather than as an add-on.
 */
export function IconDrawLine({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3 13L13 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="3" cy="13" r="1.6" fill="currentColor" />
      <circle cx="13" cy="3" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function IconDrawRect({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2.75" y="4.75" width="10.5" height="7.5" stroke="currentColor" strokeWidth="1.5" rx="1" />
    </svg>
  );
}

export function IconDrawEllipse({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <ellipse cx="8" cy="8" rx="5.5" ry="4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function IconDrawPolygon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3 12.5L2.5 5.5L7 2.5L13.5 5L11.5 13L3 12.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="3" cy="12.5" r="1.2" fill="currentColor" />
      <circle cx="2.5" cy="5.5" r="1.2" fill="currentColor" />
      <circle cx="7" cy="2.5" r="1.2" fill="currentColor" />
      <circle cx="13.5" cy="5" r="1.2" fill="currentColor" />
      <circle cx="11.5" cy="13" r="1.2" fill="currentColor" />
    </svg>
  );
}

/** The pointer, for leaving a draw tool and going back to selecting. */
export function IconPointer({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M3.5 2.2L12.2 7.6l-3.6.7-1.7 3.4L3.5 2.2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconText({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3 3.5h10M8 3.5v9M6 12.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconRotateLeft({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M3.2 7.2A5 5 0 1 1 4 10.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M1.6 4.4v3.2h3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconRotateRight({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M12.8 7.2A5 5 0 1 0 12 10.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M14.4 4.4v3.2h-3.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Draw order: the filled square is the one being moved. */
export function IconBringFront({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="6.5" y="6.5" width="7" height="7" stroke="currentColor" strokeWidth="1.3" rx="1" opacity="0.45" />
      <rect x="2.5" y="2.5" width="7" height="7" fill="currentColor" rx="1" />
    </svg>
  );
}

export function IconSendBack({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1.3" rx="1" opacity="0.45" />
      <rect x="6.5" y="6.5" width="7" height="7" fill="currentColor" rx="1" />
    </svg>
  );
}

export function IconFlipHorizontal({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 2.25v11.5" />
      <path d="M6.25 4.5 3.25 8l3 3.5M9.75 4.5l3 3.5-3 3.5" />
    </svg>
  );
}

export function IconFlipVertical({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.25 8h11.5" />
      <path d="M4.5 6.25 8 3.25l3.5 3M4.5 9.75l3.5 3 3.5-3" />
    </svg>
  );
}

export function IconAlignLeft({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 2.5v11" />
      <path d="M5 4.5h8.5M5 8h6M5 11.5h7" />
    </svg>
  );
}

export function IconAlignCenter({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 2.5v11" />
      <path d="M3.5 4.5h9M4.5 8h7M4 11.5h8" />
    </svg>
  );
}

export function IconAlignRight({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M13.5 2.5v11" />
      <path d="M2.5 4.5H11M5 8h6M4 11.5h7" />
    </svg>
  );
}

export function IconAlignTop({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 2.5h11" />
      <path d="M4.5 5v8.5M8 5v6M11.5 5v7" />
    </svg>
  );
}

export function IconAlignMiddle({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 8h11" />
      <path d="M4.5 3.5v9M8 4.5v7M11.5 4v8" />
    </svg>
  );
}

export function IconAlignBottom({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 13.5h11" />
      <path d="M4.5 2.5V11M8 5v6M11.5 3.5V11" />
    </svg>
  );
}

export function IconDistributeHorizontal({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 3v10M13.5 3v10" />
      <rect x="5.25" y="5.25" width="1.75" height="5.5" rx="0.4" fill="currentColor" stroke="none" />
      <rect x="9" y="5.25" width="1.75" height="5.5" rx="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconDistributeVertical({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 2.5h10M3 13.5h10" />
      <rect x="5.25" y="5.25" width="5.5" height="1.75" rx="0.4" fill="currentColor" stroke="none" />
      <rect x="5.25" y="9" width="5.5" height="1.75" rx="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconHelp({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M6.4 6.35a1.7 1.7 0 0 1 3.3.7c0 1.15-1.15 1.45-1.7 2.05V10" />
      <path d="M8 11.85h.01" />
    </svg>
  );
}
