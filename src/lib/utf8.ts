/** Counts UTF-8 bytes without allocating an encoded copy. */
export function utf8ByteLength(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			index += 1;
		} else bytes += 3;
	}
	return bytes;
}
