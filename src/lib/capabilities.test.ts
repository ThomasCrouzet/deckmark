import { describe, expect, it } from 'vitest';
import { capabilityLabel, detectCapabilities } from './capabilities';

describe('platform capabilities', () => {
	it('never advertises native capabilities in the Web edition', () => {
		const capabilities = detectCapabilities({ hasFileSystemAccess: true, hasTauriRuntime: true });
		expect(capabilities.edition).toBe('web');
		expect(capabilities.fileSystemAccess).toBe('available');
		expect(capabilities.nativeDisk).toBe('unsupported');
		expect(capabilities.nativeProjects).toBe('unsupported');
		expect(capabilities.secureCredentials).toBe('unsupported');
		expect(capabilities.git).toBe('unsupported');
		expect(capabilities.cli).toBe('unsupported');
		expect(capabilities.mcp).toBe('unsupported');
	});

	it('reports browser limits without disabling core features', () => {
		const capabilities = detectCapabilities({});
		expect(capabilities.fileSystemAccess).toBe('unsupported');
		expect(capabilities.pwaOffline).toBe('available');
		expect(capabilities.browserAi).toBe('unsupported');
		expect(capabilityLabel(capabilities.browserAi)).toBe('unsupported');
	});
});
