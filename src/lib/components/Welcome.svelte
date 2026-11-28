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
		/** True once the saved library has loaded. The view renders no layout before, so no layout is swapped for another. */
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
	// never sees the introduction. Until the library state is known, the view
	// renders no layout, so the first layout that shows is the final one and the
	// start actions are never replaced under the pointer.
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
	{#if !libraryReady}
		<!-- Library state unknown: render neither layout. -->
	{:else if firstVisit}
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
				     One Markdown file is the source. Its first heading becomes the title of a
				     slide, and its list becomes the points of the slide. -->
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
								<li><span class="tok-m">-</span> {t('landing.previewItemOne')}</li>
								<li><span class="tok-m">-</span> {t('landing.previewItemTwo')}</li>
								<li></li>
								<li><span class="tok-m">---</span></li>
								<li></li>
								<li><span class="tok-h">## {t('landing.previewNext')}</span></li>
							</ol>
						</div>
						<div class="welcome-visual-wire"></div>
						<div class="welcome-visual-slide">
							<span class="welcome-visual-slide-head">
								<span class="welcome-visual-slide-title">{t('landing.previewHeading')}</span>
								<span class="welcome-visual-wire-end"></span>
							</span>
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

		<SiteFooter class="welcome-footer w-full shrink-0" />
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
		padding: clamp(0.75rem, 2.2vh, 1.5rem) clamp(1.25rem, 4vw, 2.5rem) 0.375rem;
	}
	/* A phone or a tablet in portrait. The page scrolls, so the last links get
	   some space before the edge of the screen. */
	@media (max-width: 1023px) {
		.welcome-shell-first {
			padding-bottom: 0.75rem;
		}
	}
	/* The frame has four rows: a space, the hero, a space, the three points.
	   `--welcome-cell-gap` is the gap of the action grid, and the three points
	   use the same columns. Without subgrid, the frame takes the height of the
	   home area and the two spaces share what is left. */
	.welcome-first-visit {
		--welcome-gap: clamp(2rem, 5cqi, 3rem);
		--welcome-cell-gap: 0.5rem;
		display: grid;
		flex: 1 0 auto;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows:
			minmax(clamp(1.5rem, 4.5vh, 3rem), 1fr)
			auto
			minmax(clamp(1.75rem, 4.5vh, 3rem), 1fr)
			auto;
		max-width: 72rem;
		max-height: 58rem;
		margin-top: auto;
		border-bottom: 0;
		padding: 0;
	}
	.welcome-shell-first :global(.welcome-footer) {
		max-width: 72rem;
		margin-bottom: auto;
	}
	/* With subgrid, the home area gives the rows. The two spaces of the frame
	   grow first, by the same amount, to 10rem. Then the rest of the height
	   goes above the rule and below the footer in two equal parts. Thus the
	   rule stays near the top, the footer stays near the bottom, and the hero
	   stays in the middle. On a short window the spaces take their minimum
	   and the page scrolls. */
	@supports (grid-template-rows: subgrid) {
		.welcome-shell-first {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows:
				1fr
				minmax(clamp(1.5rem, 4.5vh, 3rem), 10rem)
				auto
				minmax(clamp(1.75rem, 4.5vh, 3rem), 10rem)
				auto
				auto
				1fr;
			justify-items: center;
		}
		.welcome-first-visit {
			grid-row: 2 / 6;
			grid-template-rows: subgrid;
			max-height: none;
			margin-top: 0;
		}
		.welcome-shell-first :global(.welcome-footer) {
			grid-row: 6;
			margin-bottom: 0;
		}
	}
	.welcome-hero {
		display: grid;
		grid-row: 2;
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas:
			'intro'
			'actions'
			'visual';
		gap: 1.75rem var(--welcome-gap);
		align-items: start;
	}
	.welcome-first-visit .welcome-intro {
		grid-area: intro;
		max-width: 38rem;
	}
	.welcome-first-visit .welcome-actions {
		grid-area: actions;
		max-width: 38rem;
		gap: 0.5rem;
		padding-bottom: 0;
	}
	.welcome-first-visit .welcome-title {
		width: auto;
	}
	.welcome-first-visit .welcome-brand {
		width: clamp(8.75rem, 34%, 11rem);
		margin-bottom: 1.5rem;
	}
	/* The side panel shows the wordmark. When the panel is on screen, the
	   heading keeps its text only. On a phone the panel is a drawer over the
	   page, so the heading keeps the wordmark. */
	@media (min-width: 768px) {
		:global(.mdsh-shell:has(.mdsh-sidebar:not([inert]))) .welcome-first-visit .welcome-brand {
			display: none;
		}
	}
	.welcome-first-visit .welcome-title-text {
		margin-top: 0;
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
		margin: 1.25rem 0 0;
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
		gap: var(--welcome-cell-gap);
	}
	.welcome-first-visit .welcome-action {
		gap: 0.625rem;
	}
	.welcome-first-visit .welcome-action > .flex-1 {
		text-wrap: balance;
	}
	.welcome-first-visit .welcome-action kbd {
		font-size: 11px;
	}
	.welcome-first-visit .welcome-action-secondary kbd {
		color: var(--color-fg-muted);
	}
	/* One filled action leads. The three other actions keep the full text
	   color. Their border has a contrast of 3:1 or more with the page and
	   with the button surface on each theme. */
	.welcome-first-visit .welcome-action-secondary {
		border-color: var(--color-border-strong);
		color: var(--color-fg);
	}
	.welcome-first-visit .welcome-action-secondary:hover {
		border-color: var(--color-accent);
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
	   over its lower right corner, below the last line that it uses, and a
	   dashed wire joins the heading line to the title of the slide.
	   Heights use `em` from one base size and widths use a share of the stage,
	   so the figure scales as one piece. The first grid row ends below line 4
	   of the source: the tab, the top space, four lines, then a margin. */
	.welcome-visual {
		grid-area: visual;
		container: welcome-visual / inline-size;
		width: 100%;
		max-width: 36rem;
		user-select: none;
		pointer-events: none;
		--welcome-visual-shadow: rgb(0 0 0 / 0.72);
		--welcome-visual-edge: var(--color-border);
		--welcome-visual-slide: var(--color-bg-3);
	}
	:global(:root[data-theme='light']) .welcome-visual {
		--welcome-visual-shadow: color-mix(in oklab, var(--color-fg) 24%, transparent);
		--welcome-visual-slide: var(--color-bg-2);
		--welcome-visual-edge: color-mix(in oklab, var(--color-border-strong) 55%, var(--color-border));
	}
	.welcome-visual-stage {
		--welcome-source-edge: 60%;
		--welcome-slide-share: 0.62;
		--welcome-slide-pad: 6%;
		--welcome-slide-pad-top: 1.5em;
		--welcome-slide-title: 1.45em;
		--welcome-gutter: 2.7em;
		--welcome-tab: 2.4em;
		--welcome-slide-top: calc(var(--welcome-tab) + 0.75em + 4 * 1.62em + 0.85em);
		position: relative;
		display: grid;
		grid-template-columns: 100%;
		grid-template-rows: var(--welcome-slide-top) auto;
		font-size: 13px;
	}
	@supports (font-size: 1cqi) {
		.welcome-visual-stage {
			font-size: clamp(12px, 3cqi, 17px);
		}
	}
	.welcome-visual-source {
		position: relative;
		grid-area: 1 / 1 / 3 / 2;
		align-self: start;
		width: var(--welcome-source-edge);
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
		height: var(--welcome-tab);
		align-items: center;
		gap: 0.5em;
		border-bottom: 1px solid var(--color-border);
		padding: 0 0.85em;
		font-family: var(--font-mono);
		color: var(--color-fg-muted);
	}
	.welcome-visual-tab span {
		font-size: max(11px, 0.9em);
	}
	.welcome-visual-tab :global(svg) {
		flex-shrink: 0;
		color: var(--color-accent);
	}
	.welcome-visual-code {
		margin: 0;
		padding: 0.75em 0 1em;
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
		padding-left: var(--welcome-gutter);
		counter-increment: welcome-line;
	}
	.welcome-visual-code li::before {
		content: counter(welcome-line);
		position: absolute;
		left: 0;
		width: calc(var(--welcome-gutter) - 1.1em);
		text-align: right;
		color: var(--color-fg-dim);
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
	/* The wire leaves the heading line at the edge of the source sheet, goes
	   right to the inner edge of the slide, then down to the middle of the
	   slide title. Its last part is a child of the slide: a dashed line with an
	   arrow head that points at the title. */
	.welcome-visual-wire {
		position: absolute;
		z-index: 1;
		top: calc(var(--welcome-tab) + 0.75em + 0.81em);
		right: calc(var(--welcome-slide-pad) + 1px);
		left: var(--welcome-source-edge);
		height: calc(
			var(--welcome-slide-top) + var(--welcome-slide-pad-top) + 0.575 * var(--welcome-slide-title) -
				var(--welcome-tab) - 0.75em - 0.81em + 2px
		);
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
	/* The slide is one surface step above the source sheet. A strong border
	   and a soft shadow with an offset show which sheet is on top. */
	.welcome-visual-slide {
		position: relative;
		grid-area: 2 / 1;
		justify-self: end;
		display: flex;
		width: calc(var(--welcome-slide-share) * 100%);
		aspect-ratio: 16 / 9;
		flex-direction: column;
		gap: 0.5em;
		border: 1px solid var(--color-border-strong);
		background: var(--welcome-visual-slide);
		padding: var(--welcome-slide-pad-top) var(--welcome-slide-pad) 0;
		box-shadow:
			0 0.35em 0.9em -0.1em var(--welcome-visual-shadow),
			0 1.5em 3em -0.9em var(--welcome-visual-shadow);
	}
	.welcome-visual-slide-head {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 0.75em;
	}
	.welcome-visual-slide-title {
		min-width: 0;
		flex: 0 1 auto;
		overflow: hidden;
		font-size: var(--welcome-slide-title);
		font-weight: 650;
		line-height: 1.15;
		letter-spacing: -0.015em;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--color-fg);
	}
	.welcome-visual-wire-end {
		position: relative;
		height: 0;
		flex: 1 0 1.5em;
		border-top: 2px dashed var(--color-accent);
	}
	.welcome-visual-wire-end::before {
		content: '';
		position: absolute;
		top: -6px;
		left: 0;
		border: 5px solid transparent;
		border-right: 7px solid var(--color-accent);
		border-left: 0;
	}
	.welcome-visual-slide-rule {
		width: 2.4em;
		height: 2px;
		flex: none;
		margin-bottom: 0.15em;
		background: var(--color-accent);
	}
	.welcome-visual-bullet {
		position: relative;
		flex: none;
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
		right: calc(var(--welcome-slide-pad) / var(--welcome-slide-share));
		bottom: 0.7em;
		font-family: var(--font-mono);
		font-size: max(11px, 0.85em);
		color: var(--color-fg-muted);
	}
	/* A narrow figure, on a phone. The source sheet takes more of the width
	   and drops the line numbers, so each line stays whole. The slide starts
	   below the last line and lies over the empty end of the sheet only. */
	@container welcome-visual (width < 23rem) {
		.welcome-visual-stage {
			--welcome-source-edge: 78%;
			--welcome-slide-share: 0.72;
			--welcome-slide-pad-top: 1.3em;
			--welcome-slide-title: 1.3em;
			--welcome-gutter: 1em;
			--welcome-slide-top: calc(var(--welcome-tab) + 0.75em + 8 * 1.62em + 0.5em);
		}
		.welcome-visual-code {
			padding-bottom: 2.5em;
		}
		.welcome-visual-code li::before {
			display: none;
		}
	}

	.welcome-pitch {
		grid-row: 4;
		border-top: 1px solid var(--color-border);
		padding: clamp(1.25rem, 3vh, 2.25rem) 0;
	}
	.welcome-features {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.25rem var(--welcome-cell-gap);
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
	/* Three columns for the three points. Each column keeps some space at its
	   end, because the gap between two columns is the gap between two actions. */
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
			padding-right: 1.5rem;
		}
		.welcome-features h2 {
			align-self: end;
		}
		.welcome-features p {
			max-width: 21rem;
		}
	}
	/* The home area is wide enough for the copy and the figure side by side.
	   The start actions take one band below them on a grid of three columns:
	   two columns of actions, then the links. The links need less width than
	   an action label, so their column is narrower. The three points use the
	   same three columns. The figure is decoration, so the reading order and
	   the focus order do not change. */
	@container welcome (width >= 51rem) {
		.welcome-first-visit {
			--welcome-cell-gap: 0.75rem;
			--welcome-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 0.84fr);
		}
		.welcome-features {
			grid-template-columns: var(--welcome-columns);
		}
		.welcome-features article:last-child {
			padding-right: 0;
		}
		.welcome-hero {
			grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
			grid-template-areas:
				'intro visual'
				'actions actions';
			row-gap: 2rem;
			align-items: center;
		}
		.welcome-first-visit .welcome-actions {
			display: grid;
			max-width: none;
			grid-template-columns: var(--welcome-columns);
			gap: var(--welcome-cell-gap);
		}
		.welcome-action-grid {
			grid-column: span 2;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.welcome-links {
			flex-direction: column;
			flex-wrap: nowrap;
			gap: var(--welcome-cell-gap);
		}
		.welcome-link {
			flex: 1 1 0;
		}
		.welcome-first-visit .welcome-title-text {
			font-size: clamp(2rem, 0.2rem + 3.6cqi, 3rem);
		}
		.welcome-visual {
			justify-self: end;
		}
	}
	/* A desktop window. The figure takes its own column next to the copy and
	   the actions. The first two points start at the two columns of actions,
	   and the third point starts at the figure. */
	@container welcome (width >= 68.5rem) {
		.welcome-first-visit {
			--welcome-cell-gap: 0.5rem;
			--welcome-figure-col: clamp(28.5rem, 41%, 30rem);
		}
		.welcome-hero {
			grid-template-columns: minmax(0, 1fr) minmax(0, var(--welcome-figure-col));
			grid-template-areas:
				'intro visual'
				'actions visual';
			row-gap: 1.75rem;
			align-items: start;
		}
		.welcome-visual {
			align-self: center;
		}
		.welcome-first-visit .welcome-actions {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
		}
		.welcome-action-grid {
			grid-column: auto;
		}
		.welcome-links {
			flex-direction: row;
			flex-wrap: wrap;
			gap: 0 1.5rem;
		}
		.welcome-link {
			flex: none;
		}
		.welcome-features {
			grid-template-columns:
				repeat(2, minmax(0, 1fr))
				calc(var(--welcome-figure-col) + var(--welcome-gap) - var(--welcome-cell-gap));
		}
		.welcome-features article:last-child {
			padding-left: calc(var(--welcome-gap) - var(--welcome-cell-gap));
		}
	}
	/* A large desktop window. The type and the figure take one step up, so
	   the view fills the home area. */
	@container welcome (width >= 92rem) {
		.welcome-first-visit {
			--welcome-gap: 3.5rem;
			--welcome-figure-col: clamp(30rem, 41%, 35rem);
			max-width: 84rem;
		}
		.welcome-shell-first :global(.welcome-footer) {
			max-width: 84rem;
		}
		.welcome-hero {
			row-gap: 2.25rem;
		}
		.welcome-first-visit .welcome-intro {
			max-width: 44rem;
		}
		.welcome-first-visit .welcome-title-text {
			font-size: clamp(3rem, 3.33cqi, 3.5rem);
		}
		.welcome-lead {
			max-width: 38rem;
			font-size: 1.1875rem;
		}
		.welcome-facts li {
			font-size: 0.9375rem;
		}
		.welcome-first-visit .welcome-action {
			min-height: 52px;
			font-size: 1.0625rem;
		}
		.welcome-features h2 {
			font-size: 1.0625rem;
		}
		.welcome-features p {
			max-width: 24rem;
			font-size: 0.9375rem;
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
	}
</style>
