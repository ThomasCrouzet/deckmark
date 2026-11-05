import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	isDesktop: vi.fn(),
	reportError: vi.fn(),
	reportWarning: vi.fn(),
	invoke: vi.fn(),
	listen: vi.fn(),
	unlisten: vi.fn(),
	menuItemNew: vi.fn(),
	predefinedMenuItemNew: vi.fn(),
	submenuNew: vi.fn(),
	menuNew: vi.fn(),
	setAsAppMenu: vi.fn()
}));

vi.mock('./desktop', () => ({
	isDesktop: mocks.isDesktop
}));

vi.mock('./report', () => ({
	reportError: mocks.reportError,
	reportWarning: mocks.reportWarning
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

vi.mock('@tauri-apps/api/event', () => ({
	listen: mocks.listen
}));

vi.mock('@tauri-apps/api/menu', () => ({
	Menu: { new: mocks.menuNew },
	MenuItem: { new: mocks.menuItemNew },
	PredefinedMenuItem: { new: mocks.predefinedMenuItemNew },
	Submenu: { new: mocks.submenuNew }
}));

import {
	initDesktopShell as initializeDesktopShell,
	type DesktopMenuAction,
	type DesktopMenuLabels
} from './desktop-shell';
import type { NativeDiskGrant } from './disk-tauri';

const disposers: Array<() => void> = [];

async function initDesktopShell(...args: Parameters<typeof initializeDesktopShell>) {
	const dispose = await initializeDesktopShell(...args);
	disposers.push(dispose);
	return dispose;
}

const labels: DesktopMenuLabels = {
	file: 'File',
	edit: 'Edit',
	newFile: 'New',
	open: 'Open',
	save: 'Save',
	saveAs: 'Save As',
	saveToDisk: 'Save to disk',
	exportMarkdown: 'Export Markdown',
	exportPdf: 'Export PDF',
	exportHtml: 'Export HTML',
	exportZip: 'Export ZIP',
	pastePlain: 'Paste as plain text',
	settings: 'Settings'
};

interface MenuItemOptions {
	id?: DesktopMenuAction;
	action?: () => void;
}

interface OpenEvent {
	payload: Array<{
		token: string;
		path: string;
		stat: { lastModified: number; size: number; revision: string } | null;
	}>;
}

const nativeGrant = (path: string) => ({
	token: `token:${path}`,
	path,
	queuedPath: path,
	stat: { lastModified: 1, size: 1, revision: 'sha256:test' }
});
const pendingDelivery = (
	grants: ReturnType<typeof nativeGrant>[] = [],
	rejected: Array<{ path: string; reason: string }> = [],
	remaining = 0
) => ({ grants, rejected, remaining });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isDesktop.mockReturnValue(false);
	mocks.invoke.mockResolvedValue(pendingDelivery());
	mocks.listen.mockResolvedValue(mocks.unlisten);
	mocks.menuItemNew.mockImplementation(async (options: unknown) => options);
	mocks.predefinedMenuItemNew.mockImplementation(async (options: unknown) => options);
	mocks.submenuNew.mockImplementation(async (options: unknown) => options);
	mocks.menuNew.mockResolvedValue({ setAsAppMenu: mocks.setAsAppMenu });
	mocks.setAsAppMenu.mockResolvedValue(undefined);
});

afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.restoreAllMocks();
});

