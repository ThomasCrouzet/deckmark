<script lang="ts">
	import { onMount } from 'svelte';
	import type { EditorView } from '@codemirror/view';
	import { editorStateCache } from '#lib/editor-state.js';
	import { reportError } from '#lib/report.js';
	import { t } from '#lib/i18n/index.js';
	import {
		applySourceChanges,
		convertLineEndings,
		detectLineEnding
	} from '#lib/code/text-changes.js';
	import { codeLanguageForName, loadCodeLanguage } from '#lib/code/languages.js';
	import {
		analyzeJson,
		prepareJsonAction,
		validateJsonAgainstSchema,
		type JsonAnalysis
	} from '#lib/code/json-tools.js';

	interface Props {
		fileId: string;
		name: string;
		content: string;
		readonly?: boolean;
		onChange: (text: string) => void;
		onFlush?: (fileId: string, text: string) => void;
		onCursorLine?: (line: number) => void;
	}

	let {
		fileId,
		name,
		content,
		readonly = false,
		onChange,
		onFlush,
		onCursorLine
	}: Props = $props();

	const language = $derived(codeLanguageForName(name));
	let host = $state<HTMLDivElement>();
	let view: EditorView | null = null;
	let lastEmitted = '';
	let applyingExternal = false;
	let loadError = $state(false);
	let showInvisibles = $state(false);
	let wrap = $state(false);
	let indentStyle = $state<'space' | 'tab'>('space');
	let indentSize = $state(2);
	const eol = $derived(detectLineEnding(content));
	let optionCompartments: {
		indent: import('@codemirror/state').Compartment;
		wrap: import('@codemirror/state').Compartment;
		invisibles: import('@codemirror/state').Compartment;
	} | null = null;
	let cm: typeof import('@codemirror/view') | null = null;
	let historyFieldRef: import('@codemirror/state').StateField<unknown> | null = null;
	let indentUnitRef: typeof import('@codemirror/language').indentUnit | null = null;
	let invisiblesRef: import('@codemirror/state').Extension = [];
	let removeTabListener: (() => void) | null = null;
	let jsonCheck = $state<JsonAnalysis | null>(null);
	let jsonError = $state('');
	let jsonSchemaIssues = $state<string[]>([]);

	function indentUnitValue() {
		return indentStyle === 'tab' ? '\t' : ' '.repeat(indentSize);
	}

	function applyOptions() {
		if (!view || !optionCompartments || !cm || !indentUnitRef) return;
		view.dispatch({
			effects: [
				optionCompartments.indent.reconfigure(indentUnitRef.of(indentUnitValue())),
				optionCompartments.wrap.reconfigure(wrap ? cm.EditorView.lineWrapping : []),
				optionCompartments.invisibles.reconfigure(showInvisibles ? invisiblesRef : [])
			]
		});
	}

	$effect(() => {
		void showInvisibles;
		void wrap;
		void indentStyle;
		void indentSize;
		applyOptions();
	});

	$effect(() => {
		if (language.id !== 'json') return;
		const text = content;
		const timer = setTimeout(() => {
			jsonCheck = analyzeJson(text);
			jsonError = '';
			jsonSchemaIssues = jsonCheck.valid ? validateJsonAgainstSchema(text) : [];
		}, 150);
		return () => clearTimeout(timer);
	});

	function applyWholeDocument(text: string) {
		if (!view) return;
		const selection = Math.min(view.state.selection.main.head, text.length);
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: text },
			selection: { anchor: selection },
			scrollIntoView: true
		});
		view.focus();
	}

	function runJsonAction(action: 'format' | 'minify') {
		const result = prepareJsonAction(view ? lastEmitted : content, action, {
			indent: ' '.repeat(indentSize),
			eol
		});
		if (!result.ok) {
			jsonError = result.reason;
			return;
		}
		jsonError = '';
		applyWholeDocument(result.text);
	}

	$effect(() => {
		const incoming = content;
		if (!view || incoming === lastEmitted) return;
		applyingExternal = true;
		lastEmitted = incoming;
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: incoming }
		});
		applyingExternal = false;
	});

	onMount(() => {
		let disposed = false;
		void (async () => {
			try {
				const viewModule = await import('@codemirror/view');
				cm = viewModule;
				const [
					{ EditorState, Compartment },
					{ indentWithTab, defaultKeymap, history, historyField, historyKeymap },
					{ search, searchKeymap },
					{
						syntaxHighlighting,
						defaultHighlightStyle,
						indentOnInput,
						indentUnit,
						bracketMatching,
						foldGutter
					},
					{ closeBrackets },
					languageSupport,
					{ invisibleLineEnds: invisibleEnds }
				] = await Promise.all([
					import('@codemirror/state'),
					import('@codemirror/commands'),
					import('@codemirror/search'),
					import('@codemirror/language'),
					import('@codemirror/autocomplete'),
					loadCodeLanguage(language.id),
					import('#lib/code/invisibles.js')
				]);
				const {
					EditorView,
					keymap,
					lineNumbers,
					highlightActiveLine,
					highlightWhitespace,
					highlightTrailingWhitespace
				} = viewModule;
				if (disposed || !host) return;
				const mount = host;
				historyFieldRef = historyField as import('@codemirror/state').StateField<unknown>;
				indentUnitRef = indentUnit;
				invisiblesRef = [highlightWhitespace(), highlightTrailingWhitespace(), invisibleEnds];
				optionCompartments = {
					indent: new Compartment(),
					wrap: new Compartment(),
					invisibles: new Compartment()
				};
				const extensions = [
					lineNumbers(),
					highlightActiveLine(),
					history(),
					bracketMatching(),
					foldGutter(),
					closeBrackets(),
					indentOnInput(),
					search({ top: false }),
					keymap.of([indentWithTab, ...searchKeymap, ...defaultKeymap, ...historyKeymap]),
					optionCompartments.indent.of(indentUnit.of(indentUnitValue())),
					optionCompartments.wrap.of(wrap ? EditorView.lineWrapping : []),
					optionCompartments.invisibles.of([]),
					syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
					languageSupport,
					...(readonly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
					EditorView.updateListener.of((update) => {
						if (!update.selectionSet && !update.docChanged) return;
						onCursorLine?.(update.state.doc.lineAt(update.state.selection.main.head).number);
						if (update.docChanged && !applyingExternal && view) {
							const text = applySourceChanges(lastEmitted, update.startState, update.changes);
							if (text !== lastEmitted) {
								lastEmitted = text;
								onChange(text);
							}
						}
					}),
					EditorView.theme({
						'&': {
							height: '100%',
							color: 'var(--color-fg)',
							backgroundColor: 'var(--color-bg)'
						},
						'.cm-content': {
							fontFamily: 'var(--font-mono)',
							fontSize: '13px',
							padding: '12px 0'
						},
						'.cm-gutters': {
							backgroundColor: 'var(--color-bg-1)',
							color: 'var(--color-fg-dim)',
							borderRight: '1px solid var(--color-border)'
						},
						'.cm-activeLine': {
							backgroundColor: 'color-mix(in oklab, var(--color-bg-3) 45%, transparent)'
						},
						'.cm-activeLineGutter': { backgroundColor: 'var(--color-bg-2)' },
						'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
							backgroundColor: 'var(--color-accent)',
							opacity: '0.3'
						},
						'.cm-invisible-newline': { color: 'var(--color-fg-dim)', opacity: '0.6' }
					})
				];
				const cached = editorStateCache.getSourceState(fileId);
				const saved = editorStateCache.getPosition(fileId, 'source');
				let state: import('@codemirror/state').EditorState | undefined;
				if (cached?.content === content) {
					try {
						state = EditorState.fromJSON(cached.state, { extensions }, { history: historyField });
					} catch {
						// Ignore an incompatible cache.
					}
				}
				state ??= EditorState.create({ doc: content, extensions });
				view = new EditorView({ state, parent: mount });
				lastEmitted = content;
				const tabListener = (event: KeyboardEvent) => {
					if (
						event.key !== 'Tab' ||
						event.shiftKey ||
						event.altKey ||
						event.ctrlKey ||
						event.metaKey ||
						event.isComposing ||
						!view
					)
						return;
					const element = event.target;
					if (element instanceof Element && !element.closest('.cm-content')) return;
					if (!view.state.selection.main.empty) return;
					event.preventDefault();
					event.stopPropagation();
					const unit = indentUnitValue();
					const selection = view.state.selection.main;
					view.dispatch({
						changes: { from: selection.from, to: selection.to, insert: unit },
						selection: { anchor: selection.from + unit.length },
						scrollIntoView: true
					});
				};
				mount.addEventListener('keydown', tabListener, true);
				const flushListener = () => onFlush?.(fileId, lastEmitted);
				window.addEventListener('mdsh:flush-editor', flushListener);
				removeTabListener = () => {
					mount.removeEventListener('keydown', tabListener, true);
					window.removeEventListener('mdsh:flush-editor', flushListener);
				};
				requestAnimationFrame(() => {
					if (!view) return;
					if (saved) view.scrollDOM.scrollTop = saved.scrollTop;
					if (document.activeElement === document.body) view.focus();
				});
			} catch (error) {
				loadError = true;
				reportError('code editor load', error);
			}
		})();
		return () => {
			disposed = true;
			removeTabListener?.();
			removeTabListener = null;
			if (view) {
				// Route the final keystroke to its own file before the active tab
				// changes. Writing through onChange would target the new active file.
				onFlush?.(fileId, lastEmitted);
				editorStateCache.setSourceState(
					fileId,
					{
						content: lastEmitted,
						state: view.state.toJSON(historyFieldRef ? { history: historyFieldRef } : undefined)
					},
					{
						anchor: view.state.selection.main.anchor,
						head: view.state.selection.main.head,
						scrollTop: view.scrollDOM.scrollTop
					}
				);
				view.destroy();
				view = null;
			}
		};
	});

	function toggleLineEnding() {
		const next = eol === '\r\n' ? '\n' : '\r\n';
		const updated = convertLineEndings(view ? lastEmitted : content, next);
		lastEmitted = updated;
		onChange(updated);
	}

	export function goToLine(line: number) {
		if (!view) return;
		const target = Math.min(Math.max(1, line), view.state.doc.lines);
		const position = view.state.doc.line(target).from;
		view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
		view.focus();
	}

	/** Returns the selected text. The CodeMirror state keeps it after blur. */
	export function getSelectionText(): string {
		if (!view) return '';
		const { from, to } = view.state.selection.main;
		return from === to ? '' : view.state.sliceDoc(from, to);
	}
