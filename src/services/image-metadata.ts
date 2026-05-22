export interface ImageDimensions {
  width: number;
  height: number;
}

export function readImageDimensions(body: ArrayBuffer, mimeType: string): ImageDimensions | null {
  const bytes = new Uint8Array(body);
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return readPngDimensions(bytes);
    case "image/jpeg":
      return readJpegDimensions(bytes);
    case "image/webp":
      return readWebpDimensions(bytes);
    default:
      return null;
  }
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24 || !matchesAscii(bytes, 1, "PNG") || !matchesAscii(bytes, 12, "IHDR")) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return validDimensions(width, height);
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    if (offset + 2 > bytes.length) {
      return null;
    }

    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return null;
    }

    if (isJpegSofMarker(marker) && segmentLength >= 7) {
      const height = view.getUint16(offset + 3, false);
      const width = view.getUint16(offset + 5, false);
      return validDimensions(width, height);
    }

    offset += segmentLength;
  }

  return null;
}

function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30 || !matchesAscii(bytes, 0, "RIFF") || !matchesAscii(bytes, 8, "WEBP")) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > bytes.length) {
      return null;
    }

    if (chunkType === "VP8X" && chunkSize >= 10) {
      const width = 1 + readUint24LE(bytes, dataOffset + 4);
      const height = 1 + readUint24LE(bytes, dataOffset + 7);
      return validDimensions(width, height);
    }

    if (chunkType === "VP8 " && chunkSize >= 10) {
      const width = view.getUint16(dataOffset + 6, true) & 0x3fff;
      const height = view.getUint16(dataOffset + 8, true) & 0x3fff;
      return validDimensions(width, height);
    }

    if (chunkType === "VP8L" && chunkSize >= 5) {
      const b1 = bytes[dataOffset + 1] ?? 0;
      const b2 = bytes[dataOffset + 2] ?? 0;
      const b3 = bytes[dataOffset + 3] ?? 0;
      const b4 = bytes[dataOffset + 4] ?? 0;
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + ((b4 << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return validDimensions(width, height);
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  return null;
}

function isJpegSofMarker(marker: number | undefined): boolean {
  return marker !== undefined
    && marker >= 0xc0
    && marker <= 0xcf
    && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function validDimensions(width: number, height: number): ImageDimensions | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    width,
    height
  };
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function matchesAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  return ascii(bytes, offset, value.length) === value;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return output;
}
