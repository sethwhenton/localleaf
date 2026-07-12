export function trustedPdfExternalHref(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2048 || !/^https:\/\//iu.test(raw)) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export function pdfExternalLinkDescriptors(annotations = [], convertRectangle = (rect) => rect) {
  if (!Array.isArray(annotations) || typeof convertRectangle !== "function") return [];
  const descriptors = [];
  for (const annotation of annotations) {
    const href = trustedPdfExternalHref(annotation?.url);
    if (!href || !Array.isArray(annotation?.rect) || annotation.rect.length !== 4) continue;
    let converted;
    try {
      converted = convertRectangle(annotation.rect);
    } catch {
      continue;
    }
    if (!Array.isArray(converted) || converted.length !== 4 || converted.some((value) => !Number.isFinite(value))) {
      continue;
    }
    const left = Math.min(converted[0], converted[2]);
    const top = Math.min(converted[1], converted[3]);
    const width = Math.abs(converted[2] - converted[0]);
    const height = Math.abs(converted[3] - converted[1]);
    if (width < 1 || height < 1) continue;
    descriptors.push({
      href,
      label: String(annotation.title || annotation.contents || "Open PDF link").replace(/\s+/gu, " ").trim().slice(0, 180) || "Open PDF link",
      left,
      top,
      width,
      height
    });
  }
  return descriptors;
}

export function scalePdfExternalLinkDescriptor(descriptor, ratio) {
  const scale = Number(ratio);
  const left = Number(descriptor?.left);
  const top = Number(descriptor?.top);
  const width = Number(descriptor?.width);
  const height = Number(descriptor?.height);
  if (![scale, left, top, width, height].every(Number.isFinite) || scale <= 0) return null;
  return {
    ...descriptor,
    left: left * scale,
    top: top * scale,
    width: width * scale,
    height: height * scale
  };
}
