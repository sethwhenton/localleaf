---
version: beta
name: LocalLeaf-design-system
status: authoritative
scope: desktop-application
description: >-
  LocalLeaf is a desktop-first LaTeX workspace with a quiet editorial interface.
  Geist typography, warm neutral surfaces, restrained LocalLeaf orange, compact
  controls, and predictable pane layouts keep the document at the center.

platform:
  desktopOnly: true
  mobileSupported: false
  minimumVerifiedViewport: "1024x640"
  viewportHeight: 100dvh
  outerDocumentScroll: false

colors:
  ink: "#181818"
  body: "#6a6a6a"
  mute: "#8b857f"
  canvas: "#ffffff"
  surface: "#ffffff"
  surfaceSoft: "#fafafa"
  hairline: "#e5e5e5"
  hairlineStrong: "#d4d4d4"
  orangeAction: "#c95100"
  orangeActionHover: "#c95100"
  orangeBright: "#ff6700"
  orangeSoft: "#fff1e7"
  onOrange: "#ffffff"
  focusRing: "#c95100"
  danger: "#c3382b"
  success: "#2f7d48"
  dark:
    canvas: "#171717"
    surface: "#202020"
    ink: "#f7f4f1"
    body: "#b6aaa0"
    hairline: "#3b3531"
    orangeAction: "#c95100"
    orangeActionHover: "#c95100"
    focusRing: "#c95100"

typography:
  uiFamily: "Geist, Geist Sans, ui-sans-serif, system-ui, sans-serif"
  monoFamily: "Geist Mono, ui-monospace, SFMono-Regular, Consolas, monospace"
  title:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 24px
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
  bodyMedium:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 24px
  bodySmall:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
  bodySmallMedium:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
  caption:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px

spacing:
  base: 4px
  scale:
    - 0px
    - 4px
    - 8px
    - 12px
    - 16px
    - 20px
    - 24px
    - 32px
    - 40px
    - 48px

radii:
  control: 8px
  card: 12px
  cardLarge: 16px
  dialog: 24px
  pill: 40px
  minimum: 8px
  maximum: 40px

icons:
  glyphSize: 18px
  strokeWidth: 1.5px
  interactionBound: 24px
  providerTile: 28px
  style: restrained-rounded-stroke

motion:
  durationFast: 120ms
  durationDefault: 160ms
  durationMaximum: 180ms
  easing: "cubic-bezier(0.2, 0, 0, 1)"
  allowedProperties:
    - transform
    - opacity
  gradientsAllowed: false
  animatedBlurAllowed: false
  reducedMotionRequired: true

elevation:
  gradients: none
  heavyShadows: none
  default: "1px solid #e5e5e5"
  floating: "0 2px 8px rgba(24, 24, 24, 0.04)"

components:
  primaryAction:
    background: "{colors.orangeAction}"
    foreground: "{colors.onOrange}"
    hoverBackground: "{colors.orangeActionHover}"
    radius: "{radii.control}"
  secondaryAction:
    background: "{colors.surface}"
    foreground: "{colors.ink}"
    border: "1px solid {colors.hairlineStrong}"
    radius: "{radii.control}"
  selectedControl:
    background: transparent
    foreground: "{colors.ink}"
    border: "1px solid transparent"
    underline: "2px solid {colors.orangeAction}"
    radius: "{radii.control}"
  card:
    background: "{colors.surface}"
    border: "1px solid {colors.hairline}"
    radius: "{radii.card}"
    shadow: none
  dialog:
    background: "{colors.surface}"
    border: "1px solid {colors.hairline}"
    radius: "{radii.dialog}"
  statusBadge:
    radius: "{radii.pill}"
    fontSize: 12px
    providerConnectionFontSize: 11px
  appearanceSwitch:
    size: 76px x 32px
    glyph: 18px / 1.5px stroke
    motion: transform and opacity only
  disclosure:
    label: "Show answer / Hide answer"
    glyph: "chevron-right / chevron-down"
    iconSize: "{icons.glyphSize}"

providerLogos:
  discoveryCatalog: "https://logos.lndev.me/"
  sourceRepository: "https://github.com/ln-dev7/logos-apps"
  pinnedCommit: fd7b5aa517a25ce94f2af22bb00d63d9aae201ed
  runtimePolicy: local-vendored-assets-only
  runtimeDirectory: public/assets/provider-logos
  noticeFile: public/assets/provider-logos/NOTICE.md
  fallback: neutral-generic-provider-glyph
---

# LocalLeaf design system

This document is the authoritative design contract for the LocalLeaf desktop application. When an older screenshot, experiment, or historical reference conflicts with this document, follow this document.

## Product character

LocalLeaf should feel like a focused document tool: warm, calm, legible, and compact. The interface supports the work instead of competing with it. Use flat surfaces, strong hierarchy, deliberate spacing, and one restrained brand accent.

