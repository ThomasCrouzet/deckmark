import type { CrossTabMessage } from './cross-tab';
import type { MessageKey } from './i18n';

export interface CrossTabPolicyContext {
	isLoaded: (id: string) => boolean;
	isPending: (id: string) => boolean;
	hasAnyPending: () => boolean;
}

export type CrossTabDecision =
	| { kind: 'ignore' }
	| { kind: 'sync-draft'; id: string }
	| { kind: 'close-removed'; id: string }
	| { kind: 'reload' }
	| { kind: 'reload-and-siblings' }
	| { kind: 'conflict-draft'; id: string }
	| { kind: 'conflict-removed'; id: string }
	| { kind: 'conflict-global'; invalidateAll: boolean };

export interface CrossTabPolicyHost extends CrossTabPolicyContext {
	fileName: (id: string) => string;
	syncDraft: (id: string) => void | Promise<void>;
	closeRemoved: (id: string) => void;
	reloadQuiet: () => void | Promise<void>;
	reloadSiblings: () => void;
	invalidateAll: () => void;
	notifyConflict: (message: string) => void;
	t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

export function decideCrossTab(msg: CrossTabMessage, ctx: CrossTabPolicyContext): CrossTabDecision {
	if (msg.type === 'draft-written') {
		if (ctx.isPending(msg.id)) return { kind: 'conflict-draft', id: msg.id };
		return { kind: 'sync-draft', id: msg.id };
	}
	if (msg.type === 'removed') {
		if (!ctx.isLoaded(msg.id)) return { kind: 'ignore' };
		if (ctx.isPending(msg.id)) return { kind: 'conflict-removed', id: msg.id };
		return { kind: 'close-removed', id: msg.id };
	}
	if (msg.type === 'reorder') {
		if (ctx.hasAnyPending()) return { kind: 'conflict-global', invalidateAll: false };
		return { kind: 'reload' };
	}
	// backup-applied: keep local writers armed. Their optimistic persistence
	// check archives the restored branch before any local overwrite.
	if (ctx.hasAnyPending()) return { kind: 'conflict-global', invalidateAll: false };
	return { kind: 'reload-and-siblings' };
}

export function applyCrossTabDecision(decision: CrossTabDecision, host: CrossTabPolicyHost): void {
	switch (decision.kind) {
		case 'ignore':
			return;
		case 'sync-draft':
			void host.syncDraft(decision.id);
			return;
		case 'close-removed':
			host.closeRemoved(decision.id);
			return;
		case 'reload':
			void host.reloadQuiet();
			return;
		case 'reload-and-siblings':
			void host.reloadQuiet();
			host.reloadSiblings();
			return;
		case 'conflict-draft':
			host.notifyConflict(host.t('files.modifiedInOtherTab', { name: host.fileName(decision.id) }));
			return;
		case 'conflict-removed':
			host.notifyConflict(host.t('files.deletedInOtherTab', { name: host.fileName(decision.id) }));
			return;
		case 'conflict-global':
			host.notifyConflict(host.t('files.otherTabChanges'));
	}
}

export function handleCrossTabPolicy(msg: CrossTabMessage, host: CrossTabPolicyHost): void {
	applyCrossTabDecision(decideCrossTab(msg, host), host);
}
