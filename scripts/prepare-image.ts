// Node twin of the admin's browser image pipeline (src/lib/client-image.ts),
// for the seed scripts: the same rules (src/lib/image-rules.ts) through
// `sharp` — a WebP at most 480 px wide for the store and, for product photos,
// a JPEG at most 1024 px wide for the catalog feeds. Height follows the source.
//
// lazy: `sharp` is Astro's own image dependency (see generate-card-derivatives.mjs);
// if Astro ever drops it, add it as a devDependency.
import sharp from "sharp";
import { IMAGE_QUALITIES, IMAGE_VARIANTS, type ImageVariant } from "../src/lib/image-rules.ts";

async function encode(source: Buffer, variant: ImageVariant): Promise<Buffer> {
  const rule = IMAGE_VARIANTS[variant];
  for (const quality of IMAGE_QUALITIES) {
    const pipeline = sharp(source).rotate().resize({ width: rule.maxWidth, withoutEnlargement: true });
    const out = rule.type === "image/webp"
      ? await pipeline.webp({ quality: Math.round(quality * 100) }).toBuffer()
      : await pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: Math.round(quality * 100), mozjpeg: true }).toBuffer();
    if (out.byteLength <= rule.maxBytes) return out;
  }
  throw new Error(`image too detailed for the ${variant} budget`);
}

/** The display WebP and, when asked, the catalog JPEG, as Files ready for /api/admin/upload-r2. */
export async function prepareImage(source: Buffer | Uint8Array, name: string, options: { feed?: boolean } = {}) {
  const input = Buffer.from(source);
  const display = new File([new Uint8Array(await encode(input, "display"))], `${name}.webp`, { type: "image/webp" });
  const feed = options.feed ? new File([new Uint8Array(await encode(input, "feed"))], `${name}.jpg`, { type: "image/jpeg" }) : null;
  return { display, feed };
}
