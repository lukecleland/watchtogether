const MAX_EDGE = 2560;
const MAX_PIXELS = 6_000_000;
const PASSTHROUGH_BYTES = 1_500_000;
const WEBP_QUALITY = 0.86;

export interface PreparedImage {
  file: File;
  width: number;
  height: number;
}

function outputName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "") || "image";
  return `${stem}.webp`;
}

/** Decode, bound and compress an image before it enters persistence or WebRTC. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");

  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const edgeScale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const pixelScale = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
    const scale = Math.min(edgeScale, pixelScale);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    if (scale === 1 && file.size <= PASSTHROUGH_BYTES) return { file, width, height };

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the image.");
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error("This browser could not compress the image.")), "image/webp", WEBP_QUALITY);
    });
    if (scale === 1 && blob.size >= file.size) return { file, width, height };
    return { file: new File([blob], outputName(file.name), { type: blob.type, lastModified: file.lastModified }), width, height };
  } finally {
    bitmap.close();
  }
}
