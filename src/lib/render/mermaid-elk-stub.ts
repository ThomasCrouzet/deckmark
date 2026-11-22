// Build-time replacement for the Mermaid ELK layout chunk.
//
// Mermaid loads its layout engines through dynamic imports, and the ELK engine
// adds about 1.5 MB of code that this application never runs. `sanitize-html.ts`
// pins the Mermaid layout to dagre and protects the option, so ELK stays
// unreachable. The Vite configuration maps the ELK module to this stub and the
// built application carries no ELK code.
//
// If a future change requests ELK, the fail is immediate and clear.

export function render(): never {
	throw new Error('The ELK layout is not available in this build. Use the dagre layout.');
}
