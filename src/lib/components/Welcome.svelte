<script lang="ts">
	import {
		FilePlus,
		Upload,
		Compass,
		FolderOpen,
		Presentation,
		FileText,
		Check,
		ShieldCheck,
		Download,
		ExternalLink
	} from '@lucide/svelte';
	import { isDesktop } from '#lib/desktop.js';
	import { IS_DESKTOP_EDITION } from '#lib/edition.js';
	import { keyboardStore } from '#lib/ui/keyboard.svelte.js';
	import { t } from '#lib/i18n/index.js';
	import BrandLogo from './BrandLogo.svelte';
	import SiteFooter from './SiteFooter.svelte';

	interface Props {
		onNew: () => void;
		onImport: () => void;
		onDemo: () => void;
		onLibrary?: () => void;
		onNewPresentation?: (() => void) | undefined;
		documentCount?: number;
		/** True once the saved library has loaded, so the first-visit view never flashes for a returning user. */
		libraryReady?: boolean;
	}

	let {
		onNew,
		onImport,
		onDemo,
		onLibrary,
		onNewPresentation,
		documentCount = 0,
		libraryReady = false
	}: Props = $props();

	// First visit: the library has loaded and holds no document. A returning user
	// never sees the introduction.
	const firstVisit = $derived(libraryReady && documentCount === 0);
	// The desktop app has no use for a link to its own installers. The edition
	// check covers a Desktop build that runs outside the native shell.
	const showDesktopLink = !IS_DESKTOP_EDITION && !isDesktop();
	// Installers live on the `desktop-v<version>` pre-releases, not on the stable release.
	const DESKTOP_RELEASES_URL =
		'https://github.com/ThomasCrouzet/deckmark/releases?q=desktop&expanded=true';
	const GITHUB_URL = 'https://github.com/ThomasCrouzet/deckmark';
</script>

