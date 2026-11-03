/** Removes the final extension for display purposes. */
export function stripFileExtension(name: string): string {
	return name.replace(/\.[a-z0-9]{1,10}$/i, '');
}

export function stripMdExtension(name: string): string {
	return name.replace(/\.(md|markdown|mdx|txt)$/i, '');
}
