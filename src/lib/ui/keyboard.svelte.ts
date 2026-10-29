import { browser } from '$app/env';
import { coreCommands } from './commands';
import { formatKbd, isMac } from '#lib/platform.js';
import { isDesktop } from '#lib/desktop.js';

export interface ShortcutBinding {
	key: string;
	shift: boolean;
}
type Overrides = Record<string, ShortcutBinding | null>;
export type ShortcutError = 'invalid' | 'reserved' | 'duplicate' | 'storage';

export function isReservedShortcut(binding: ShortcutBinding, desktop: boolean): boolean {
	// Keep editing shortcuts in the active component.
	if (['a', 'c', 'v', 'x', 'z', 'y', 'b', 'i', 'u', 'q', 'h', 'm'].includes(binding.key))
		return true;
	if (desktop) return false;
	return ['n', 'o', 'p', 'r', 't', 'w', 'l', 'e', 'h', 'j', 'd', 's', 'g', 'k', 'm'].includes(
		binding.key
	);
}

function isBinding(value: unknown): value is ShortcutBinding {
	if (!value || typeof value !== 'object') return false;
	const binding = value as Partial<ShortcutBinding>;

	return (
		typeof binding.key === 'string' &&
		/^[a-z0-9/,.;]$/.test(binding.key) &&
		typeof binding.shift === 'boolean'
	);
}

class KeyboardStore {
	overrides = $state<Overrides>({});
	get storageKey() {
		return `mdsh:shortcuts:${isDesktop() ? 'desktop' : 'web'}`;
	}
	binding(id: string): ShortcutBinding | null {
		if (Object.hasOwn(this.overrides, id)) return this.overrides[id] ?? null;
		const entry = coreCommands.find((command) => command.id === id);
		return entry ? { key: entry.key, shift: entry.shift } : null;
	}
	label(id: string): string | undefined {
		const binding = this.binding(id);
		return binding
			? formatKbd(`⌘${binding.shift ? '⇧' : ''}${binding.key.toUpperCase()}`)
			: undefined;
	}
	aria(id: string): string | undefined {
		const binding = this.binding(id);
		return binding
			? `${isMac() ? 'Meta' : 'Control'}+${binding.shift ? 'Shift+' : ''}${binding.key.toUpperCase()}`
			: undefined;
	}
	match(event: KeyboardEvent) {
		return coreCommands.find((command) => {
			const binding = this.binding(command.id);

			return (
				binding &&
				binding.shift === event.shiftKey &&
				(binding.key === event.key.toLowerCase() ||
					(binding.key === '.' && event.code === 'Period'))
			);
		});
	}
	validate(id: string, binding: ShortcutBinding | null): ShortcutError | null {
		if (!coreCommands.some((entry) => entry.id === id)) return 'invalid';
		if (binding === null) return null;
		if (!isBinding(binding)) return 'invalid';
		if (isReservedShortcut(binding, isDesktop())) return 'reserved';
		if (
			coreCommands.some((entry) => {
				if (entry.id === id) return false;
				const other = this.binding(entry.id);
				return other?.key === binding.key && other.shift === binding.shift;
			})
		)
			return 'duplicate';
		return null;
	}
	load(): void {
		if (!browser) return;
		this.overrides = {};
		try {
			const parsed: unknown = JSON.parse(localStorage.getItem(this.storageKey) ?? '{}');
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
			for (const [id, value] of Object.entries(parsed)) {
				if (value !== null && !isBinding(value)) continue;
				if (this.validate(id, value) === null) this.overrides = { ...this.overrides, [id]: value };
			}
		} catch {
			/* Keep default shortcuts when stored preferences are invalid. */
		}
	}
	private persist(overrides: Overrides): ShortcutError | null {
		if (!browser) return 'storage';
		try {
			localStorage.setItem(this.storageKey, JSON.stringify(overrides));
		} catch {
			return 'storage';
		}
		this.overrides = overrides;
		window.dispatchEvent(new CustomEvent('mdsh:shortcuts-change'));
		return null;
	}
	set(id: string, binding: ShortcutBinding | null): ShortcutError | null {
		const error = this.validate(id, binding);
		return error ?? this.persist({ ...this.overrides, [id]: binding });
	}
	reset(): ShortcutError | null {
		return this.persist({});
	}
}

export const keyboardStore = new KeyboardStore();