describe('initDesktopShell', () => {
	it('reports asynchronous handler failures', async () => {
		mocks.isDesktop.mockReturnValue(true);
		const onMenuAction = vi.fn(async () => {
			throw new Error('menu failed');
		});
		const onOpenPaths = vi.fn(async () => {
			throw new Error('open failed');
		});

		await initDesktopShell({ onMenuAction, onOpenPaths, labels });

		const menuCalls = mocks.menuItemNew.mock.calls as unknown as Array<[MenuItemOptions]>;
		menuCalls
			.map(([options]) => options)
			.find((options) => options.id === 'open')
			?.action?.();
		await vi.waitFor(() =>
			expect(mocks.reportError).toHaveBeenCalledWith(
				'desktop menu action "open"',
				expect.any(Error)
			)
		);

		const listenCalls = mocks.listen.mock.calls as unknown as Array<
			[string, (event: OpenEvent) => void]
		>;
		mocks.invoke.mockResolvedValue(pendingDelivery([nativeGrant('/tmp/failing.md')]));
		listenCalls[0]![1]({ payload: [] });
		await vi.waitFor(() =>
			expect(mocks.reportError).toHaveBeenCalledWith('open from desktop event', expect.any(Error))
		);
	});

	it('reports initialization failures without aborting startup', async () => {
		mocks.isDesktop.mockReturnValue(true);
		mocks.menuItemNew.mockRejectedValueOnce(new Error('menu unavailable'));
		mocks.listen.mockRejectedValueOnce(new Error('events unavailable'));
		mocks.invoke.mockRejectedValueOnce(new Error('command unavailable'));

		await expect(
			initDesktopShell({
				onMenuAction: vi.fn(),
				onOpenPaths: vi.fn(),
				labels
			})
		).resolves.toEqual(expect.any(Function));

		expect(mocks.reportWarning).toHaveBeenCalledTimes(3);
	});

	it('waits for durable changes before acknowledging a native close', async () => {
		mocks.isDesktop.mockReturnValue(true);
		let finishSave: () => void = () => {};
		const onBeforeClose = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishSave = resolve;
				})
		);
		await initDesktopShell({ onMenuAction: vi.fn(), onOpenPaths: vi.fn(), onBeforeClose, labels });
		const closeListener = mocks.listen.mock.calls.find(
			([name]) => name === 'mdsh://close-request'
		)?.[1] as (event: { payload: number }) => void;
		closeListener({ payload: 1 });
		await vi.waitFor(() => expect(onBeforeClose).toHaveBeenCalledOnce());
		expect(mocks.invoke).toHaveBeenCalledWith('desktop_ack_close_request', { requestId: 1 });
		expect(mocks.invoke).not.toHaveBeenCalledWith('desktop_complete_close');
		finishSave();
		await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('desktop_complete_close'));
	});

	it('keeps the native window open after a persistence failure', async () => {
		mocks.isDesktop.mockReturnValue(true);
		const onBeforeClose = vi.fn(async () => {
			throw new Error('quota');
		});
		await initDesktopShell({ onMenuAction: vi.fn(), onOpenPaths: vi.fn(), onBeforeClose, labels });
		const closeListener = mocks.listen.mock.calls.find(
			([name]) => name === 'mdsh://close-request'
		)?.[1] as (event: { payload: number }) => void;
		closeListener({ payload: 1 });
		await vi.waitFor(() =>
			expect(mocks.reportError).toHaveBeenCalledWith(
				'desktop close',
				expect.any(Error),
				expect.objectContaining({ notifyUser: expect.any(String) })
			)
		);
		expect(mocks.invoke).not.toHaveBeenCalledWith('desktop_complete_close');
	});

	it('replays a close request lost during reload after listener setup', async () => {
		mocks.isDesktop.mockReturnValue(true);
		let listener: ((event: { payload: number }) => void) | undefined;
		let pending: number | undefined;
		mocks.listen.mockImplementation(async (name: string, callback: typeof listener) => {
			if (name !== 'mdsh://close-request') return () => {};
			listener = callback;
			return () => {
				listener = undefined;
			};
		});
		mocks.invoke.mockImplementation(async (name: string, args?: { requestId: number }) => {
			if (name === 'desktop_arm_close_guard' && pending !== undefined)
				listener?.({ payload: pending });
			if (name === 'desktop_ack_close_request' && args?.requestId === pending) pending = undefined;
			return pendingDelivery();
		});
		const onBeforeClose = vi.fn(async () => {});
		const handlers = { onMenuAction: vi.fn(), onOpenPaths: vi.fn(), onBeforeClose, labels };
		const dispose = await initDesktopShell(handlers);
		dispose();
		let finishMenu: () => void = () => {};
		let menuStarted = false;
		mocks.menuItemNew.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					menuStarted = true;
					finishMenu = resolve;
				})
		);
		const reloading = initDesktopShell(handlers);
		await vi.waitFor(() => expect(menuStarted).toBe(true));
		expect(listener).toBeUndefined();
		pending = 41;
		expect(onBeforeClose).not.toHaveBeenCalled();
		finishMenu();
		await reloading;
		await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('desktop_complete_close'));
		expect(onBeforeClose).toHaveBeenCalledOnce();
		expect(pending).toBeUndefined();
		await mocks.invoke('desktop_arm_close_guard');
		expect(onBeforeClose).toHaveBeenCalledOnce();
	});

	it('acknowledges duplicate requests but starts one save', async () => {
		mocks.isDesktop.mockReturnValue(true);
		let finishSave: () => void = () => {};
		const onBeforeClose = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishSave = resolve;
				})
		);
		await initDesktopShell({ onMenuAction: vi.fn(), onOpenPaths: vi.fn(), onBeforeClose, labels });
		const listener = mocks.listen.mock.calls.find(
			([name]) => name === 'mdsh://close-request'
		)?.[1] as (event: { payload: number }) => void;
		listener({ payload: 1 });
		listener({ payload: 2 });
		await vi.waitFor(() => expect(onBeforeClose).toHaveBeenCalledOnce());
		expect(mocks.invoke).toHaveBeenCalledWith('desktop_ack_close_request', { requestId: 1 });
		expect(mocks.invoke).toHaveBeenCalledWith('desktop_ack_close_request', { requestId: 2 });
		expect(mocks.invoke).not.toHaveBeenCalledWith('desktop_complete_close');
		finishSave();
		await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('desktop_complete_close'));
		expect(
			mocks.invoke.mock.calls.filter(([name]) => name === 'desktop_complete_close')
		).toHaveLength(1);
	});

	it('does not replay a close request after its save fails during reload', async () => {
		mocks.isDesktop.mockReturnValue(true);
		let pending: number | undefined = 9;
		let listener: ((event: { payload: number }) => void) | undefined;
		mocks.listen.mockImplementation(async (name: string, callback: typeof listener) => {
			if (name === 'mdsh://close-request') listener = callback;
			return () => {};
		});
		mocks.invoke.mockImplementation(async (name: string, args?: { requestId: number }) => {
			if (name === 'desktop_arm_close_guard' && pending !== undefined)
				listener?.({ payload: pending });
			if (name === 'desktop_ack_close_request' && args?.requestId === pending) pending = undefined;
			return pendingDelivery();
		});
		const onBeforeClose = vi.fn(async () => {
			throw new Error('quota');
		});
		const handlers = { onMenuAction: vi.fn(), onOpenPaths: vi.fn(), onBeforeClose, labels };
		const dispose = await initDesktopShell(handlers);
		await vi.waitFor(() => expect(mocks.reportError).toHaveBeenCalled());
		expect(onBeforeClose).toHaveBeenCalledOnce();
		expect(pending).toBeUndefined();
		expect(mocks.invoke).not.toHaveBeenCalledWith('desktop_complete_close');
		dispose();
		await initDesktopShell(handlers);
		expect(onBeforeClose).toHaveBeenCalledOnce();
		expect(mocks.invoke).not.toHaveBeenCalledWith('desktop_complete_close');
	});

	it('opens external links through the restricted native command', async () => {
		mocks.isDesktop.mockReturnValue(true);
		await initDesktopShell({ onMenuAction: vi.fn(), onOpenPaths: vi.fn(), labels });
		const link = document.createElement('a');
		link.href = 'https://example.com/article';
		document.body.append(link);
		link.click();
		await vi.waitFor(() =>
			expect(mocks.invoke).toHaveBeenCalledWith('desktop_open_external', {
				url: 'https://example.com/article'
			})
		);
		link.remove();
	});
	it('acknowledges a delivery only after durable ingestion and retains a failed delivery', async () => {
		mocks.isDesktop.mockReturnValue(true);
		const grant = nativeGrant('/tmp/waiting.md');
		mocks.invoke.mockResolvedValue(pendingDelivery([grant]));
		let resolve: () => void = () => {};
		const onOpenPaths = vi.fn(
			() =>
				new Promise<string[]>((done) => {
					resolve = () => done([grant.token]);
				})
		);
		const starting = initDesktopShell({ onMenuAction: vi.fn(), onOpenPaths, labels });
		await vi.waitFor(() => expect(onOpenPaths).toHaveBeenCalledOnce());
		expect(mocks.invoke).not.toHaveBeenCalledWith('ack_pending_open_paths', expect.anything());
		resolve();
		await starting;
		expect(mocks.invoke).toHaveBeenCalledWith('ack_pending_open_paths', {
			processed: [{ token: grant.token, queuedPath: grant.path }],
			rejectedPaths: []
		});
		mocks.invoke.mockClear();
		onOpenPaths.mockRejectedValueOnce(new Error('quota'));
		const listener = mocks.listen.mock.calls.find(
			([name]) => name === 'mdsh://open-paths-pending'
		)?.[1] as () => void;
		listener();
		await vi.waitFor(() => expect(mocks.reportError).toHaveBeenCalled());
		expect(mocks.invoke).not.toHaveBeenCalledWith('ack_pending_open_paths', expect.anything());
	});

	it('acknowledges only durable files, reports rejects and drains later batches', async () => {
		mocks.isDesktop.mockReturnValue(true);
		const first = nativeGrant('/tmp/first.md');
		const retry = nativeGrant('/tmp/retry.md');
		const last = nativeGrant('/tmp/last.md');
		let deliveries = 0;
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command !== 'take_pending_open_paths') return undefined;
			deliveries += 1;
			return deliveries === 1
				? pendingDelivery([first, retry], [{ path: '/tmp/binary.md', reason: 'invalid UTF-8' }], 1)
				: pendingDelivery([last]);
		});
		const onOpenPaths = vi
			.fn<(grants: NativeDiskGrant[]) => Promise<string[]>>()
			.mockResolvedValueOnce([first.token])
			.mockResolvedValueOnce([last.token]);

		await initDesktopShell({ onMenuAction: vi.fn(), onOpenPaths, labels });

		expect(mocks.reportError).toHaveBeenCalledWith(
			'rejected desktop files',
			expect.objectContaining({ message: expect.stringContaining('invalid UTF-8') }),
			expect.objectContaining({ notifyUser: expect.any(String) })
		);
		expect(mocks.invoke).toHaveBeenCalledWith('ack_pending_open_paths', {
			processed: [],
			rejectedPaths: ['/tmp/binary.md']
		});
		expect(mocks.invoke).toHaveBeenCalledWith('take_pending_open_paths', {
			excludePaths: ['/tmp/retry.md']
		});
		expect(mocks.invoke).toHaveBeenCalledWith('ack_pending_open_paths', {
			processed: [{ token: first.token, queuedPath: first.path }],
			rejectedPaths: []
		});
		expect(mocks.invoke).toHaveBeenCalledWith('ack_pending_open_paths', {
			processed: [{ token: last.token, queuedPath: last.path }],
			rejectedPaths: []
		});
	});

	it('recovers menu rebuilds and disposes the replaced native menu', async () => {
		mocks.isDesktop.mockReturnValue(true);
		const close = vi.fn();
		mocks.setAsAppMenu.mockResolvedValue({ close });
		await initDesktopShell({ onMenuAction: vi.fn(), onOpenPaths: vi.fn() });
		expect(mocks.reportWarning).toHaveBeenCalled();
		await initDesktopShell({ onMenuAction: vi.fn(), onOpenPaths: vi.fn(), labels });
		expect(close).toHaveBeenCalled();
		mocks.menuItemNew.mockRejectedValueOnce(new Error('menu rebuild'));
		window.dispatchEvent(new Event('mdsh:locale-change'));
		await vi.waitFor(() =>
			expect(mocks.reportWarning).toHaveBeenCalledWith(
				'update desktop menu locale',
				expect.any(Error)
			)
		);
	});

	it('reports a close guard startup failure and unregisters the unusable listener', async () => {
		mocks.isDesktop.mockReturnValue(true);
		mocks.invoke.mockImplementation(async (name: string) => {
			if (name === 'desktop_arm_close_guard') throw new Error('bridge unavailable');
			return [];
		});
		await initDesktopShell({
			onMenuAction: vi.fn(),
			onOpenPaths: vi.fn(),
			onBeforeClose: vi.fn(),
			labels
		});
		expect(mocks.unlisten).toHaveBeenCalledOnce();
		expect(mocks.reportError).toHaveBeenCalledWith(
			'install desktop close guard',
			expect.any(Error),
			expect.objectContaining({ notifyUser: expect.any(String) })
		);
	});

	it('blocks unsupported external schemes and reports opener failures without navigating', async () => {
		mocks.isDesktop.mockReturnValue(true);
		await initDesktopShell({ onMenuAction: vi.fn(), onOpenPaths: vi.fn(), labels });
		for (const href of ['file:///tmp/file.md', 'mailto:test@example.com', '/another-path']) {
			const anchor = document.createElement('a');
			anchor.href = href;
			document.body.append(anchor);
			expect(
				anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
			).toBe(false);
			anchor.remove();
		}
		expect(mocks.reportError).toHaveBeenCalledTimes(3);
		mocks.invoke.mockRejectedValue(new Error('opener unavailable'));
		const anchor = document.createElement('a');
		anchor.href = 'https://example.com';
		document.body.append(anchor);
		anchor.click();
		anchor.remove();
		await vi.waitFor(() => expect(mocks.reportError).toHaveBeenCalledTimes(4));
	});

	it('leaves wiki links, downloads, fragments and non-links to their own handlers', async () => {
		mocks.isDesktop.mockReturnValue(true);
		await initDesktopShell({ onMenuAction: vi.fn(), onOpenPaths: vi.fn(), labels });
		mocks.invoke.mockClear();
		for (const attribute of ['data-mdsh-wiki', 'download']) {
			const anchor = document.createElement('a');
			anchor.href = '#inside';
			anchor.setAttribute(attribute, '');
			document.body.append(anchor);
			anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			anchor.remove();
		}
		for (const href of ['#section', window.location.href]) {
			const anchor = document.createElement('a');
			anchor.href = href;
			document.body.append(anchor);
			anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			anchor.remove();
		}
		document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(mocks.invoke).not.toHaveBeenCalled();
	});
});