The application is desktop-only. Do not create a mobile navigation system or compress desktop controls into a phone layout. Reflow panes at supported desktop widths while preserving access to the editor, PDF, chat, AI helper, changes, and logs.

## Color

- Use `#181818` for primary text and `#6a6a6a` for secondary text.
- Use LocalLeaf orange for primary actions, selected states, focus, and small brand accents. Orange is scarce; it is not a page background or a color for every icon.
- Keep the logo mark at `#ff6700`. Use the slightly deeper `#c95100` for action fills, focus rings, progress, and animated selection underlines; it is the closest proportional darkening of the logo orange that reaches a 4.51:1 contrast ratio with white text.
- Use `#fff1e7` for quiet selected backgrounds and `#b84a08` for light-theme focus treatment.
- Keep surfaces white or warm neutral with 1px neutral borders. Do not use gradients, neon color, glassmorphism, or heavy shadows.
- Company logos keep their reviewed native colors. Do not recolor them orange to force brand consistency.

## Typography

- Self-host Geist for the application interface. Use Geist Mono for code, paths, and LaTeX-oriented metadata.
- Use 16px regular or medium for comfortable reading and 14px regular or medium for controls and supporting copy.
- Use 18px semibold for surface titles. Avoid oversized dialog and panel headings.
- Use 12px only for compact labels, metadata, and status badges; never for primary instructions.
- Provider connection/result badges are the compact exception: 11px type on a 16px line inside a 20px badge.
- Keep sentence case. Avoid decorative all-caps except short, low-priority section labels.
- Prefer direct, human wording. Avoid marketing filler and generic AI language.

## Spacing and shape

- Every spacing value follows a 4px rhythm. Use 8, 12, 16, 20, 24, 32, and 40px most often.
- Use 8px for controls, 12-16px for cards, 24px for dialogs, and up to 40px for intentionally pill-shaped compact elements.
- Do not make every control a pill. Shape communicates hierarchy: compact controls are crisp, cards are softly rounded, and only badges or segmented shells may be pill-shaped.
- Use a 1px border for structure. Prefer separation and whitespace over elevation.

## Icons and provider marks

