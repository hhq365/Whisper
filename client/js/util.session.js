const KEY = 'whisper-session-v1';
const VAULT = 'whisper-tab-vault-v1';
let vault;
let discarded = false;
let initialized = false;
let superseded;
export function beginSession() {
	if (initialized) return vault.id;
	initialized = true;
	let previous;
	try { previous = JSON.parse(sessionStorage.getItem(VAULT)); } catch {}
	const reload = performance.getEntriesByType('navigation')[0]?.type === 'reload';
	if (reload && previous?.resumeOnReload && previous?.id && previous?.keys && typeof previous.keys === 'object') vault = previous;
	else {
		superseded = previous?.id;
		vault = { id: crypto.randomUUID(), keys: {} };
		try { sessionStorage.removeItem(KEY); } catch {}
	}
	vault.resumeOnReload = false;
	persistVault();
	return vault.id;
}
export function prepareSessionReload() {
	if (!discarded) { vault.resumeOnReload = true; persistVault(); }
}
function persistVault() {
	try { sessionStorage.setItem(VAULT, JSON.stringify(vault)); } catch {}
}
export function sessionId() { return beginSession(); }
export function supersededSessionId() { return superseded; }
export function sessionDiscarded() { return discarded; }
export function discardSession() {
	beginSession();
	discarded = true;
	vault.keys = {};
	try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(VAULT); } catch {}
}
export function newSession() {
	vault = { id: crypto.randomUUID(), keys: {} };
	initialized = true;
	discarded = false;
	try { sessionStorage.removeItem(KEY); } catch {}
	persistVault();
	return vault.id;
}
export async function historyKey(scope, create = false) {
	beginSession();
	if (discarded) throw new Error('Session has ended');
	let raw = vault.keys[scope];
	if (!raw && create) {
		raw = Array.from(crypto.getRandomValues(new Uint8Array(32)));
		vault.keys[scope] = raw;
		persistVault();
	}
	if (!raw) return null;
	return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export function forgetHistoryKey(scope) {
	beginSession();
	delete vault.keys[scope];
	if (!discarded) persistVault();
}
export function readSession() {
	beginSession();
	if (discarded) return null;
	try {
		const value = JSON.parse(sessionStorage.getItem(KEY));
		if (!value || !Array.isArray(value.rooms)) return null;
		if (!value.rooms.every(r => r && ['userName', 'roomName', 'password'].every(k => typeof r[k] === 'string') && r.userName && r.roomName)) return null;
		return value;
	} catch { return null; }
}
export function writeSession(rooms, active) {
	beginSession();
	if (discarded) return false;
	try {
		if (!rooms.length) sessionStorage.removeItem(KEY);
		else sessionStorage.setItem(KEY, JSON.stringify({ rooms, active }));
		return true;
	} catch { return false; }
}
function encodeInvitation(value) {
	return btoa(unescape(encodeURIComponent(value))).split('').map(c => String.fromCharCode(c.charCodeAt(0) + 3)).join('');
}
function decodeInvitation(value) {
	const base64 = value.split('').map(c => String.fromCharCode(c.charCodeAt(0) - 3)).join('');
	return decodeURIComponent(escape(atob(base64)));
}
export function roomURL(roomName, password = '', options = {}) {
	const url = new URL(location.pathname, location.origin);
	url.searchParams.set('r', encodeInvitation(roomName));
	if (password) url.searchParams.set('p', encodeInvitation(password));
	if (options.historyToken) url.searchParams.set('h', options.historyToken);
	return url.href;
}
export function invitationData() {
	const params = new URLSearchParams(location.search);
	try {
		const roomName = params.has('r') ? decodeInvitation(params.get('r')) : params.get('node');
		if (!roomName) return null;
		const password = params.has('p') ? decodeInvitation(params.get('p')) : (params.get('pwd') || '');
		return { roomName, password, historyToken: params.get('h') || undefined };
	} catch { return null; }
}
export function invitedRoom() { return invitationData()?.roomName ?? null; }
