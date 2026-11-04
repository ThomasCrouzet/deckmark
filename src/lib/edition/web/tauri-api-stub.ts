// Web Light boundary: importing this module replaces @tauri-apps/api packages
// at build time. Desktop behavior is unreachable in this edition.

function unavailable(): never {
	throw new Error('The native Tauri bridge is not available in the Web edition.');
}

export const invoke = unavailable;
export const listen = unavailable;
export const emit = unavailable;
export const once = unavailable;
export const getCurrentWindow = unavailable;
export const appWindow = {
	listen: unavailable,
	emit: unavailable
};

export class Menu {
	static new = unavailable;
}
export class MenuItem {
	static new = unavailable;
}
export class PredefinedMenuItem {
	static new = unavailable;
}
export class Submenu {
	static new = unavailable;
}

export default {
	invoke,
	listen,
	emit,
	once,
	getCurrentWindow,
	appWindow,
	Menu,
	MenuItem,
	PredefinedMenuItem,
	Submenu
};
