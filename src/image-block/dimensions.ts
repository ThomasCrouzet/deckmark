/**
 * Bounded raster dimension probes for local image data.
 *
 * These helpers read only the header bytes of a supported raster format. They
 * let the import path reject a huge bitmap before a decoder expands it, and
 * let the visual editor choose a bounded preview without decoding the
 * original first.
 */

export interface RasterDimensions {
	width: number;
	height: number;
}

/** Enough bytes for a JPEG whose EXIF thumbnail comes before the frame header. */
export const RASTER_HEADER_BYTES = 256 * 1024;

function view(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function png(bytes: Uint8Array): RasterDimensions | null {
	if (bytes.length < 24) return null;
	const marker = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (!marker.every((value, index) => bytes[index] === value)) return null;
	if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
	const data = view(bytes);
	return { width: data.getUint32(16), height: data.getUint32(20) };
}

function gif(bytes: Uint8Array): RasterDimensions | null {
	if (bytes.length < 10) return null;
	const signature = String.fromCharCode(...bytes.subarray(0, 6));
	if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
	const data = view(bytes);
	return { width: data.getUint16(6, true), height: data.getUint16(8, true) };
}

const JPEG_START_OF_FRAME = new Set([
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);

function jpeg(bytes: Uint8Array): RasterDimensions | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	const data = view(bytes);
	let offset = 2;
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) return null;
		const marker = bytes[offset + 1]!;
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) return null;
		const length = data.getUint16(offset + 2);
		if (length < 2) return null;
		if (JPEG_START_OF_FRAME.has(marker)) {
			if (offset + 9 > bytes.length) return null;
			return {
				height: data.getUint16(offset + 5),
				width: data.getUint16(offset + 7)
			};
		}
		offset += 2 + length;
	}
	return null;
}

function webp(bytes: Uint8Array): RasterDimensions | null {
	if (bytes.length < 30) return null;
	if (
		String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
		String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP'
	)
		return null;
	const chunk = String.fromCharCode(...bytes.subarray(12, 16));
	const data = view(bytes);
	if (chunk === 'VP8 ') {
		return {
			width: data.getUint16(26, true) & 0x3fff,
			height: data.getUint16(28, true) & 0x3fff
		};
	}
	if (chunk === 'VP8L') {
		if (bytes[20] !== 0x2f) return null;
		const b1 = bytes[21]!;
		const b2 = bytes[22]!;
		const b3 = bytes[23]!;
		const b4 = bytes[24]!;
		return {
			width: 1 + (((b2 & 0x3f) << 8) | b1),
			height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
		};
	}
	if (chunk === 'VP8X') {
		const width = bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16);
		const height = bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16);
		return { width: 1 + width, height: 1 + height };
	}
	return null;
}

/** Reads raster dimensions from header bytes. Returns null for SVG and AVIF. */
export function probeImageDimensions(bytes: Uint8Array, mime: string): RasterDimensions | null {
	let dimensions: RasterDimensions | null = null;
	if (mime === 'image/png') dimensions = png(bytes);
	else if (mime === 'image/jpeg') dimensions = jpeg(bytes);
	else if (mime === 'image/gif') dimensions = gif(bytes);
	else if (mime === 'image/webp') dimensions = webp(bytes);
	if (!dimensions) return null;
	if (!Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height)) return null;
	if (dimensions.width <= 0 || dimensions.height <= 0) return null;
	return dimensions;
}
