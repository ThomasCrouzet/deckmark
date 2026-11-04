// Web Light boundary for the quick capture native bridge.
// The capture window and its shortcut do not exist in this edition.

export interface CaptureStatus {
	registered: boolean;
	shortcut: string | null;
}

function unavailable(): never {
	throw new Error('Quick capture is not available in this edition.');
}

export async function showCaptureWindow(): Promise<void> {
	unavailable();
}

export async function hideCaptureWindow(): Promise<void> {
	unavailable();
}

export async function registerCaptureShortcut(_shortcut: string): Promise<void> {
	void _shortcut;
	unavailable();
}

export async function unregisterCaptureShortcut(): Promise<void> {
	unavailable();
}

export async function captureStatus(): Promise<CaptureStatus> {
	return unavailable();
}

export async function onCaptureReset(_handler: () => void): Promise<() => void> {
	void _handler;
	return () => {};
}