{#snippet startActions()}
	<button data-testid="welcome-new" class="welcome-action welcome-action-primary" onclick={onNew}>
		<span class="welcome-action-icon"><FilePlus size={16} /></span>
		<span class="flex-1">{t('welcome.newFile')}</span>
		<kbd>{keyboardStore.label('new') ?? ''}</kbd>
	</button>
	{#if onNewPresentation}
		<button
			data-testid="welcome-new-presentation"
			class="welcome-action welcome-action-secondary"
			onclick={onNewPresentation}
		>
			<span class="welcome-action-icon"><Presentation size={16} /></span>
			<span class="flex-1">{t('welcome.newPresentation')}</span>
		</button>
	{/if}
	<button
		data-testid="welcome-demo"
		class="welcome-action welcome-action-secondary"
		onclick={onDemo}
	>
		<span class="welcome-action-icon"><Compass size={16} /></span>
		<span class="flex-1">{t('welcome.openDemo')}</span>
	</button>
	<button
		data-testid="welcome-import"
		class="welcome-action welcome-action-secondary"
		onclick={onImport}
	>
		<span class="welcome-action-icon"><Upload size={16} /></span>
		<span class="flex-1">{t('welcome.importMd')}</span>
		<kbd>{keyboardStore.label('import') ?? ''}</kbd>
	</button>
{/snippet}

<div
	class="welcome-shell flex h-full flex-col items-center px-6 py-10 sm:px-10 lg:px-[8vw]"
	class:welcome-shell-first={firstVisit}
>
	{#if firstVisit}
		<!-- First visit. The reading order is the visual order: the title, the pitch,
		     the facts, the start actions, the links, then the three points. -->
		<section class="welcome-console welcome-first-visit w-full" aria-labelledby="welcome-title">
			<div class="welcome-hero">
				<div class="welcome-intro">
					<h1 id="welcome-title" class="welcome-title">
						<span class="welcome-brand"><BrandLogo /></span>
						<span class="welcome-title-text">{t('landing.title')}</span>
					</h1>
					<p class="welcome-lead">{t('landing.lead')}</p>
					<ul class="welcome-facts" aria-label={t('landing.factsLabel')}>
						<li><Check size={14} aria-hidden="true" />{t('landing.factNoAccount')}</li>
						<li><Check size={14} aria-hidden="true" />{t('landing.factOffline')}</li>
						<li><Check size={14} aria-hidden="true" />{t('landing.factOpenSource')}</li>
					</ul>
				</div>

				<div class="welcome-actions">
					<div class="welcome-action-grid">
						{@render startActions()}
					</div>
					<div class="welcome-links">
						{#if showDesktopLink}
							<a
								class="welcome-link"
								data-testid="welcome-desktop-link"
								href={DESKTOP_RELEASES_URL}
								target="_blank"
								rel="noopener noreferrer"
								aria-describedby="welcome-desktop-hint"
							>
								<Download size={14} aria-hidden="true" />
								<span>{t('landing.desktopLink')}</span>
							</a>
							<span id="welcome-desktop-hint" class="sr-only">{t('landing.desktopHint')}</span>
						{/if}
						<a
							class="welcome-link"
							data-testid="welcome-github-link"
							href={GITHUB_URL}
							target="_blank"
							rel="noopener noreferrer"
						>
							<ExternalLink size={14} aria-hidden="true" />
							<span>{t('landing.githubLink')}</span>
						</a>
					</div>
				</div>

				<!-- Decorative figure built from markup and theme tokens. It makes no request.
				     One Markdown file is the source, and its first heading becomes a slide. -->
				<div class="welcome-visual" aria-hidden="true">
					<div class="welcome-visual-stage">
						<div class="welcome-visual-source">
							<div class="welcome-visual-tab">
								<FileText size={13} />
								<span>{t('landing.previewFile')}</span>
							</div>
							<ol class="welcome-visual-code">
								<li class="is-active">
									<span class="tok-h"># {t('landing.previewHeading')}</span>
								</li>
								<li></li>
								<li><span class="tok-m">- [x]</span> {t('landing.previewItemOne')}</li>
								<li><span class="tok-m">- [ ]</span> {t('landing.previewItemTwo')}</li>
								<li></li>
								<li><span class="tok-link">[[{t('landing.previewLink')}]]</span></li>
								<li></li>
								<li><span class="tok-m">---</span></li>
								<li></li>
								<li><span class="tok-h">## {t('landing.previewNext')}</span></li>
							</ol>
						</div>
						<div class="welcome-visual-wire"></div>
						<div class="welcome-visual-slide">
							<span class="welcome-visual-slide-title">{t('landing.previewHeading')}</span>
							<span class="welcome-visual-slide-rule"></span>
							<span class="welcome-visual-bullet">{t('landing.previewItemOne')}</span>
							<span class="welcome-visual-bullet">{t('landing.previewItemTwo')}</span>
							<span class="welcome-visual-count">1 / 2</span>
						</div>
					</div>
				</div>
			</div>

			<section class="welcome-pitch welcome-features" aria-label={t('landing.featuresLabel')}>
				<article>
					<h2><FileText size={15} aria-hidden="true" />{t('landing.notesTitle')}</h2>
					<p>{t('landing.notesText')}</p>
				</article>
				<article>
					<h2><Presentation size={15} aria-hidden="true" />{t('landing.slidesTitle')}</h2>
					<p>{t('landing.slidesText')}</p>
				</article>
				<article>
					<h2><ShieldCheck size={15} aria-hidden="true" />{t('landing.privateTitle')}</h2>
					<p>{t('landing.privateText')}</p>
				</article>
			</section>
		</section>

		<SiteFooter class="mt-auto w-full max-w-[72rem] shrink-0 pt-4" />
	{:else}
		<section class="welcome-console my-auto w-full max-w-4xl" aria-labelledby="welcome-title">
			<div class="welcome-grid">
				<div class="welcome-intro">
					<div class="mdsh-kicker mb-5">{t('welcome.systemLabel')}</div>
					<h1 id="welcome-title" class="welcome-title">
						<span class="welcome-brand"><BrandLogo /></span>
						<span class="welcome-title-text">{t('welcome.titleText')}</span>
					</h1>
					<div class="welcome-rule" aria-hidden="true"></div>
					<p class="mt-6 max-w-md text-base leading-relaxed text-fg-muted">
						{t('welcome.tagline')}
					</p>
					<p class="mt-3 max-w-md font-mono text-[11px] uppercase tracking-[0.08em] text-fg-subtle">
						{t('welcome.privacy')}
					</p>
					<p class="mt-3 max-w-md text-xs text-fg-muted">
						{t('welcome.persistence')}
					</p>
				</div>

				<div class="welcome-actions">
					{#if documentCount > 0 && onLibrary}
						<button
							class="welcome-action"
							onclick={(event) => {
								event.currentTarget.focus({ preventScroll: true });
								onLibrary?.();
							}}
						>
							<span class="welcome-action-icon"><FolderOpen size={16} /></span>
							<span>{t('library.browseCount', { n: documentCount })}</span>
						</button>
					{/if}
					{@render startActions()}
				</div>
			</div>

			<!-- §B4.2 - text-xs (12 px) rather than text-[10px]: 10 px fails the
			     default legibility criteria. fg-muted reaches 5:1 on a dark background. -->
			<div class="welcome-shortcuts font-mono text-xs text-fg-muted">
				<div>
					<kbd>{keyboardStore.label('export-md') ?? ''}</kbd><span>
						{t('welcome.legendExport')}
					</span>
				</div>
				<div>
					<kbd>
						{keyboardStore.label('mode-wysiwyg') ?? ''} / {keyboardStore.label('mode-read') ?? ''} / {keyboardStore.label(
							'mode-source'
						) ?? ''}
					</kbd><span>{t('welcome.legendModes')}</span>
				</div>
				<div>
					<kbd>{keyboardStore.label('sidebar') ?? ''}</kbd><span>{t('welcome.legendPanel')}</span>
				</div>
				<div>
					<kbd>{keyboardStore.label('close-file') ?? ''}</kbd><span>
						{t('welcome.legendCloseTab')}
					</span>
				</div>
			</div>
		</section>

		<SiteFooter class="mt-8 w-full max-w-4xl shrink-0" />
	{/if}
</div>

<style>
	.welcome-shell {
		overflow-y: auto;
		align-items: safe center;
		background:
			linear-gradient(
				90deg,
				color-mix(in oklab, var(--color-bg-1) 46%, transparent),
				transparent 58%
			),
			transparent;
	}
	.welcome-console {
		position: relative;
		min-width: 0;
		border-top: 1px solid var(--color-border-strong);
		border-bottom: 1px solid var(--color-border);
		padding: clamp(2rem, 5vw, 4.5rem) clamp(1rem, 4vw, 3rem) 1.5rem;
	}
	.welcome-console::before,
	.welcome-console::after {
		content: '';
		position: absolute;
		top: -1px;
		height: 2px;
		background: var(--color-accent);
	}
	.welcome-console::before {
		left: 0;
		width: 112px;
	}
	.welcome-console::after {
		right: 0;
		width: 24px;
	}
	.welcome-grid {
		display: grid;
		grid-template-columns: minmax(300px, 1.3fr) minmax(260px, 0.8fr);
		gap: clamp(2rem, 7vw, 6rem);
		align-items: end;
	}
	.welcome-intro {
		min-width: 0;
	}
	.welcome-title {
		width: min(100%, 24rem);
	}
	.welcome-brand {
		display: block;
	}
	/* §750 - The heading carries real text. The logo stays the visual brand
	   mark above the text. */
	.welcome-title-text {
		display: block;
		margin-top: 1rem;
		font-size: clamp(1.05rem, 2.4vw, 1.3rem);
		font-weight: 500;
		line-height: 1.3;
		color: var(--color-fg);
	}
	.welcome-rule {
		width: min(100%, 380px);
		height: 1px;
		margin-top: 1.8rem;
		background: linear-gradient(90deg, var(--color-accent), var(--color-border) 42%, transparent);
	}
	.welcome-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding-bottom: 0.2rem;
	}
	.welcome-action {
		display: flex;
		width: 100%;
		min-height: 48px;
		align-items: center;
		gap: 0.75rem;
		border: 1px solid var(--color-border);
		background: var(--color-bg-1);
		padding: 0.6rem 0.75rem;
		text-align: left;
		color: var(--color-fg);
	}
	/* The happy path is the filled accent. On the dark theme the on-accent text
	   keeps the 7.23:1 amber ratio; the light theme resolves its own pair. */
	.welcome-action-primary {
		border-color: var(--color-accent);
		background: var(--color-accent);
		color: var(--color-on-accent);
		font-weight: 600;
	}
	.welcome-action-primary .welcome-action-icon {
		border-right-color: color-mix(in oklab, var(--color-on-accent) 28%, transparent);
		color: var(--color-on-accent);
	}
	.welcome-action:hover {
		border-color: var(--color-accent-dim);
		background: var(--color-bg-2);
	}
	.welcome-action-primary:hover {
		border-color: var(--color-focus);
		background: var(--color-focus);
	}
	.welcome-action-secondary {
		color: var(--color-fg-muted);
	}
	.welcome-action-icon {
		display: grid;
		width: 28px;
		height: 28px;
		place-items: center;
		border-right: 1px solid var(--color-border);
		color: var(--color-accent);
	}
	.welcome-action kbd {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-fg-dim);
	}
	/* The hint on the filled accent uses the on-accent color at full strength.
	   It must follow the base kbd rule above: both rules have the same specificity. */
	.welcome-action-primary kbd {
		color: var(--color-on-accent);
	}
	.welcome-shortcuts {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 1px;
		margin-top: clamp(2.5rem, 6vw, 5rem);
		background: var(--color-border);
	}
	.welcome-shortcuts > div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.2rem;
		background: var(--color-bg);
		padding: 0.65rem 0.75rem;
	}
	.welcome-shortcuts kbd {
		color: var(--color-accent);
	}
	.welcome-shortcuts span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--color-fg-dim);
	}
	@media (max-width: 768px) {
		/* Shortcut chips are hidden below this width (see app.css), so the legend
		   would show labels without keys. */
		.welcome-shortcuts {
			display: none;
		}
	}
	@media (max-width: 920px) {
		.welcome-grid {
			grid-template-columns: minmax(0, 1fr);
			gap: 2.5rem;
		}
		.welcome-intro {
			max-width: 34rem;
		}
		.welcome-actions {
			max-width: 30rem;
		}
	}
	@media (max-width: 520px) {
		.welcome-shell {
			overflow-y: auto;
			align-items: safe center;
			align-items: flex-start;
			padding-inline: 1.5rem;
			padding-top: 2.25rem;
			overflow-y: auto;
		}
		.welcome-console {
			padding-inline: 1rem;
		}
		.welcome-shortcuts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.welcome-shortcuts span {
			white-space: normal;
			overflow-wrap: anywhere;
		}
	}
	@media (max-width: 240px) {
		.welcome-shell,
		.welcome-console {
			padding-inline: 8px;
		}
		.welcome-console {
			overflow-wrap: anywhere;
		}
		.welcome-action {
			flex-wrap: wrap;
			gap: 8px;
			padding: 8px;
		}
		.welcome-action > .flex-1 {
			min-width: 0;
			flex-basis: calc(100% - 36px);
		}
		.welcome-action-icon {
			flex-shrink: 0;
		}
	}

	/* ======================================================================
	   First visit. The view keeps the console rule, the amber tick and the
	   square bordered surfaces of the returning-user view. Every color is a
	   theme token. The rules follow the width of the home area, not the width
	   of the window, because the side panel takes a part of the window.
	   A browser without container queries gets the one-column layout.
	   ====================================================================== */
	.welcome-shell-first {
		container: welcome / inline-size;
		padding: clamp(0.5rem, 1.6vh, 1.25rem) clamp(1.25rem, 4vw, 2.5rem) 0.375rem;
	}
	/* A phone or a tablet in portrait. The page scrolls, so the last links get
	   some space before the edge of the screen. */
	@media (max-width: 1023px) {
		.welcome-shell-first {
			padding-bottom: 0.75rem;
		}
	}
	.welcome-first-visit {
		max-width: 72rem;
		margin-block: auto;
		border-bottom: 0;
		padding: clamp(1.5rem, 3.4vh, 2.5rem) 0 1rem;
	}
	.welcome-hero {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas:
			'intro'
			'actions'
			'visual';
		gap: 1.75rem clamp(2rem, 5cqi, 3rem);
		align-items: start;
	}
	.welcome-first-visit .welcome-intro {
		grid-area: intro;
		max-width: 38rem;
	}
	.welcome-first-visit .welcome-actions {
		grid-area: actions;
		max-width: 38rem;
		gap: 0.25rem;
		padding-bottom: 0;
	}
	.welcome-first-visit .welcome-title {
		width: auto;
	}
	.welcome-first-visit .welcome-brand {
		width: clamp(8.75rem, 34%, 11rem);
	}
	.welcome-first-visit .welcome-title-text {
		margin-top: 1.5rem;
		font-size: clamp(1.75rem, 1.2rem + 2.2vw, 2.5rem);
		font-weight: 600;
		line-height: 1.1;
		letter-spacing: -0.02em;
		text-wrap: balance;
	}
	@supports (font-size: 1cqi) {
		.welcome-first-visit .welcome-title-text {
			font-size: clamp(1.75rem, 1.2rem + 2.6cqi, 2.5rem);
		}
	}
	.welcome-lead {
		max-width: 34rem;
		margin: 1.25rem 0 0;
		font-size: 1.0625rem;
		line-height: 1.55;
		color: var(--color-fg-muted);
		text-wrap: pretty;
	}
	.welcome-facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 1rem;
		margin: 1.1rem 0 0;
		padding: 0;
		list-style: none;
	}
	.welcome-facts li {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.84375rem;
		font-weight: 500;
		line-height: 1.4;
		color: var(--color-fg);
	}
	.welcome-facts li :global(svg) {
		flex-shrink: 0;
		color: var(--color-accent);
	}
	.welcome-action-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 16.5rem), 1fr));
		gap: 0.5rem;
	}
	.welcome-first-visit .welcome-action {
		gap: 0.625rem;
	}
	.welcome-first-visit .welcome-action > .flex-1 {
		text-wrap: balance;
	}
	/* One filled action leads. The three other actions keep the full text
	   color and a border that shows on each theme. */
	.welcome-first-visit .welcome-action-secondary {
		border-color: color-mix(in oklab, var(--color-border-strong) 45%, var(--color-border));
		color: var(--color-fg);
	}
	.welcome-first-visit .welcome-action-secondary:hover {
		border-color: var(--color-accent-dim);
	}
	.welcome-links {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.5rem;
	}
	.welcome-link {
		display: inline-flex;
		min-height: 44px;
		align-items: center;
		gap: 0.5rem;
		font-size: 13px;
		color: var(--color-fg-muted);
		text-decoration: underline;
		text-decoration-color: var(--color-border-strong);
		text-underline-offset: 4px;
	}
	.welcome-link:hover {
		color: var(--color-accent);
		text-decoration-color: var(--color-accent);
	}

	/* The figure. One Markdown file is the source sheet. The slide sheet lies
	   over its corner, and a dashed wire joins the heading line to the slide.
	   Sizes use `em` from one base size, so the figure scales as one piece.
	   `--welcome-ratio` is the width of the stage divided by its height. */
	.welcome-visual {
		grid-area: visual;
		container: welcome-visual / inline-size;
		width: 100%;
		max-width: 36rem;
		user-select: none;
		pointer-events: none;
		--welcome-visual-shadow: rgb(0 0 0 / 0.85);
		--welcome-visual-edge: var(--color-border);
		--welcome-visual-slide: var(--color-bg-3);
	}
	:global(:root[data-theme='light']) .welcome-visual {
		--welcome-visual-shadow: color-mix(in oklab, var(--color-fg) 34%, transparent);
		--welcome-visual-slide: var(--color-bg-2);
		--welcome-visual-edge: color-mix(in oklab, var(--color-border-strong) 55%, var(--color-border));
	}
	.welcome-visual-stage {
		--welcome-ratio: 1.5;
		--welcome-source-edge: 66%;
		position: relative;
		aspect-ratio: var(--welcome-ratio);
		font-size: 12px;
	}
	@supports (font-size: 1cqi) {
		.welcome-visual-stage {
			font-size: clamp(11px, 3cqi, 15px);
		}
	}
	.welcome-visual-source {
		position: absolute;
		inset: 0 calc(100% - var(--welcome-source-edge)) 10% 0;
		overflow: hidden;
		border: 1px solid var(--welcome-visual-edge);
		background: var(--color-bg-1);
	}
	.welcome-visual-source::before {
		content: '';
		position: absolute;
		top: 0;
		left: 0;
		width: 5.5em;
		height: 2px;
		background: var(--color-accent);
	}
	.welcome-visual-tab {
		display: flex;
		height: 2.7em;
		align-items: center;
		gap: 0.55em;
		border-bottom: 1px solid var(--color-border);
		padding: 0 0.95em;
		font-family: var(--font-mono);
		font-size: 0.86em;
		color: var(--color-fg-dim);
	}
	.welcome-visual-tab :global(svg) {
		flex-shrink: 0;
		color: var(--color-accent);
	}
	.welcome-visual-code {
		margin: 0;
		padding: 0.75em 0;
		list-style: none;
		counter-reset: welcome-line;
		font-family: var(--font-mono);
		line-height: 1.62;
		white-space: nowrap;
		color: var(--color-fg);
	}
	.welcome-visual-code li {
		position: relative;
		min-height: 1.62em;
		padding-left: 3.3em;
		counter-increment: welcome-line;
	}
	.welcome-visual-code li::before {
		content: counter(welcome-line);
		position: absolute;
		left: 0;
		width: 2.2em;
		text-align: right;
		color: var(--color-fg-dim);
		opacity: 0.62;
	}
	/* The heading line carries an amber band. A heading uses the text color in
	   bold, like the title of the slide, so it keeps its contrast on the band. */
	.welcome-visual-code li.is-active {
		background: color-mix(in oklab, var(--color-accent) 18%, transparent);
	}
	.welcome-visual-code .tok-h {
		font-weight: 700;
	}
	.welcome-visual-code .tok-m {
		color: var(--color-fg-dim);
	}
	.welcome-visual-code .tok-link {
		color: var(--color-accent);
		text-decoration: underline;
		text-decoration-color: var(--color-border-strong);
		text-underline-offset: 3px;
	}
	/* The wire leaves the heading line at the edge of the source sheet and
	   goes down to the top edge of the slide, in line with the right edge of
	   the slide text. The slide is 62% wide at 16:9, so its share of the stage
	   height is 34.875% times the stage ratio. Its side padding is 8% of the
	   stage width. */
	.welcome-visual-wire {
		position: absolute;
		top: calc(2.7em * 0.86 + 0.75em + 0.81em + 1px);
		bottom: calc(34.875% * var(--welcome-ratio));
		left: var(--welcome-source-edge);
		width: calc(92% - var(--welcome-source-edge));
		border-top: 2px dashed var(--color-accent);
		border-right: 2px dashed var(--color-accent);
	}
	.welcome-visual-wire::before {
		content: '';
		position: absolute;
		top: -4px;
		left: -3px;
		width: 6px;
		height: 6px;
		background: var(--color-accent);
	}
	.welcome-visual-wire::after {
		content: '';
		position: absolute;
		right: -6px;
		bottom: -1px;
		border: 5px solid transparent;
		border-top: 7px solid var(--color-accent);
		border-bottom: 0;
	}
	.welcome-visual-slide {
		position: absolute;
		right: 0;
		bottom: 0;
		display: flex;
		width: 62%;
		aspect-ratio: 16 / 9;
		flex-direction: column;
		justify-content: center;
		gap: 0.55em;
		border: 1px solid var(--color-border-strong);
		background: var(--welcome-visual-slide);
		padding: 0 8% 0.4em;
		box-shadow:
			0 0.2em 0.5em -0.2em var(--welcome-visual-shadow),
			0 1.7em 3em -1.3em var(--welcome-visual-shadow);
	}
	.welcome-visual-slide-title {
		font-size: 1.6em;
		font-weight: 650;
		line-height: 1.15;
		letter-spacing: -0.015em;
		color: var(--color-fg);
	}
	.welcome-visual-slide-rule {
		width: 2.4em;
		height: 2px;
		margin-bottom: 0.15em;
		background: var(--color-accent);
	}
	.welcome-visual-bullet {
		position: relative;
		overflow: hidden;
		padding-left: 1.15em;
		font-size: 0.95em;
		line-height: 1.35;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-fg-muted);
	}
	.welcome-visual-bullet::before {
		content: '';
		position: absolute;
		top: 0.46em;
		left: 0;
		width: 0.38em;
		height: 0.38em;
		background: var(--color-accent);
	}
	.welcome-visual-count {
		position: absolute;
		right: calc(8% / 0.62);
		bottom: 0.85em;
		font-family: var(--font-mono);
		font-size: 0.74em;
		color: var(--color-fg-dim);
	}
	/* A narrow figure, on a phone. The source sheet takes more of the width
	   and drops the line numbers, so each line stays whole. */
	@container welcome-visual (width < 21rem) {
		.welcome-visual-stage {
			--welcome-ratio: 1.3333;
			--welcome-source-edge: 78%;
		}
		.welcome-visual-code li {
			padding-left: 1em;
		}
		.welcome-visual-code li::before {
			display: none;
		}
	}

	.welcome-pitch {
		margin-top: clamp(1.75rem, 4vh, 3rem);
		border-top: 1px solid var(--color-border);
		padding-top: clamp(1.25rem, 2.6vh, 1.75rem);
	}
	.welcome-features {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.25rem clamp(1.5rem, 4cqi, 3rem);
	}
	.welcome-features h2 {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin: 0 0 0.3rem;
		font-size: 0.95rem;
		font-weight: 600;
		line-height: 1.3;
		color: var(--color-fg);
	}
	/* The icon stays on the first line of a title that takes two lines. */
	.welcome-features h2 :global(svg) {
		flex-shrink: 0;
		margin-top: 0.16em;
		color: var(--color-accent);
	}
	.welcome-features p {
		max-width: 36rem;
		margin: 0;
		padding-left: calc(15px + 0.5rem);
		font-size: 13.5px;
		line-height: 1.55;
		color: var(--color-fg-muted);
		text-wrap: pretty;
	}

	/* A small phone. The pitch takes less height, so the first action stays
	   in the first screen in each language. */
	@container welcome (width < 24rem) {
		.welcome-lead {
			font-size: 1rem;
		}
	}
	/* The home area is wide enough for the copy and the figure side by side.
	   The start actions take one band below them, with the links at its end.
	   The figure is decoration, so the reading order and the focus order do
	   not change. */
	@container welcome (width >= 46rem) {
		.welcome-features {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		/* The three texts start on one line when a title takes two lines.
		   Each title sits on its text. */
		.welcome-features article {
			display: grid;
			grid-row: span 2;
			grid-template-rows: subgrid;
			row-gap: 0;
		}
		.welcome-features h2 {
			align-self: end;
		}
	}
	@container welcome (width >= 51rem) {
		.welcome-hero {
			grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
			grid-template-areas:
				'intro visual'
				'actions actions';
		}
		.welcome-first-visit .welcome-actions {
			max-width: none;
			flex-direction: row;
			gap: 1.5rem;
		}
		.welcome-action-grid {
			min-width: 0;
			flex: 1 1 auto;
		}
		.welcome-links {
			flex: none;
			flex-direction: column;
			gap: 0.5rem;
		}
		.welcome-link {
			flex: 1 1 0;
		}
		.welcome-first-visit .welcome-title-text {
			font-size: clamp(2rem, 0.2rem + 3.6cqi, 3rem);
		}
		.welcome-hero {
			row-gap: 1.5rem;
			align-items: center;
		}
		.welcome-visual {
			justify-self: end;
		}
	}
	/* A desktop window. The copy column holds two actions side by side in
	   each language, and the figure takes the height of the two rows. */
	@container welcome (width >= 68.5rem) {
		.welcome-hero {
			grid-template-columns: minmax(0, 1fr) minmax(0, clamp(28.5rem, 41%, 29.5rem));
			grid-template-areas:
				'intro visual'
				'actions visual';
			align-items: start;
		}
		/* The top edge of the figure meets the first line of the title. */
		.welcome-visual {
			margin-top: 2.9rem;
		}
		.welcome-first-visit .welcome-actions {
			flex-direction: column;
			gap: 0.25rem;
		}
		.welcome-links {
			flex-direction: row;
			gap: 0 1.5rem;
		}
		.welcome-link {
			flex: none;
		}
		.welcome-visual-stage {
			--welcome-ratio: 1.37;
		}
	}

	/* One authored moment: the wire draws from the heading line, then the slide
	   lands. The resting state is the visible state, and each animation ends,
	   so the figure tells the same thing with no motion. */
	@media (prefers-reduced-motion: no-preference) {
		.welcome-first-visit .welcome-action {
			transition:
				background-color 130ms ease-out,
				border-color 130ms ease-out;
		}
		.welcome-visual-wire {
			animation: welcome-wire 520ms cubic-bezier(0.16, 1, 0.3, 1) 260ms backwards;
		}
		.welcome-visual-slide {
			animation: welcome-slide 760ms cubic-bezier(0.16, 1, 0.3, 1) 520ms backwards;
		}
		.welcome-visual-slide > * {
			animation: welcome-slide-line 520ms cubic-bezier(0.16, 1, 0.3, 1) 760ms backwards;
		}
		.welcome-visual-slide > :nth-child(n + 3) {
			animation-delay: 840ms;
		}
		.welcome-visual-slide > :nth-child(n + 4) {
			animation-delay: 920ms;
		}
	}
	@keyframes welcome-wire {
		from {
			clip-path: inset(-8px 100% -8px -8px);
		}
		to {
			clip-path: inset(-8px -8px -8px -8px);
		}
	}
	@keyframes welcome-slide {
		from {
			opacity: 0;
			transform: translate(-1.2em, -1.6em);
		}
	}
	@keyframes welcome-slide-line {
		from {
			opacity: 0;
			transform: translateY(0.5em);
		}
	}

	@media (max-width: 240px) {
		.welcome-shell-first {
			padding-inline: 8px;
		}
		.welcome-first-visit {
			padding-inline: 0;
		}
	}
</style>
