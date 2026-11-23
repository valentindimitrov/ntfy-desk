// The copies of each screenshot the pages offer, so a browser downloads the smallest one that is still
// sharp at the size the picture is shown. pnpm website:screenshots captures each view at twice its size
// (website/media/<name>-<scheme>.webp); scripts/website-image-sizes.ts writes the smaller copies from it,
// and site.ts lists them all in srcset. Imports nothing, so the script can use it as well.

/** Widths in image pixels of the smaller copies, where they are clearly smaller than the full file */
const STEPS = [400, 720, 1080, 1440, 1920];

/**
 * Every width offered for a screenshot `cssWidth` CSS pixels wide, smallest first; the last is the full file.
 * The screenshot's own width (1x) is one of them: most are shown at or just below it on ordinary screens, and the
 * next step up would be far larger (the 410 px Send form would get 720 px). Steps within 10 % of it are left out.
 */
export function shotWidths(cssWidth: number): number[] {
  const full = cssWidth * 2;
  const steps = STEPS.filter((width) => width < full * 0.9 && Math.abs(width - cssWidth) > cssWidth * 0.1);
  return [...steps, cssWidth, full].toSorted((a, b) => a - b);
}

/** File name in website/media of one copy */
export function shotFile(name: string, scheme: 'light' | 'dark', width: number, cssWidth: number): string {
  return width === cssWidth * 2 ? `${name}-${scheme}.webp` : `${name}-${scheme}-${width}w.webp`;
}