- Interface glyphs are 18px with a 1.5px stroke inside a 24px interaction bound. Use one restrained rounded-stroke family or compatible custom SVGs.
- Pair ambiguous glyphs with a short label. Disclosure controls use `Show answer` / `Hide answer` with a right/down chevron instead of isolated plus/minus circles.
- Keep provider marks optically centered in neutral 28px tiles. Provider identity and LocalLeaf action color are separate systems.
- Use [logos.lndev.me](https://logos.lndev.me/) only as the discovery catalog. Review and vendor approved assets locally; the application must never depend on a remote logo request at runtime.
- Reviewed vendored marks are pinned to catalog commit `fd7b5aa517a25ce94f2af22bb00d63d9aae201ed`. Asset provenance and hashes live in `public/assets/provider-logos/NOTICE.md`; providers without an express redistribution grant use the neutral generic glyph.
- Do not distort, merge, recolor, or use a provider mark in a way that implies endorsement. Unknown and custom providers receive a neutral generic glyph.

## Components

### Actions

- Primary actions use the accessible orange fill. A view should have one obvious primary action cluster.
- Secondary actions use neutral surfaces and borders. Repeated actions such as provider connection may use a restrained orange outline when it improves scanning.
- Selected tabs, toggles, navigation, and text-like menu states keep neutral text, transparent borders, and transparent backgrounds. Their sole orange state cue is a 2px `#c95100` underline, revealed from its center with transform and opacity only and held visible while selected.
- Destructive actions remain semantic red and must not be disguised as LocalLeaf orange.
- Disabled controls retain their geometry but reduce contrast; they do not disappear.

### Surfaces

- Cards and rows are flat, bordered, and aligned to the 4px spacing grid.
- Use 12-16px card radii and no shadow by default. A floating layer may use only the documented diffuse 4% shadow.
- Dialogs use 24px radius and a clear 18px title. Avoid oversized decorative headers.
- Dense settings lists should use rows and dividers, not a collection of unrelated floating tiles.

### Project creation

- Project Overview is a top-aligned desktop work surface within the standard dashboard content padding. It remains horizontally bounded, and the dashboard content area owns any exceptional overflow.
- New Project opens one focused dialog with a 18px title, project name, editable destination path, native Browse action, and clear Cancel/Create actions. The destination copy must explain that LocalLeaf creates the named child folder inside it.
- Creation keeps one orange primary action and neutral secondary controls. Pending and field-level errors stay inside the dialog without shifting its structure; destination errors focus and identify the destination field.
- Retried submissions are idempotent. A delayed response must not produce `Project 2`, and a successful project creation must not be presented as a failure merely because editor hydration needs a retry.

### Chat and AI messages

- Human Chat keeps the sender's own message in one compact warm-neutral card. Other participants use a transparent message surface with a 2px `#c95100` leading rule; neither state uses orange or brown slabs, gradients, or shadows.
- AI Helper uses the same grammar: the user's prompt is a compact, right-aligned neutral card with a short neutral sender hairline and no colored row fill, while LocalLeaf replies sit directly on the transcript with the restrained leading rule. User identity is sentence case at 11px/16px; reply identity is 12px/16px and message copy is 14px/22px.
- Rich replies preserve semantic headings, lists, blockquotes, links, inline code, and fenced code. Code and file chips use Geist Mono on neutral surfaces; orange is limited to links, list markers, the quote/source rule, and focus.
- Chat and AI transcripts own their scroll. Messages, code blocks, diffs, and long paths must wrap or scroll locally without creating document-level overflow at 1024 x 640.

### AI-created project files

- A proposed new file is visibly labelled `New file`; its primary action says `Create file`, not `Approve`, and it remains pending even when YOLO mode is enabled.
- File creation is host-only and always reviewed. LocalLeaf accepts project-relative, visible, text-based LaTeX source/support paths, never overwrites, and does not open a proposed path before the file exists.
- Mixed create/edit runs keep every sibling behind host approval. Required files are created and hash-validated before a related `\input`, bibliography, package, or other source edit may be applied.
- Revert removes an AI-created file only when its content still matches the approved proposal. If related edits are already applied, use whole-run Undo or revert those edits first.
- After restart, historical proposals remain readable but are explicitly non-actionable unless their safe apply/revert payload is still available in the active host process.

### Changes and PDF review

- Changes is an editorial review list: 12px run summaries, 14px proposal titles, compact semantic status badges, neutral action buttons, and Geist Mono diffs. Expanded files use dividers and one quiet neutral surface instead of stacked orange cards.
- Run and proposal disclosures use code-native 18px chevrons inside 24px bounds. Every disclosure exposes `aria-expanded`, keeps a visible keyboard focus ring, and rotates only with transform motion that is removed under reduced motion.
- Review opens and focuses the first changed source range, then locates that exact compiled source snapshot in the displayed PDF. The PDF location uses one small outlined marker; it must never tint a whole page or transcript region.
- If the displayed PDF was compiled from different source, is still compiling, lacks SyncTeX, or has been replaced, keep the source open and explain the fallback without moving the PDF. Older Review requests must never override the latest selection.

### Feedback and states

- Every interaction needs visible hover, focus, pressed, pending, success, error, disabled, and empty states where applicable.
- Pending actions keep their label understandable, prevent duplicate submission, and expose progress without changing layout.
- Focus remains visible in light and dark themes. Never remove the outline without an equivalent focus treatment.

## Motion

- Keep transitions between 120 and 180ms. Animate only `transform` and `opacity` for routine interactions.
- A subtle scale plus opacity transition is appropriate for buttons and small overlays. Do not animate width, height, top, left, or large blur values.
- Do not add ambient motion, scroll-linked effects, parallax, or animated gradients to the desktop editor.
- Honor `prefers-reduced-motion` and remove nonessential transforms when it is enabled.

## Desktop viewport behavior

- The application shell fits within `100dvh`; the outer document must not become the workspace scrollbar.
- Files, source, PDF, chat, AI, changes, and logs each own their intentional scroll region. Grid and flex children that scroll must use `min-height: 0` and `min-width: 0` as appropriate.
- Preserve access to the bottom of every pane at verified desktop viewports from 1024 x 640 upward. Compact or reflow desktop panes before clipping controls.
- Do not hide content simply to eliminate a scrollbar. Scroll only the pane whose content exceeds its allocated area.
- Mobile and touch layouts are outside the product contract.

## Accessibility and reliability

- Text and control contrast must meet WCAG AA in both themes.
- Controls need keyboard operation, a visible focus state, and an accessible name independent of their icon.
- Keep layout stable as pending and error messages appear. Reserve space or use contained feedback surfaces.
- Local assets are preferred for fonts, icons, and provider marks so the desktop application remains reliable offline.

## Historical reference - non-authoritative

An earlier version of this document analyzed Ollama's marketing site. That exploration contributed a few useful principles: documentation-like clarity, flat surfaces, sparse color, quiet borders, and first-class treatment of code examples.

The following parts of that exploration are explicitly rejected for LocalLeaf and must not guide implementation:

- SF Pro Rounded and platform-default typography instead of Geist.
- 30-36px interface headings.
- Black primary CTAs or universal black-and-white branding.
- Fully rounded pills for every button and input.
- Llama imagery or Ollama-specific navigation, pricing, terminal, and marketing components.
- Mobile breakpoints, hamburger navigation, and touch-layout requirements.

This short note preserves the useful design lineage without making the old third-party component inventory part of the LocalLeaf contract.
