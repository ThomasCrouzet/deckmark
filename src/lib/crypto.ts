// §2.8 - WebCrypto encryption (AES-GCM + PBKDF2).
//
// 100% client-side crypto core: no key ever leaves the session, no network.
// Used for ENCRYPTED BACKUPS (cf. services/backup) - the high-value /
// low-risk slice of "private by design": the user can export a backup file
// that is unreadable without the passphrase, without touching the app's
// boot/load path.
//
// Encryption at rest of ALL drafts (unlock gate at boot) is deliberately
// deferred: it requires a dedicated unlock-flow design (forgotten passphrase
// = data loss) - out of scope for this iteration. The envelope is versioned to
// allow that evolution.
//
// Envelope format (JSON): { v, alg, kdf, iter, salt, iv, ct } - random salt +
// IV per encryption, explicit parameters to decrypt without assuming hardcoded
// constants.

import { t } from '#lib/i18n/index.js';

export const ENVELOPE_VERSION = 1;
// OWASP 2023 tier for PBKDF2-HMAC-SHA256. The iteration count is stored in the
// envelope (`iter`) and read back at decryption → increasing this constant only
// affects NEW backups; older ones (250k) remain readable.
const PBKDF2_ITERATIONS = 600_000;
// Version 1 supports the historical 250k and current 600k work factors.
// Reject larger imported work factors before key derivation.
const MAX_PBKDF2_ITERATIONS = PBKDF2_ITERATIONS;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedEnvelope {
	v: number;
	alg: 'AES-GCM';
	kdf: 'PBKDF2-SHA256';
	iter: number;
	/** PBKDF2 salt, base64. */
	salt: string;
	/** AES-GCM IV, base64. */
	iv: string;
	/** Ciphertext (+ GCM tag), base64. */
	ct: string;
}

function getCrypto(): Crypto {
	const c = globalThis.crypto;
	if (!c?.subtle) throw new Error(t('crypto.webCryptoUnavailable'));
	return c;
}

function toBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// TS 6 types `Uint8Array` generically over its buffer (`ArrayBufferLike`),
// whereas the WebCrypto API expects a `BufferSource` backed by an `ArrayBuffer`.
// Our views are always ArrayBuffer-backed at runtime → this cast reconciles the
// typing without copying.
function buf(view: Uint8Array): BufferSource {
	return view as unknown as BufferSource;
}

async function deriveKey(
	passphrase: string,
	salt: Uint8Array,
	iterations: number
): Promise<CryptoKey> {
	const crypto = getCrypto();
	const baseKey = await crypto.subtle.importKey(
		'raw',
		buf(new TextEncoder().encode(passphrase)),
		'PBKDF2',
		false,
		['deriveKey']
	);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt: buf(salt), iterations, hash: 'SHA-256' },
		baseKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/** Encrypts a string with a passphrase → serializable envelope. */
export async function encryptString(
	plaintext: string,
	passphrase: string
): Promise<EncryptedEnvelope> {
	if (!passphrase) throw new Error(t('crypto.emptyPassphrase'));
	const crypto = getCrypto();
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: buf(iv) },
		key,
		buf(new TextEncoder().encode(plaintext))
	);
	return {
		v: ENVELOPE_VERSION,
		alg: 'AES-GCM',
		kdf: 'PBKDF2-SHA256',
		iter: PBKDF2_ITERATIONS,
		salt: toBase64(salt),
		iv: toBase64(iv),
		ct: toBase64(new Uint8Array(ct))
	};
}

/**
 * Decrypts an envelope with the passphrase. Throws an error if the passphrase
 * is incorrect (GCM authentication failure) or if the envelope is corrupted.
 */
export async function decryptString(env: EncryptedEnvelope, passphrase: string): Promise<string> {
	if (!isEncryptedEnvelope(env)) throw new Error(t('crypto.invalidEnvelope'));
	// Anti-DoS bound on `iter` (read from an imported file) before deriving the key.
	if (!Number.isInteger(env.iter) || env.iter < 1 || env.iter > MAX_PBKDF2_ITERATIONS) {
		const e = new Error(t('crypto.invalidEnvelopeIterations'));
		e.name = 'DecryptError';
		throw e;
	}
	const crypto = getCrypto();
	// base64 decoding of the salt / IV / ciphertext BEFORE any crypto operation.
	// `atob` throws on malformed base64: without this try, a corrupted imported
	// envelope propagated a generic error (not `DecryptError`), masking the
	// actionable message on the UI side.
	let salt: Uint8Array;
	let iv: Uint8Array;
	let ct: Uint8Array;
	try {
		if (env.salt.length !== 24 || env.iv.length !== 16) throw new Error('Invalid field length');
		salt = fromBase64(env.salt);
		iv = fromBase64(env.iv);
		ct = fromBase64(env.ct);
		if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ct.length < 16) {
			throw new Error('Invalid field length');
		}
	} catch {
		const e = new Error(t('crypto.invalidEnvelopeEncoding'));
		e.name = 'DecryptError';
		throw e;
	}
	const key = await deriveKey(passphrase, salt, env.iter);
	let plain: ArrayBuffer;
	try {
		plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(ct));
	} catch {
		// Named error so the UI (SettingsPanel) can show this actionable message
		// instead of the generic "The restore failed.".
		const e = new Error(t('crypto.wrongPassphrase'));
		e.name = 'DecryptError';
		throw e;
	}
	return new TextDecoder().decode(plain);
}

/** Type guard: recognizes an encrypted envelope (to distinguish plain JSON). */
export function isEncryptedEnvelope(v: unknown): v is EncryptedEnvelope {
	if (typeof v !== 'object' || v === null) return false;
	const e = v as Record<string, unknown>;
	return (
		e.v === ENVELOPE_VERSION &&
		e.kdf === 'PBKDF2-SHA256' &&
		e.alg === 'AES-GCM' &&
		typeof e.salt === 'string' &&
		typeof e.iv === 'string' &&
		typeof e.ct === 'string' &&
		typeof e.iter === 'number'
	);
}
