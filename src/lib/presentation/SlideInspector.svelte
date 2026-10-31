<script lang="ts">
	import { t, type MessageKey } from '#lib/i18n/index.js';
	import type { PresentationEditor, NumericProperty } from './editor.svelte';
	let { editor, multiSelect = false }: { editor: PresentationEditor; multiSelect?: boolean } =
		$props();
	const numeric: NumericProperty[] = [
		'x',
		'y',
		'width',
		'height',
		'rotation',
		'fontSize',
		'strokeWidth'
	];
	function numberProperty(key: NumericProperty, event: Event) {
		const value = Number((event.currentTarget as HTMLInputElement).value);
		if (Number.isFinite(value)) editor.setProperty(key, value);
	}
</script>

{#snippet action(id: string, label: MessageKey, run: () => void, disabled = false)}
	<button type="button" data-testid={'slide-' + id} onclick={run} {disabled}>{t(label)}</button>
{/snippet}

<aside class="slide-inspector" aria-label={t('slides.properties')} data-testid="slide-inspector">
	<h2>{t('slides.properties')}</h2>
	{#if editor.primary}
		<p class="selection-count">{t('slides.selectionCount', { n: editor.selected.length })}</p>
		<fieldset>
			<legend>{t('slides.position')}</legend>
			<div class="fields">
				{#each numeric as key (key)}
					<label
						>{t(`slides.${key}`)}
						<input
							type="number"
							data-testid={'slide-prop-' + key}
							step={key === 'rotation' ? 1 : 0.5}
							value={Math.round(editor.primary[key] * 100) / 100}
							onchange={(event) => numberProperty(key, event)}
						/>
					</label>
				{/each}
			</div>
		</fieldset>
		<fieldset>
			<legend>{t('slides.fill')}</legend>
			<div class="fields">
				{#each ['fill', 'stroke', 'color'] as key (key)}
					<label
						>{t(`slides.${key}` as MessageKey)}
						<input
							type="color"
							data-testid={'slide-prop-' + key}
							value={editor.primary[key as 'fill' | 'stroke' | 'color'] === 'transparent'
								? '#ffffff'
								: editor.primary[key as 'fill' | 'stroke' | 'color']}
							onchange={(event) =>
								editor.setProperty(key as 'fill' | 'stroke' | 'color', event.currentTarget.value)}
						/>
					</label>
				{/each}
			</div>
			<label class="checkbox"
				><input
					type="checkbox"
					checked={editor.primary.fill === 'transparent'}
					onchange={(event) =>
						editor.setProperty('fill', event.currentTarget.checked ? 'transparent' : '#dbeafe')}
				/>{t('slides.transparent')}</label
			>
			<label
				>{t('slides.textAlign')}
				<select
					data-testid="slide-prop-textAlign"
					value={editor.primary.textAlign}
					onchange={(event) => editor.setProperty('textAlign', event.currentTarget.value)}
				>
					{#each ['left', 'center', 'right'] as alignment (alignment)}<option value={alignment}
							>{t(`slides.${alignment}` as MessageKey)}</option
						>{/each}
				</select>
			</label>
		</fieldset>
		{#if editor.primary.type === 'line' || editor.primary.type === 'arrow'}
			<div class="fields">
				{#each ['startId', 'endId'] as endpoint (endpoint)}
					<label
						>{t(`slides.${endpoint}` as MessageKey)}
						<select
							data-testid={'slide-prop-' + endpoint}
							value={editor.primary[endpoint as 'startId' | 'endId'] ?? ''}
							onchange={(event) =>
								editor.change(() => {
									const element = editor.primary;
									if (!element) return;
									if (event.currentTarget.value)
										element[endpoint as 'startId' | 'endId'] = event.currentTarget.value;
									else delete element[endpoint as 'startId' | 'endId'];
								})}
						>
							<option value="">{t('slides.unattached')}</option>
							{#each editor.slide.elements.filter((element) => element.id !== editor.primary?.id && element.type !== 'arrow' && element.type !== 'line') as element, index (element.id)}
								<option value={element.id}
									>{t(`slides.${element.type}`)}
									{index + 1}{element.content ? `: ${element.content.slice(0, 30)}` : ''}</option
								>
							{/each}
						</select>
					</label>
				{/each}
			</div>
		{/if}
		<div class="actions">
			{@render action('group', 'slides.group', () => editor.group(), editor.selected.length < 2)}
			{@render action(
				'ungroup',
				'slides.ungroup',
				() => editor.ungroup(),
				!editor.elements.some((element) => element.groupId)
			)}
			{@render action(
				'connect',
				'slides.connect',
				() => editor.connect(),
				editor.selected.length !== 2
			)}
			{@render action('front', 'slides.front', () => editor.layer('front'))}
			{@render action('back', 'slides.back', () => editor.layer('back'))}
			{@render action('forward', 'slides.forward', () => editor.layer('forward'))}
			{@render action('backward', 'slides.backward', () => editor.layer('backward'))}
		</div>
		<div class="actions">
			{#each ['left', 'center', 'right', 'top', 'middle', 'bottom'] as alignment (alignment)}
				{@render action(
					'align-' + alignment,
					`slides.align${alignment[0]!.toUpperCase()}${alignment.slice(1)}` as MessageKey,
					() => editor.align(alignment as 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom')
				)}
			{/each}
			{@render action(
				'distribute-horizontal',
				'slides.distributeHorizontal',
				() => editor.distribute('x'),
				editor.selected.length < 3
			)}
			{@render action(
				'distribute-vertical',
				'slides.distributeVertical',
				() => editor.distribute('y'),
				editor.selected.length < 3
			)}
		</div>
	{/if}
	<fieldset>
		<legend>{t('slides.slides')}</legend>
		<label
			>{t('slides.background')}<input
				type="color"
				data-testid="slide-background"
				value={editor.slide.background}
				onchange={(event) =>
					editor.change(() => {
						editor.slide.background = event.currentTarget.value;
					})}
			/></label
		>
		<label
			>{t('slides.aspect')}
			<select
				data-testid="slide-aspect"
				value={editor.deck.width === editor.deck.height
					? '1:1'
					: editor.deck.width / editor.deck.height < 1.5
						? '4:3'
						: '16:9'}
				onchange={(event) => editor.setAspect(event.currentTarget.value)}
			>
				<option value="16:9">16:9</option><option value="4:3">4:3</option><option value="1:1"
					>1:1</option
				>
			</select>
		</label>
		<label
			>{t('slides.theme')}
			<select
				data-testid="slide-theme"
				value={editor.deck.theme}
				onchange={(event) =>
					editor.change(() => {
						editor.deck.theme = event.currentTarget.value;
						for (const slide of editor.deck.slides) {
							slide.background =
								editor.deck.theme === 'dark'
									? '#172033'
									: editor.deck.theme === 'amber'
										? '#fff7e6'
										: '#ffffff';
							for (const element of slide.elements) {
								if (element.type === 'text')
									element.color = editor.deck.theme === 'dark' ? '#f8fafc' : '#172033';
							}
						}
					})}
			>
				<option value="light">{t('slides.themeLight')}</option><option value="dark"
					>{t('slides.themeDark')}</option
				><option value="amber">{t('slides.themeAmber')}</option>
			</select>
		</label>
	</fieldset>
	{#if editor.slide.elements.length}
		<fieldset>
			<legend>{t('slides.objects')}</legend>
			<div class="object-list">
				{#each editor.slide.elements as element, index (element.id)}
					<button
						type="button"
						aria-pressed={editor.selected.includes(element.id)}
						data-testid="slide-object-list-item"
						onclick={(event) =>
							editor.select(
								element.id,
								multiSelect || event.shiftKey || event.metaKey || event.ctrlKey
							)}
					>
						{t(`slides.${element.type}`)}
						{index + 1}
						{element.type !== 'image' ? element.content.slice(0, 28) : ''}
					</button>
				{/each}
			</div>
		</fieldset>
	{/if}
</aside>

<style>
	.slide-inspector {
		width: 252px;
		height: 100%;
		overflow: auto;
		padding: 16px;
		border-left: 1px solid var(--color-border);
		background: var(--color-bg-1);
		color: var(--color-fg);
		font-size: 12px;
	}
	h2 {
		margin: 0 0 12px;
		font-size: 14px;
		font-weight: 650;
	}
	.selection-count {
		color: var(--color-fg-muted);
		margin-bottom: 12px;
	}
	fieldset {
		margin: 0 0 16px;
		padding: 0;
		border: 0;
	}
	legend {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-fg-muted);
		margin-bottom: 10px;
	}
	.fields {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-bottom: 8px;
		min-width: 0;
	}
	input,
	select {
		width: 100%;
		min-width: 0;
		min-height: 36px;
		border: 1px solid var(--color-border-strong);
		border-radius: 5px;
		background: var(--color-bg);
		color: var(--color-fg);
		padding: 5px 8px;
	}
	input[type='color'] {
		padding: 3px;
	}
	.checkbox {
		flex-direction: row;
		align-items: center;
	}
	.checkbox input {
		width: 16px;
		min-height: 16px;
	}
	.actions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
		margin-bottom: 16px;
	}
	button {
		min-height: 36px;
		padding: 6px 8px;
		border: 1px solid var(--color-border);
		border-radius: 5px;
		text-align: left;
		background: var(--color-bg);
		color: var(--color-fg);
		cursor: pointer;
	}
	button:hover,
	button[aria-pressed='true'] {
		background: var(--color-bg-3);
		border-color: var(--color-accent);
	}
	button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	button:focus-visible,
	input:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}
	.object-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	@media (max-width: 767px) {
		.slide-inspector {
			width: 100%;
			max-height: 36dvh;
			border-left: 0;
			border-top: 1px solid var(--color-border);
		}
		.fields {
			grid-template-columns: repeat(3, 1fr);
		}
		.actions {
			grid-template-columns: repeat(3, 1fr);
		}
	}
</style>
