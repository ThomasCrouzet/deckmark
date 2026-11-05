// Pure command filtering for the palette. The Svelte component keeps command
// registration, capability checks and side effects.
import { normalizeCommandSearch } from './ui/commands';

export interface RankableCommand {
	label: string;
	keywords?: string | undefined;
}

/** Filter commands by the normalized label and keywords. */
export function filterCommands<T extends RankableCommand>(
	commands: readonly T[],
	query: string
): readonly T[] {
	const normalized = normalizeCommandSearch(query.trim());
	if (!normalized) return commands;
	return commands.filter((command) =>
		normalizeCommandSearch(`${command.label} ${command.keywords ?? ''}`).includes(normalized)
	);
}
