import { isFSASupported } from './fsa';
import { isDesktop } from './desktop';

/** A disk-link backend exists. Action modules can then load on demand. */
export function isDiskLinkingAvailable(): boolean {
	return isFSASupported() || isDesktop();
}
