# LocalLeaf moss hero design QA

## Evidence

- Source visual truth: `C:\Users\whent\.codex\generated_images\019f5114-e5c3-7182-bc56-ef079e6f971a\exec-5984186a-36b6-48d5-bbca-c29e431cb94c.png`
- Production asset: `E:\Programming\Overleaf clone\landing-page\assets\hero-moss.webp`
- Desktop implementation: `E:\Programming\Overleaf clone\output\playwright\landing-moss-desktop.png`
- Mobile implementation: `E:\Programming\Overleaf clone\output\playwright\landing-moss-mobile.png`
- Full-view comparison: `E:\Programming\Overleaf clone\output\playwright\landing-moss-comparison.png`
- Desktop viewport and pixels: 1536 x 1024 CSS px, device scale factor 1, 1536 x 1024 screenshot.
- Mobile viewport and pixels: 390 x 844 CSS px, device scale factor 1, 390 x 844 screenshot.
- Source pixels: 1536 x 1024. The desktop comparison uses identical pixel dimensions; no density normalization was required.
- State: light theme, hero entrance settled. Dark-theme token containment and reduced-motion behavior were checked separately.

## Findings

- No remaining P0, P1, or P2 findings.
- Fonts and typography: the restored homepage typography, hierarchy, wrapping, copy, and optical weight are preserved. The background occupies the image layer only.
- Spacing and layout rhythm: the desktop copy remains in the source image's quiet field and the moss mass anchors the right and lower edges. Mobile stacks the existing download actions above the moss without overflow.
- Colors and visual tokens: the source cream and moss palette is preserved. Hero foreground and secondary actions remain explicitly readable in both site themes.
- Image quality and asset fidelity: the exact approved moss image is used as an optimized 139 KB WebP. Desktop uses the source crop; mobile repositions the same asset without stretching or substituting artwork.
- Copy and content: all restored homepage copy, platform downloads, release note, navigation, and subsequent sections remain unchanged.
- Motion: the background and copy enter once using transform and opacity. After `animationend` (with a bounded fallback), animation is removed, transform becomes `none`, and `will-change` returns to `auto`. Reduced motion renders the final frame immediately.

## Comparison history

1. Initial mobile capture found one P2 contrast issue: the release note crossed the darker moss edge without a stable reading surface.
2. Fixed with a compact cream backing, 8px radius, and 16px separation inside the mobile breakpoint.
3. The revised 390 x 844 capture shows the complete note with stable contrast, zero horizontal overflow, and zero broken images.

## Interaction and browser checks

- Primary download links remain present and point to the existing latest-release URLs.
- Desktop and mobile snapshots expose the expected hero, navigation, preview, flow, AI, Q&A, and final download content.
- Desktop scroll width equals its 1536px viewport; mobile scroll width equals its 390px viewport.
- Broken images: 0.
- Console errors and warnings: 0.
- Settled motion state: `animation: none`, `transform: none`, `will-change: auto`.
- Reduced-motion state: `animation: none`, `transform: none`, `opacity: 1`, `will-change: auto`.

Focused comparison was performed on the mobile hero because its alternate crop, stacked actions, and release-note contrast cannot be judged reliably from the desktop full-view comparison.

## Implementation checklist

- [x] Use the exact approved moss asset.
- [x] Preserve the restored hero copy and calls to action.
- [x] Add one-shot compositor-only entrance motion.
- [x] Remove the promoted layer after the entrance settles.
- [x] Support reduced motion and both site themes.
- [x] Verify desktop and mobile rendering, assets, overflow, and console output.

final result: passed
