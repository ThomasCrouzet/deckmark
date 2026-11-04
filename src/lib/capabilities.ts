import { EDITION, IS_DESKTOP_EDITION, IS_WEB_EDITION, type Edition } from './edition';

export type CapabilityState = 'available' | 'unsupported' | 'needs-permission';

export interface PlatformCapabilities {
	edition: Edition;
	fileSystemAccess: CapabilityState;
	nativeDisk: CapabilityState;
	nativeProjects: CapabilityState;
	secureCredentials: CapabilityState;
	git: CapabilityState;
	cli: CapabilityState;
	mcp: CapabilityState;
	globalCapture: CapabilityState;
	browserAi: CapabilityState;
	pwaOffline: CapabilityState;
}

export interface CapabilityInput {
	hasFileSystemAccess?: boolean;
	hasTauriRuntime?: boolean;
	hasWebGpu?: boolean;
}

/**
 * One typed capability table for UI and adapters. Web never advertises native
 * capabilities; desktop capabilities still depend on the runtime bridge.
 */
export function detectCapabilities(input: CapabilityInput = {}): PlatformCapabilities {
	const native = IS_DESKTOP_EDITION && input.hasTauriRuntime === true;
	const fsa = input.hasFileSystemAccess === true;
	return {
		edition: EDITION,
		fileSystemAccess: fsa ? 'available' : 'unsupported',
		nativeDisk: native ? 'available' : 'unsupported',
		nativeProjects: native ? 'available' : 'unsupported',
		secureCredentials: native ? 'available' : 'unsupported',
		git: native ? 'available' : 'unsupported',
		cli: native ? 'available' : 'unsupported',
		mcp: native ? 'available' : 'unsupported',
		globalCapture: native ? 'available' : 'unsupported',
		browserAi: input.hasWebGpu ? 'available' : 'unsupported',
		pwaOffline: IS_WEB_EDITION ? 'available' : 'unsupported'
	};
}

export function capabilityLabel(state: CapabilityState): string {
	if (state === 'available') return 'available';
	if (state === 'needs-permission') return 'permission required';
	return 'unsupported';
}
