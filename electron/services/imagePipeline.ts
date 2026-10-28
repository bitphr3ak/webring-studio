import * as jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Turns a local photo into web-ready files: decoded, rotated upright (EXIF orientation),
 * downscaled, and re-encoded. Re-encoding from raw pixels drops every metadata block (EXIF,
 * including GPS location, XMP, comments), so nothing about the camera or place is published.
 * Pure JavaScript (jpeg-js, pngjs): runs in Electron, the MCP CLI and tests alike, with
 * nothing to compile.
 */

export type ImageFormat = 'jpeg' | 'png';

export interface RawImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel */
  data: Uint8Array;
}

export interface EncodedImage {
  buffer: Buffer;
  width: number;
  height: number;
  format: ImageFormat;
  mimeType: string;
  extension: string;
}

export const WEB_MAX_SIDE = 2048;
export const THUMB_MAX_SIDE = 480;
const JPEG_QUALITY = 85;
const THUMB_JPEG_QUALITY = 80;
/** Refuse absurdly large inputs instead of exhausting memory while decoding. */
const MAX_INPUT_MEGAPIXELS = 120;

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedImageError';
  }
}

export function detectImageFormat(buffer: Buffer): ImageFormat | null {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  return null;
}

/** Reads the EXIF orientation tag (1–8) from a JPEG, or 1 when there isn't one. */
export function readJpegOrientation(buffer: Buffer): number {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return 1;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xda) return 1; // start of scan: no more metadata
    if (marker === 0xe1 && buffer.toString('ascii', offset + 4, offset + 10) === 'Exif\0\0') {
      const tiff = offset + 10;
      if (tiff + 8 > buffer.length) return 1;
      const little = buffer.toString('ascii', tiff, tiff + 2) === 'II';
      const u16 = (at: number) => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
      const u32 = (at: number) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > buffer.length) return 1;
      const entries = u16(ifd);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > buffer.length) return 1;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

export function decodeImage(buffer: Buffer): { image: RawImage; format: ImageFormat } {
  const format = detectImageFormat(buffer);
  if (format === 'jpeg') {
    const decoded = jpeg.decode(buffer, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_INPUT_MEGAPIXELS,
      maxMemoryUsageInMB: 1024,
    });
    const upright = applyOrientation(
      { width: decoded.width, height: decoded.height, data: decoded.data },
      readJpegOrientation(buffer)
    );
    return { image: upright, format };
  }
  if (format === 'png') {
    const decoded = PNG.sync.read(buffer);
    if (decoded.width * decoded.height > MAX_INPUT_MEGAPIXELS * 1_000_000) {
      throw new UnsupportedImageError('This image is too large to process.');
    }
    return { image: { width: decoded.width, height: decoded.height, data: decoded.data }, format };
  }
  throw new UnsupportedImageError(
    'Only JPEG and PNG photos are supported. Convert HEIC, WebP or other formats to JPEG first.'
  );
}

/** Rotates/flips pixels so the image displays upright without needing EXIF. */
export function applyOrientation(image: RawImage, orientation: number): RawImage {
  if (orientation <= 1 || orientation > 8) return image;
  const { width: w, height: h, data } = image;
  const swap = orientation >= 5;
  const outW = swap ? h : w;
  const outH = swap ? w : h;
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      switch (orientation) {
        case 2: nx = w - 1 - x; ny = y; break;
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;
        case 4: nx = x; ny = h - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = h - 1 - y; ny = x; break;
        case 7: nx = h - 1 - y; ny = w - 1 - x; break;
        default: nx = y; ny = w - 1 - x; break; // 8
      }
      const src = (y * w + x) * 4;
      const dst = (ny * outW + nx) * 4;
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = data[src + 3];
    }
  }
  return { width: outW, height: outH, data: out };
}

/**
 * Downscales so the longest side is at most `maxSide`, averaging every source pixel that falls
 * in each destination pixel (area averaging), which avoids the shimmer of nearest-neighbour.
 * Images already small enough are returned unchanged.
 */
export function resizeToFit(image: RawImage, maxSide: number): RawImage {
  const { width: w, height: h, data } = image;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (scale >= 1) return image;
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(outW * outH * 4);
  const xRatio = w / outW;
  const yRatio = h / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor(oy * yRatio);
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((oy + 1) * yRatio)));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor(ox * xRatio);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((ox + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (oy * outW + ox) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width: outW, height: outH, data: out };
}

export function encodeImage(image: RawImage, format: ImageFormat, quality = JPEG_QUALITY): EncodedImage {
  if (format === 'png') {
    const png = new PNG({ width: image.width, height: image.height });
    png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    return {
      buffer: PNG.sync.write(png, { colorType: 6 }),
      width: image.width,
      height: image.height,
      format,
      mimeType: 'image/png',
      extension: 'png',
    };
  }
  const encoded = jpeg.encode(
    { width: image.width, height: image.height, data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength) },
    quality
  );
  return {
    buffer: encoded.data,
    width: image.width,
    height: image.height,
    format,
    mimeType: 'image/jpeg',
    extension: 'jpg',
  };
}

/** The published web copy and thumbnail for one photo. */
export function makeWebImages(source: Buffer): { web: EncodedImage; thumb: EncodedImage } {
  const { image, format } = decodeImage(source);
  const webPixels = resizeToFit(image, WEB_MAX_SIDE);
  const thumbPixels = resizeToFit(webPixels, THUMB_MAX_SIDE);
  return {
    web: encodeImage(webPixels, format, JPEG_QUALITY),
    thumb: encodeImage(thumbPixels, format, THUMB_JPEG_QUALITY),
  };
}
