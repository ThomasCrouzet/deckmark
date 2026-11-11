<script lang="ts">
	import { tick, untrack } from 'svelte';
	import LoadError from './LoadError.svelte';
	import { reportPersistenceError } from '#lib/storage.js';
	import { browser } from '$app/env';
	import { t, i18n } from '#lib/i18n/index.js';
	import { interpolate, type Locale } from '#lib/i18n/locale.js';
	import { docsSiteEn, type DocsSiteMessageKey } from '#lib/i18n/messages/docs-site-en.js';
	import { docsSiteFr } from '#lib/i18n/messages/docs-site-fr.js';
	import { filesStore } from '#lib/files.svelte.js';
	import { workspaceStore } from '#lib/workspaces.svelte.js';
	import { templatesStore } from '#lib/templates.svelte.js';
	import { themeStore } from '#lib/ui/theme.svelte.js';
	import { promptStore } from '#lib/prompt.svelte.js';
	import { notify } from '#lib/notify.svelte.js';
	import { reportError } from '#lib/report.js';
	import { spinnerStore } from '#lib/spinner.svelte.js';
	import { copyMarkdown, copyRichHtml, isClipboardSupported } from '#lib/services/clipboard.js';
	import {
		runPaletteCopyActive,
		runPaletteDirectoryImport,
		runPaletteSaveTemplate,
		runPaletteSaveWorkspace
	} from '#lib/palette-ops.js';
	import { isDirectoryPickerSupported } from '#lib/fsa.js';
	import { isDesktop } from '#lib/desktop.js';
	import { isDiskLinkingAvailable } from '#lib/disk-linking.js';
	import type { EditMode } from '#lib/types.js';
	import { EDITOR } from '#lib/config.js';
	import type { EditorWidth } from '#lib/ui/editor-width.svelte.js';
	import { PRINT_PAGE, PRINT_TEXT_WIDTH_MM } from '#lib/render/print-geometry.js';
	import { coreCommands } from '#lib/ui/commands.js';
	import { filterCommands } from '#lib/palette-rank.js';
	import { keyboardStore } from '#lib/ui/keyboard.svelte.js';
	import { aiStore } from '#lib/ai/store.svelte.js';
	import { focusTrap, visualViewportPanel } from '#lib/a11y/focusTrap.js';
	import { formatKbd } from '#lib/platform.js';
	import {
		FilePlus,
		Upload,
		Download,
		Eye,
		Pencil,
		Code2,
		FileOutput,
		Files,
		PanelLeft,
		Printer,
		X,
		Search,
		MoveHorizontal,
		RotateCcw,
		Focus,
		List,
		Link2,
		Layers,
		Play,
		Presentation,
		AlignVerticalJustifyCenter,
		Settings,
		Bug,
		SunMoon,
		Sparkles,
		MessageSquare,
		Table,
		FileText,
		Image as ImageIcon,
		Clipboard,
		ClipboardCopy,
		FolderOpen,
		History,
		Workflow,
		Copy
	} from '@lucide/svelte';

	interface Command {
		id: string;
		label: string;
		hint?: string;
		kbd?: string;
		keywords?: string;
		enabled?: () => boolean;
		icon: typeof FilePlus;
		run: () => void;
	}

	import {
		documentKindForFile,
		documentKindLabelKey,
		type DocumentKind
	} from '#lib/document-kind.js';
	interface Props {
		kind: DocumentKind;
		mode: EditMode;
		onCreate: (kind: DocumentKind) => Promise<void>;
		onOpenOutline?: () => void;
		initialView?: 'commands' | 'actions';
		onOpenLibrary?: () => void;
		open: boolean;
		onClose: () => void;
		onNew: () => void;
		onImport: () => void;
		onExportMd: () => void;
		onExportHtml: () => void;
		onExportPdf: () => void;
		onExportAll: () => void;
		onSave: () => void;
		onSaveAs: () => void;
		onEditCopy: () => void;
		onEditOriginal: () => void;
		onSaveToDisk: () => void;
		onToggleSidebar: () => void;
		onSetMode: (m: EditMode) => void;
		onOpenSearch: () => void;
		onOpenInFileSearch: () => void;
		onSetEditorWidth: (width: EditorWidth) => void;
		onResetEditorWidth: () => void;
		focusMode: boolean;
		onToggleFocus: () => void;
		typewriterMode: boolean;
		onToggleTypewriter: () => void;
		tocVisible: boolean;
		onToggleToc: () => void;
		onOpenDiskLinks: () => void;
		onOpenWorkspaces: () => void;
		onOpenSettings: () => void;
		onOpenHistory: () => void;
		onOpenGraph: () => void;
		onOpenAi: () => void;
		onOpenProperties: () => void;
		onOpenComments: () => void;
		onOpenExportProfiles: () => void;
		onOpenLinkedBlocks: () => void;
		onOpenSemantic: () => void;
		onOpenCollection: () => void;
		onOpenDocsCheck: () => void;
		onOpenSnippets: () => void;
		onSaveSnippetSelection: () => void;
		onSaveSnippetFile: () => void;
		onOpenDocsSite: () => void;
		onPresent: () => void;
		onAdvancedSource: () => void;
	}

	let {
		kind,
		mode,
		onCreate,
		onOpenOutline,
		initialView = 'commands',
		onOpenLibrary,
		open,
		onClose,
		onNew,
		onImport,
		onExportMd,
		onExportHtml,
		onExportPdf,
		onExportAll,
		onSave,
		onSaveAs,
		onEditCopy,
		onEditOriginal,
		onSaveToDisk,
		onToggleSidebar,
		onSetMode,
		onOpenSearch,
		onOpenInFileSearch,
		onSetEditorWidth,
		onResetEditorWidth,
		focusMode,
		onToggleFocus,
		typewriterMode,
		onToggleTypewriter,
		tocVisible,
		onToggleToc,
		onOpenDiskLinks,
		onOpenWorkspaces,
		onOpenSettings,
		onOpenHistory,
		onOpenGraph,
		onOpenAi,
		onOpenProperties,
		onOpenComments,
		onOpenExportProfiles,
		onOpenLinkedBlocks,
		onOpenSemantic,
		onOpenCollection,
		onOpenDocsCheck,
		onOpenSnippets,
		onSaveSnippetSelection,
		onSaveSnippetFile,
		onOpenDocsSite,
		onPresent,
		onAdvancedSource
	}: Props = $props();

	let query = $state('');
	let view = $derived(initialView);
	let closeButton: HTMLButtonElement | null = $state(null);
	let selected = $state(0);
	let inputEl: HTMLInputElement | null = $state(null);

	const DOCS_SITE_MESSAGES: Record<Locale, Record<DocsSiteMessageKey, string>> = {
		en: docsSiteEn,
		fr: docsSiteFr
	};
	function td(key: DocsSiteMessageKey, params?: Record<string, string | number>): string {
		const dictionary = DOCS_SITE_MESSAGES[i18n.locale] ?? docsSiteEn;
		return interpolate(dictionary[key] ?? docsSiteEn[key] ?? key, params);
	}

	function stripExt(name: string) {
		return name.replace(/\.[a-z0-9]{1,10}$/i, '');
	}

	function runCommand(command: Command | undefined): void {
		if (!command || !isAvailable(command)) return;
		onClose();
		command.run();
	}

	function isAvailable(command: Command): boolean {
		const needsDocument = [
			'export-md',
			'export-pdf',
			'export-html',
			'copy-md',
			'copy-html',
			'mode-wysiwyg',
			'mode-source',
			'mode-read',
			'search-in-file',
			'history',
			'presentation',
			'template-save',
			'rename-file',
			'close-file',
			'delete-file',
			'save',
			'save-as',
			'edit-copy',
			'edit-original'
		].includes(command.id);
		if (command.id === 'export-all' && filesStore.library.length === 0) return false;
		if (command.id.startsWith('export-') && spinnerStore.visible) return false;
		if (command.id.startsWith('copy-') && !isClipboardSupported()) return false;
		const core = coreCommands.find((entry) => entry.id === command.id);

		return (
			(!(needsDocument || core?.document) || filesStore.active !== null) &&
			command.enabled?.() !== false
		);
	}

	// §2.3 - "Vault" import: opens a directory and creates a tab per .md file.
	async function importDirectory(): Promise<void> {
		try {
			await runPaletteDirectoryImport({
				importDirectory: () => filesStore.importDirectory(),
				showSpinner: (label) => spinnerStore.show(label),
				notifySuccess: (message) => notify.success(message),
				reportError,
				t
			});
		} catch {
			// reportError already toasted; keep the command fire-and-forget.
		}
	}

	// §2.5 - Copies the active file (raw markdown or rich HTML) to the
	// clipboard, with user feedback via toasts.
	async function copyActive(format: 'md' | 'html'): Promise<void> {
		await runPaletteCopyActive(format, {
			getActive: () => filesStore.active,
			isClipboardSupported,
			copyMarkdown,
			copyRichHtml,
			notifySuccess: (message) => notify.success(message),
			notifyError: (message) => notify.error(message),
			reportError,
			t
		});
	}

	const baseCommands: Command[] = $derived([
		{
			id: 'outline',
			label: t('navigation.outline'),
			icon: List,
			enabled: () => filesStore.active !== null,
			run: () => onOpenOutline?.()
		},
		{ id: 'library', label: t('library.title'), icon: Files, run: () => onOpenLibrary?.() },
		{
			id: 'snippets',
			label: t('snippets.open'),
			hint: t('snippets.openHint'),
			keywords: t('snippets.search'),
			icon: Code2,
			run: onOpenSnippets
		},
		{
			id: 'snippet-save-selection',
			label: t('snippets.saveSelection'),
			hint: t('snippets.saveSelectionHint'),
			icon: Code2,
			enabled: () => filesStore.active !== null && (kind === 'note' || kind === 'code'),
			run: onSaveSnippetSelection
		},
		{
			id: 'snippet-save-file',
			label: t('snippets.saveFile'),
			hint: t('snippets.saveFileHint'),
			icon: Code2,
			enabled: () => filesStore.active !== null && (kind === 'note' || kind === 'code'),
			run: onSaveSnippetFile
		},
		{ id: 'backup', label: t('actions.backups'), icon: Download, run: onOpenSettings },
		{
			id: 'close-file',
			label: t('palette.closeFile'),
			icon: X,
			kbd: formatKbd('⌘W'),
			run: () => {
				if (filesStore.activeId) filesStore.close(filesStore.activeId);
			}
		},
		{
			id: 'delete-file',
			label: t('palette.deleteFile'),
			icon: X,
			run: () => {
				const id = filesStore.activeId;
				if (id)
					void promptStore
						.confirm({
							title: t('sidebar.deleteConfirm'),
							message: t('sidebar.deleteMessage'),
							danger: true
						})
						.then((yes) => {
							if (yes) filesStore.delete(id);
						});
			}
		},

		{
			id: 'new',
			label: t('documents.new'),
			kbd: formatKbd('⌘N'),
			icon: FilePlus,
			run: onNew
		},
		{
			id: 'new-note',
			label: t('documents.createNote'),
			icon: FileText,
			run: () => void onCreate('note')
		},
		{
			id: 'new-presentation',
			label: t('documents.createPresentation'),
			icon: Presentation,
			run: () => void onCreate('presentation')
		},

		{
			id: 'import',
			label: t('palette.importMd'),
			kbd: formatKbd('⌘O'),
			icon: Upload,
			run: onImport
		},
		{
			id: 'open-local',
			label: t('palette.openLocalFile'),
			keywords: t('palette.openLocalFileKeywords'),
			icon: FolderOpen,
			run: onImport
		},
		{
			id: 'edit-original',
			label: t('palette.editOriginal'),
			keywords: t('palette.editOriginalKeywords'),
			icon: Link2,
			enabled: () =>
				filesStore.active !== null &&
				(isDiskLinkingAvailable() || !!filesStore.active.sourceFileId),
			run: onEditOriginal
		},
		{
			id: 'edit-copy',
			label: t('palette.editCopy'),
			keywords: t('palette.editCopyKeywords'),
			icon: Copy,
			enabled: () => filesStore.active !== null,
			run: onEditCopy
		},
		...(isDesktop() || isDirectoryPickerSupported()
			? [
					{
						id: 'import-dir',
						label: t('palette.importDirectory'),
						hint: t('palette.importDirectoryHint'),
						icon: FolderOpen,
						run: () => void importDirectory()
					}
				]
			: []),
		{
			id: 'save',
			label: t('palette.save'),
			keywords: t('palette.saveKeywords'),
			kbd: formatKbd('⌘S'),
			icon: Download,
			enabled: () => filesStore.active !== null,
			run: onSave
		},
		{
			id: 'save-as',
			label: t('palette.saveAs'),
			keywords: t('palette.saveAsKeywords'),
			kbd: formatKbd('⌘⇧S'),
			icon: Download,
			enabled: () => filesStore.active !== null,
			run: onSaveAs
		},
		{
			id: 'export-md',
			label: t('palette.download'),
			keywords: t('palette.downloadKeywords'),
			kbd: formatKbd('⌘⇧E'),
			icon: Download,
			enabled: () => filesStore.active !== null,
			run: onExportMd
		},
		...(isDiskLinkingAvailable()
			? [
					{
						id: 'save-disk',
						label: t('palette.saveToDisk'),
						keywords: t('palette.saveToDiskKeywords'),
						kbd: keyboardStore.label('save-as') ?? formatKbd('⌘⇧S'),
						icon: Download,
						enabled: () => filesStore.active !== null,
						run: onSaveToDisk
					}
				]
			: []),
		{
			id: 'export-pdf',
			label: t('palette.exportPdf'),
			keywords: t('palette.exportPdfKeywords'),
			kbd: formatKbd('⌘P'),
			icon: Printer,
			enabled: () => filesStore.active !== null,
			run: onExportPdf
		},
		{
			id: 'rename-file',
			label: t('palette.renameFile'),
			keywords: t('palette.renameFileKeywords'),
			icon: Pencil,
			enabled: () => filesStore.active !== null,
			run: () => {
				const active = filesStore.active;
				if (!active) return;
				void promptStore
					.prompt({ title: t('palette.renameFilePrompt'), defaultValue: stripExt(active.name) })
					.then(async (name) => {
						if (name !== null) await filesStore.rename(active.id, name);
					});
			}
		},

		{
			id: 'export-html',
			label: t('palette.exportHtml'),
			icon: FileOutput,
			run: onExportHtml
		},

		{
			id: 'export-all',
			label: t('palette.exportAll'),
			icon: Files,
			run: onExportAll
		},

		{
			id: 'export-open',
			label: t('palette.exportOpen'),
			icon: Files,
			enabled: () => filesStore.files.length > 0,
			run: () => void filesStore.exportOpen()
		},
		{
			id: 'copy-md',
			label: t('palette.copyMarkdown'),
			hint: t('palette.copyMarkdownHint'),
			icon: Clipboard,
			run: () => void copyActive('md')
		},
		{
			id: 'copy-html',
			label: t('palette.copyRichHtml'),
			hint: t('palette.copyRichHtmlHint'),
			icon: ClipboardCopy,
			run: () => void copyActive('html')
		},
		{
			id: 'mode-wysiwyg',
			label: t('palette.modeWysiwyg'),
			kbd: formatKbd('⌘E'),
			icon: Pencil,
			run: () => onSetMode('wysiwyg')
		},
		{
			id: 'mode-source',
			label: t('palette.modeSource'),
			kbd: formatKbd('⌘/'),
			icon: Code2,
			run: () => onSetMode('source')
		},
		{
			id: 'mode-read',
			label: t('palette.modeRead'),
			kbd: formatKbd('⌘R'),
			icon: Eye,
			run: () => onSetMode('read')
		},
		{
			id: 'sidebar',
			label: t('palette.toggleSidebar'),
			kbd: formatKbd('⌘B'),
			icon: PanelLeft,
			run: onToggleSidebar
		},
		{
			id: 'search-in-file',
			label: t('palette.searchInFile'),
			hint: t('palette.searchInFileHint'),
			kbd: formatKbd('⌘F'),
			icon: Search,
			run: onOpenInFileSearch
		},
		{
			id: 'search',
			label: t('palette.searchCrossFiles'),
			kbd: formatKbd('⌘⇧F'),
			icon: Search,
			run: onOpenSearch
		},
		{
			id: 'focus',
			label: focusMode ? t('palette.disableFocusMode') : t('palette.enableFocusMode'),
			hint: t('palette.focusModeHint'),
			kbd: formatKbd('⌘⇧.'),
			icon: Focus,
			run: onToggleFocus
		},
		{
			id: 'typewriter',
			label: typewriterMode ? t('palette.disableTypewriter') : t('palette.enableTypewriter'),
			hint: t('palette.typewriterHint'),
			icon: AlignVerticalJustifyCenter,
			run: onToggleTypewriter
		},
		{
			id: 'toc',
			label: tocVisible ? t('palette.hideToc') : t('palette.showToc'),
			hint: t('palette.tocHint'),
			icon: List,
			run: onToggleToc
		},
		{
			id: 'disk-links',
			label: t('palette.manageDiskLinks'),
			hint: t('palette.manageDiskLinksHint'),
			icon: Link2,
			run: onOpenDiskLinks
		},
		{
			id: 'workspaces-save',
			label: t('palette.saveWorkspace'),
			hint: t('palette.saveWorkspaceHint'),
			icon: Layers,
			// §B1.3 - Custom modal (cf. PromptModal + promptStore). We close the
			// palette before the prompt to avoid a nested focus-trap.
			run: () => {
				if (!browser) return;
				void runPaletteSaveWorkspace({
					promptName: () =>
						promptStore.prompt({
							title: t('palette.workspaceNamePrompt'),
							placeholder: t('palette.workspaceNamePlaceholder')
						}),
					save: (name) => workspaceStore.save(name),
					notifySuccess: (message) => notify.success(message),
					t
				});
			}
		},
		{
			id: 'workspaces-open',
			label: t('palette.loadWorkspace'),
			hint: t('palette.loadWorkspaceHint'),
			icon: Layers,
			run: onOpenWorkspaces
		},
		{
			id: 'settings',
			label: t('palette.settings'),
			keywords: t('palette.settingsKeywords'),
			hint: t('palette.settingsHint'),
			icon: Settings,
			run: onOpenSettings
		},
		{
			id: 'report-problem',
			label: t('palette.reportProblem'),
			icon: Bug,
			run: () => {
				onOpenSettings();
				setTimeout(() => window.dispatchEvent(new CustomEvent('mdsh:report-problem')), 500);
			}
		},
		{
			id: 'history',
			label: t('palette.versionHistory'),
			hint: t('palette.versionHistoryHint'),
			icon: History,
			run: onOpenHistory
		},
		{
			id: 'graph',
			label: t('palette.linksGraph'),
			hint: t('palette.linksGraphHint'),
			icon: Workflow,
			run: onOpenGraph
		},
		{
			id: 'docs-check',
			label: t('docsCheck.command'),
			hint: t('docsCheck.commandHint'),
			icon: FileText,
			run: onOpenDocsCheck
		},
		{
			id: 'docs-site',
			label: td('docsSite.command'),
			hint: td('docsSite.commandHint'),
			icon: FileOutput,
			run: onOpenDocsSite
		},
		{
			id: 'presentation',
			label: t('slides.presentActive'),
			hint: kind === 'note' ? t('slides.presentationRequired') : t('documents.presentation'),
			enabled: () => kind === 'presentation',
			icon: Play,
			run: onPresent
		},
		{
			id: 'advanced-source',
			label: t('slides.source'),
			icon: Code2,
			run: onAdvancedSource
		},
		{
			id: 'semantic-search',
			label: t('palette.semantic'),
			hint: t('palette.semanticHint'),
			icon: Search,
			run: onOpenSemantic
		},
		{
			id: 'linked-blocks',
			label: t('blocks.command'),
			hint: t('blocks.commandHint'),
			icon: Link2,
			run: onOpenLinkedBlocks
		},
		{
			id: 'export-profiles',
			label: t('exportProfiles.command'),
			hint: t('exportProfiles.commandHint'),
			icon: Download,
			run: onOpenExportProfiles
		},
		{
			id: 'collection',
			label: t('palette.collection'),
			hint: t('palette.collectionHint'),
			icon: Table,
			run: onOpenCollection
		},
		{
			id: 'comments',
			label: t('palette.comments'),
			hint: t('palette.commentsHint'),
			icon: MessageSquare,
			enabled: () => kind === 'note' && filesStore.active !== null,
			run: onOpenComments
		},
		{
			id: 'properties',
			label: t('palette.editProperties'),
			hint: t('palette.editPropertiesHint'),
			icon: Settings,
			enabled: () => kind === 'note' && filesStore.active !== null,
			run: onOpenProperties
		},
		{
			id: 'ai',
			label: t('palette.aiAssistant'),
			hint: t('palette.aiAssistantHint'),
			icon: Sparkles,
			enabled: () => aiStore.settings.enabled,
			run: onOpenAi
		},
		{
			id: 'template-save',
			label: t('palette.saveAsTemplate'),
			hint: t('palette.saveAsTemplateHint'),
			icon: FileText,
			run: () => {
				if (!browser) return;
				void runPaletteSaveTemplate({
					getActive: () => filesStore.active,
					promptName: (defaultValue) =>
						promptStore.prompt({
							title: t('palette.templateNamePrompt'),
							confirmLabel: t('templates.save'),
							defaultValue,
							placeholder: t('palette.templateNamePlaceholder')
						}),
					save: (name, content) => templatesStore.save(name, content, kind),
					notifySuccess: (message) => notify.success(message),
					stripExt,
					t
				});
			}
		},
		{
			id: 'theme',
			label: t('palette.theme', {
				theme: t(
					themeStore.pref === 'system'
						? 'settings.themeSystem'
						: themeStore.pref === 'light'
							? 'settings.themeLight'
							: 'settings.themeDark'
				)
			}),
			hint: t('palette.themeHint'),
			icon: SunMoon,
			run: () => themeStore.cycle()
		},
		{
			id: 'width-prose',
			// 65ch at 17 px ≈ 720 px: prose sweet spot (Baymard, Nanavati 2005,
			// Ruder 1967, WCAG 1.4.8 AAA ≤ 80 cpl).
			label: t('palette.widthProse'),
			hint: t('palette.widthProseHint'),
			icon: MoveHorizontal,
			run: () => onSetEditorWidth(EDITOR.widthPresets.prose)
		},
		{
			id: 'width-narrow',
			label: t('palette.widthNarrow', { px: EDITOR.widthPresets.narrow }),
			icon: MoveHorizontal,
			run: () => onSetEditorWidth(EDITOR.widthPresets.narrow)
		},
		{
			id: 'width-pdf',
			label: t('palette.widthPdf'),
			hint: t('settings.widthPdfHelp', {
				width: PRINT_TEXT_WIDTH_MM,
				margin: PRINT_PAGE.marginInlineMm
			}),
			icon: MoveHorizontal,
			run: () => onSetEditorWidth(EDITOR.widthPresets.pdf)
		},
		{
			id: 'width-medium',
			label: t('palette.widthMedium', { px: EDITOR.widthPresets.medium }),
			icon: MoveHorizontal,
			run: () => onSetEditorWidth(EDITOR.widthPresets.medium)
		},
		{
			id: 'width-wide',
			label: t('palette.widthWide', { px: EDITOR.widthPresets.wide }),
			icon: MoveHorizontal,
			run: () => onSetEditorWidth(EDITOR.widthPresets.wide)
		},
		{
			id: 'width-full',
			label: t('palette.widthFull'),
			icon: MoveHorizontal,
			run: () => onSetEditorWidth(EDITOR.widthPresets.full)
		},
		{
			id: 'width-reset',
			label: t('palette.widthReset'),
			icon: RotateCcw,
			run: onResetEditorWidth
		}
	]);

	const reopenCommands: Command[] = $derived(
		filesStore.closedFiles.map((file) => ({
			id: `reopen-${file.id}`,
			label: t('palette.reopenFile', { name: file.name }),
			keywords: filesStore.documentTitle(file.id),
			hint: t(documentKindLabelKey(documentKindForFile(file))),
			icon:
				documentKindForFile(file) === 'note'
					? FileText
					: documentKindForFile(file) === 'presentation'
						? Presentation
						: documentKindForFile(file) === 'code'
							? Code2
							: documentKindForFile(file) === 'image'
								? ImageIcon
								: FileText,
			run: () => {
				filesStore.openDocument(file.id);
			}
		}))
	);

	const fileCommands: Command[] = $derived(
		filesStore.files.map((f) => ({
			id: `file-${f.id}`,
			label: stripExt(f.name),
			keywords: filesStore.documentTitle(f.id),
			hint: t(documentKindLabelKey(documentKindForFile(f))),
			icon:
				documentKindForFile(f) === 'note'
					? FileText
					: documentKindForFile(f) === 'presentation'
						? Presentation
						: documentKindForFile(f) === 'code'
							? Code2
							: ImageIcon,
			run: () => filesStore.setActive(f.id)
		}))
	);

	// §6.8 - Direct "Load workspace «X»" commands: allow
	// restoring a workspace with a single search in the palette, without
	// going through the sub-modal. List populated on open (cf. $effect).
	const workspaceCommands: Command[] = $derived(
		workspaceStore.workspaces.map((ws) => ({
			id: `workspace-${ws.id}`,
			label: t('palette.loadWorkspaceNamed', { name: ws.name }),
			hint: t('palette.workspaceFileCount', { n: ws.fileIds.length }),
			icon: Play,
			run: () => void workspaceStore.restore(ws.id)
		}))
	);

	// §2.7 - "New from template" commands: create a pre-filled file
	// (dated builtin or user template) in one search. Variables substituted
	// at creation time (cf. templatesStore.resolve).
	const templateCommands: Command[] = $derived(
		templatesStore.choices.map((tpl) => ({
			id: `template-${tpl.id}`,
			label: t('palette.newFromTemplate', { name: tpl.name }),
			hint: tpl.description,
			icon: FileText,
			run: async () => {
				const doc = await templatesStore.resolve(tpl.id);
				if (doc)
					filesStore.createNew(doc.name, doc.content, {
						focusEditor: doc.kind === 'note',
						origin: 'template'
					});
			}
		}))
	);

	const PAGE_COMMANDS = 100;
	let visibleLimit = $state(PAGE_COMMANDS);
	$effect(() => {
		void query;
		visibleLimit = PAGE_COMMANDS;
	});
	const matches: Command[] = $derived.by(() => {
		const all = [
			...baseCommands,
			...templateCommands,
			...workspaceCommands,
			...fileCommands,
			...reopenCommands
		]
			.filter((command) => {
				if (command.id === 'advanced-source') return kind === 'presentation';
				if (command.id === 'focus') return kind === 'note' && mode === 'read';
				if (kind === 'note') return true;
				return (
					![
						'outline',
						'search-in-file',
						'graph',
						'typewriter',
						'toc',
						'focus',
						'copy-html'
					].includes(command.id) &&
					!command.id.startsWith('mode-') &&
					!command.id.startsWith('width-')
				);
			})
			.map((command) => {
				const core = coreCommands.find((entry) => entry.id === command.id);
				if (!core) return command;
				const { kbd: _defaultKbd, ...rest } = command;
				void _defaultKbd;
				const kbd = keyboardStore.label(command.id);
				return kbd ? { ...rest, kbd } : rest;
			});
		return [...filterCommands(all, query)];
	});
	const filtered: Command[] = $derived(matches.slice(0, visibleLimit));
	const actionGroups = $derived(
		[
			{
				label: t('actions.documents'),
				ids: [
					'new',
					'import',
					'open-local',
					'edit-original',
					'edit-copy',
					'library',
					'snippets',
					'snippet-save-selection',
					'snippet-save-file',
					'search',
					'search-in-file',
					'outline',
					'history'
				]
			},
			{
				label: t('actions.export'),
				ids: [
					'save',
					'save-as',
					'save-disk',
					'export-md',
					'export-pdf',
					'export-html',
					'export-all',
					'backup'
				]
			},
			{
				label: t('actions.workspace'),
				ids: ['workspaces-open', 'graph', 'focus', 'toc', 'settings']
			}
		].map((group) => ({
			...group,
			commands: group.ids.flatMap((id) => {
				const command = filtered.find((entry) => entry.id === id);
				return command ? [command] : [];
			})
		}))
	);

	let loadError = $state(false);
	let loading = $state(false);
	async function loadSavedCommands() {
		loading = true;
		loadError = false;
		const results = await Promise.allSettled([workspaceStore.load(), templatesStore.load()]);
		for (const result of results) {
			if (result.status === 'rejected') {
				loadError = true;
				reportPersistenceError(result.reason, 'load');
			}
		}
		loading = false;
	}

	$effect(() => {
		if (open) {
			query = '';
			selected = 0;
			// Load workspaces + templates on first open so that
			// the direct commands appear in the list.
			void untrack(loadSavedCommands);
			tick().then(() => (view === 'actions' ? closeButton?.focus() : inputEl?.focus()));
		}
	});

	$effect(() => {
		const _ = query;
		void _;
		selected = 0;
	});

	$effect(() => {
		const option = filtered[selected];
		if (!option) return;
		tick().then(() => {
			document.getElementById(`cmd-palette-opt-${option.id}`)?.scrollIntoView({ block: 'nearest' });
		});
	});

	function handleKey(e: KeyboardEvent) {
		if (e.isComposing || e.defaultPrevented) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			selected = Math.min(selected + 1, filtered.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selected = Math.max(selected - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const cmd = filtered[selected];
			runCommand(cmd);
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pb-4 backdrop-blur-sm
		       pt-[max(env(safe-area-inset-top),12vh)]"
		style:padding-left="max(env(safe-area-inset-left), 1rem)"
		style:padding-right="max(env(safe-area-inset-right), 1rem)"
		onclick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') onClose();
		}}
		role="dialog"
		aria-modal="true"
		aria-label={t(view === 'actions' ? 'actions.title' : 'palette.dialogLabel')}
		tabindex="-1"
		use:focusTrap
		use:visualViewportPanel
	>
		<div
			class="mdsh-dialog-panel flex max-h-[80dvh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border
			       bg-bg-1 shadow-2xl animate-fade-in"
		>
			{#if loadError}
				<LoadError onRetry={() => void loadSavedCommands()} busy={loading} />
			{/if}
			{#if view === 'actions'}
				<header class="flex items-center justify-between border-b border-border px-4 py-2">
					<h2 class="text-sm font-medium">{t('actions.title')}</h2>
					<button
						bind:this={closeButton}
						class="p-2"
						onclick={onClose}
						aria-label={t('palette.close')}><X size={16} /></button
					>
				</header>
				<div class="min-h-0 overflow-y-auto p-3">
					{#each actionGroups as group (group.label)}
						<h3 class="mb-2 mt-2 text-xs font-medium text-fg-muted">{group.label}</h3>
						<div class="mb-4 grid grid-cols-2 gap-2">
							{#each group.commands as command (command.id)}
								<button
									class="flex min-h-11 items-center gap-2 rounded border border-border px-3 py-2 text-left text-sm hover:bg-bg-2"
									disabled={!isAvailable(command)}
									onclick={() => runCommand(command)}
								>
									<command.icon size={16} class="shrink-0" />
									<span>{command.label}</span>
								</button>
							{/each}
						</div>
					{/each}
					<button
						class="w-full rounded border border-border p-3 text-sm text-accent"
						onclick={() => {
							view = 'commands';
							void tick().then(() => inputEl?.focus());
						}}>{t('actions.allCommands')}</button
					>
				</div>
			{:else}
				<!-- §B1.5 - ARIA combobox + listbox pattern: the input drives the listbox
			     via aria-activedescendant. Before: no role nor announcement of
			     the highlighted item, the SR saw just a text field without context. -->

				<div class="palette-input-row flex items-center gap-2 border-b border-border px-3 py-3">
					<span class="font-mono text-xs text-accent" aria-hidden="true">>_</span>

					<Search size={15} class="text-fg-dim" />
					<input
						bind:this={inputEl}
						bind:value={query}
						onkeydown={handleKey}
						type="text"
						placeholder={t('palette.inputPlaceholder')}
						class="min-w-0 flex-1 bg-transparent font-mono text-sm text-fg outline-none placeholder:text-fg-dim"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						role="combobox"
						aria-controls="cmd-palette-listbox"
						aria-expanded={filtered.length > 0}
						aria-autocomplete="list"
						aria-activedescendant={filtered[selected]?.id != null
							? `cmd-palette-opt-${filtered[selected]!.id}`
							: undefined}
						aria-label={t('palette.inputLabel')}
					/>
					<button
						class="rounded p-1 text-fg-dim transition hover:bg-bg-2 hover:text-fg"
						onclick={onClose}
						aria-label={t('palette.close')}
					>
						<X size={14} />
					</button>
				</div>
				<div
					class="palette-meta flex items-center justify-between border-b border-border px-3 py-1.5"
				>
					<span>{t('palette.commandIndex')}</span>
					<span>{t('palette.availableCount', { n: filtered.filter(isAvailable).length })}</span>
				</div>

				<ul
					id="cmd-palette-listbox"
					role="listbox"
					aria-label={t('palette.listboxLabel')}
					class="max-h-80 overflow-y-auto py-1.5"
				>
					{#if filtered.length === 0}
						<li
							class="px-4 py-6 text-center text-xs text-fg-dim"
							role="option"
							aria-disabled="true"
							aria-selected="false"
						>
							{t('palette.noCommand')}
						</li>
					{:else}
						{#each filtered as cmd, i (cmd.id)}
							<li
								role="option"
								id={`cmd-palette-opt-${cmd.id}`}
								aria-selected={i === selected}
								aria-disabled={!isAvailable(cmd) ? 'true' : undefined}
								title={!isAvailable(cmd)
									? filesStore.active
										? t('palette.unavailable')
										: t('palette.requiresDocument')
									: cmd.hint}
								aria-label={cmd.kbd
									? t('palette.commandWithShortcut', { label: cmd.label, kbd: cmd.kbd })
									: cmd.label}
								class="palette-command flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left text-sm transition"
								class:bg-bg-2={i === selected}
								class:text-fg={i === selected}
								class:text-fg-muted={i !== selected}
								class:opacity-50={!isAvailable(cmd)}
								onclick={() => {
									runCommand(cmd);
								}}
								onkeydown={(event) => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										runCommand(cmd);
									}
								}}
								onmousedown={(event) => event.preventDefault()}
								onmouseenter={() => (selected = i)}
							>
								<span class="palette-command-index" aria-hidden="true"
									>{(i + 1).toString().padStart(2, '0')}</span
								>
								<cmd.icon size={14} class="flex-shrink-0 text-fg-dim" aria-hidden="true" />
								<span class="flex-1 truncate">{cmd.label}</span>
								{#if cmd.kbd}
									<kbd class="flex-shrink-0 text-xs text-fg-dim" aria-hidden="true">{cmd.kbd}</kbd>
								{/if}
							</li>
						{/each}
						{#if filtered.length < matches.length}
							<li class="px-4 py-2 text-center text-xs">
								<button
									type="button"
									class="text-fg-muted underline"
									onclick={() => (visibleLimit += PAGE_COMMANDS)}
								>
									{t('palette.showMore', { n: matches.length - filtered.length })}
								</button>
							</li>
						{/if}
					{/if}
				</ul>
			{/if}
		</div>
	</div>
{/if}

<style>
	.palette-input-row {
		background: color-mix(in oklab, var(--color-bg-2) 58%, transparent);
	}
	.palette-meta {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.14em;
		color: var(--color-fg-dim);
	}
	.palette-command {
		position: relative;
		border-block: 1px solid transparent;
	}
	.palette-command:hover,
	.palette-command[aria-selected='true'] {
		border-block-color: var(--color-border);
		background: linear-gradient(
			90deg,
			color-mix(in oklab, var(--color-accent) 13%, var(--color-bg-2)),
			var(--color-bg-2) 62%
		);
	}
	.palette-command[aria-selected='true']::before {
		content: '';
		position: absolute;
		inset-block: -1px;
		left: 0;
		width: 2px;
		background: var(--color-accent);
	}
	.palette-command-index {
		width: 1.6rem;
		flex: none;
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.08em;
		color: var(--color-fg-dim);
	}
	.palette-command[aria-selected='true'] .palette-command-index {
		color: var(--color-accent);
	}
</style>