</script>

{#if loadError}
	<div class="code-error" role="alert">{t('source.loadErrorTitle')}</div>
{:else}
	<div class="code-shell">
		<div class="code-toolbar" role="toolbar" aria-label={t('code.toolbar')}>
			<span class="code-language" data-testid="code-language">{language.label}</span>
			<span class="code-eol" data-testid="code-eol">{eol === '\r\n' ? 'CRLF' : 'LF'}</span>
			<button type="button" onclick={toggleLineEnding} data-testid="code-eol-toggle">
				{eol === '\r\n' ? t('code.toLf') : t('code.toCrlf')}
			</button>
			<button
				type="button"
				aria-pressed={wrap}
				onclick={() => (wrap = !wrap)}
				data-testid="code-wrap">{t('code.wrap')}</button
			>
			<button
				type="button"
				aria-pressed={showInvisibles}
				onclick={() => (showInvisibles = !showInvisibles)}
				data-testid="code-invisibles">{t('code.invisibles')}</button
			>
			<label>
				<span>{t('code.indent')}</span>
				<select
					bind:value={indentStyle}
					aria-label={t('code.indentStyle')}
					data-testid="code-indent-style"
				>
					<option value="space">{t('code.spaces')}</option>
					<option value="tab">{t('code.tabs')}</option>
				</select>
			</label>
			<label>
				<span>{t('code.indentSize')}</span>
				<select
					bind:value={indentSize}
					aria-label={t('code.indentSize')}
					data-testid="code-indent-size"
				>
					<option value={2}>2</option>
					<option value={4}>4</option>
					<option value={8}>8</option>
				</select>
			</label>
			{#if language.id === 'json'}
				<span class="json-separator" aria-hidden="true"></span>
				{#if jsonCheck}
					<span
						class="json-status"
						class:valid={jsonCheck.valid}
						class:invalid={!jsonCheck.valid}
						role="status"
						data-testid="json-status"
					>
						{jsonCheck.valid
							? t('json.valid')
							: t('json.invalid', {
									line: jsonCheck.line ?? 1,
									column: jsonCheck.column ?? 1
								})}
					</span>
					{#if jsonCheck.duplicateKeys.length > 0}
						<span class="json-warning" data-testid="json-duplicates">
							{t('json.duplicates', { keys: jsonCheck.duplicateKeys.join(', ') })}
						</span>
					{/if}
					{#if jsonSchemaIssues.length > 0}
						<span class="json-warning" data-testid="json-schema">
							{t('json.schemaIssues', { n: jsonSchemaIssues.length })}
						</span>
					{/if}
				{/if}
				<button
					type="button"
					disabled={!jsonCheck?.valid}
					onclick={() => runJsonAction('format')}
					data-testid="json-format">{t('json.format')}</button
				>
				<button
					type="button"
					disabled={!jsonCheck?.valid}
					onclick={() => runJsonAction('minify')}
					data-testid="json-minify">{t('json.minify')}</button
				>
				{#if jsonError}
					<span class="json-error" role="alert" data-testid="json-action-error">{jsonError}</span>
				{/if}
			{/if}
		</div>
		<div bind:this={host} class="code-host" data-testid="code-editor"></div>
	</div>
{/if}

<style>
	.code-shell {
		display: flex;
		height: 100%;
		min-height: 0;
		flex-direction: column;
	}
	.code-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 4px 10px;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-1);
		font-size: 11px;
		color: var(--color-fg-muted);
	}
	.code-language {
		font-weight: 600;
		color: var(--color-fg);
	}
	.json-separator {
		width: 1px;
		align-self: stretch;
		background: var(--color-border);
	}
	.json-status {
		font-family: var(--font-mono);
	}
	.json-status.valid {
		color: var(--color-accent);
	}
	.json-status.invalid,
	.json-error {
		color: var(--color-danger);
	}
	.json-warning {
		color: var(--color-warning, #d19a66);
	}
	.code-eol {
		padding: 1px 5px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		font-family: var(--font-mono);
	}
	.code-toolbar button,
	.code-toolbar select {
		min-height: 30px;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xs);
		background: var(--color-bg-2);
		color: var(--color-fg);
		font-size: 11px;
	}
	.code-toolbar button[aria-pressed='true'] {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}
	.code-toolbar label {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.code-toolbar button:focus-visible,
	.code-toolbar select:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.code-host {
		min-height: 0;
		flex: 1;
		overflow: hidden;
	}
	.code-host :global(.cm-editor) {
		height: 100%;
	}
	.code-error {
		padding: 16px;
		color: var(--color-danger);
	}
</style>
