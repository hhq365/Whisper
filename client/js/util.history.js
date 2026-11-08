import { beginSession, sessionId, historyKey, forgetHistoryKey, discardSession, sessionDiscarded, newSession, prepareSessionReload, supersededSessionId } from './util.session.js';

let database;
let ready;
let releaseOwner;
const revoked = new Set();
function openDatabase() {
	if (!database) database = new Promise((resolve, reject) => {
		const request = indexedDB.open('whisper-history', 5);
		request.onupgradeneeded = () => {
			const db = request.result;
			// Remove the previous persistent/plaintext history when switching policies.
			for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
			for (const name of ['messages', 'attachments', 'replicas']) {
				const store = db.createObjectStore(name, { keyPath: ['scope', 'id'] });
				store.createIndex('scope', 'scope');
				store.createIndex('session', 'session');
			}
			db.createObjectStore('sessions', { keyPath: 'id' });
		};
		request.onsuccess = () => {
			request.result.onversionchange = () => { request.result.close(); database = null; };
			resolve(request.result);
		};
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error('History database is blocked'));
	}).catch(error => { database = null; throw error; });
	return database;
}
async function transaction(action) {
	const db = await openDatabase();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(['messages', 'attachments', 'replicas', 'sessions'], 'readwrite');
		let result;
		tx.oncomplete = () => resolve(result);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error || new Error('History transaction aborted'));
		action(tx, value => { result = value; });
	});
}
function deleteByIndex(store, index, value) {
	const request = store.index(index).openCursor(value);
	request.onsuccess = () => {
		const cursor = request.result;
		if (cursor) { cursor.delete(); cursor.continue(); }
	};
}
function deleteSession(id) {
	return transaction(tx => {
		for (const name of ['messages', 'attachments', 'replicas']) deleteByIndex(tx.objectStore(name), 'session', id);
		tx.objectStore('sessions').delete(id);
	});
}
async function ownSession(id) {
	if (!navigator.locks) return true;
	return new Promise((resolve, reject) => {
		navigator.locks.request('whisper-session:' + id, { ifAvailable: true }, lock => {
			if (!lock) { resolve(false); return; }
			resolve(true);
			return new Promise(release => { releaseOwner = release; });
		}).catch(reject);
	});
}
export function initializeHistoryLifecycle() {
	if (ready) return ready;
	const id = beginSession();
	// A BFCache restoration is a return visit, not a refresh.
	window.addEventListener('pageshow', event => {
		if (event.persisted) { abandonHistory(); location.reload(); }
	});
	let knownDeparture = false;
	window.navigation?.addEventListener('navigate', event => {
		if (event.downloadRequest != null || event.destination.sameDocument) return;
		knownDeparture = event.navigationType !== 'reload';
	});
	window.addEventListener('pagehide', event => {
		try { localStorage.setItem('whisper-detached:' + sessionId(), String(Date.now())); } catch {}
		if (knownDeparture || event.persisted) abandonHistory();
		else prepareSessionReload();
		releaseOwner?.();
	});
	ready = (async () => {
		// A duplicated tab must not share another tab's history or encryption keys.
		if (!await ownSession(id)) await ownSession(newSession());
		try { localStorage.removeItem('whisper-detached:' + sessionId()); } catch {}
		await transaction(tx => tx.objectStore('sessions').put({ id: sessionId(), lastActive: Date.now() }));
		// Only collect known-ended sessions. An unlocked session may be a slow reload.
		const abandoned = new Set([supersededSessionId()].filter(Boolean));
		try {
			for (let i = 0; i < localStorage.length; i++) {
				const key = localStorage.key(i);
				if (key.startsWith('whisper-abandoned:')) abandoned.add(key.slice('whisper-abandoned:'.length));
			}
		} catch {}
		// Unknown unloads include reloads: allow a handoff window before reclaiming ciphertext.
		const sessions = await transaction((tx, done) => {
			const request = tx.objectStore('sessions').getAll();
			request.onsuccess = () => done(request.result);
		});
		for (const old of sessions) {
			let lastActive = old.lastActive;
			try { lastActive = Number(localStorage.getItem('whisper-detached:' + old.id)) || lastActive; } catch {}
			if (Date.now() - lastActive > 5 * 60 * 1000) abandoned.add(old.id);
		}
		for (const old of abandoned) {
			if (old === sessionId()) continue;
			const remove = async () => {
				await deleteSession(old);
				try { localStorage.removeItem('whisper-abandoned:' + old); localStorage.removeItem('whisper-detached:' + old); } catch {}
			};
			if (navigator.locks) await navigator.locks.request('whisper-session:' + old, { ifAvailable: true }, lock => lock ? remove() : undefined);
			// Without Web Locks, do not risk deleting a different tab's copied session.
		}

	})();
	return ready;
}
export function abandonHistory() {
	const id = sessionId();
	try { localStorage.setItem('whisper-abandoned:' + id, '1'); } catch {}
	discardSession(); // Synchronously revoke keys even if IndexedDB cleanup is interrupted.
	window.dispatchEvent(new Event('whisper-session-ended'));
	void deleteSession(id).then(() => {
		try { localStorage.removeItem('whisper-abandoned:' + id); localStorage.removeItem('whisper-detached:' + id); } catch {}
	}).catch(() => {});
}
export async function historyScope(roomName, password, userName, epoch = '') {
	const data = new TextEncoder().encode(JSON.stringify([sessionId(), roomName, password, userName, epoch]));
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
async function encrypt(scope, id, bytes, kind) {
	const key = await historyKey(scope, true);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(scope + ':' + id + ':' + kind) }, key, bytes);
	return { iv, data };
}
async function decrypt(scope, id, payload, kind) {
	const key = await historyKey(scope);
	if (!key) return null;
	return crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.iv, additionalData: new TextEncoder().encode(scope + ':' + id + ':' + kind) }, key, payload.data);
}
export async function loadHistory(scope) {
	if (!await historyKey(scope)) { await clearHistory(scope); return []; }
	const rows = await transaction((tx, done) => {
		const request = tx.objectStore('messages').index('scope').getAll(scope);
		request.onsuccess = () => done(request.result);
	});
	const messages = [];
	for (const row of rows) {
		const bytes = await decrypt(scope, row.id, row, 'message');
		if (bytes) messages.push({ ...JSON.parse(new TextDecoder().decode(bytes)), scope });
	}
	return messages.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}
export async function saveMessage(scope, message, attachment = null) {
	if (revoked.has(scope) || sessionDiscarded()) return;
	if (!['text', 'text_private', 'image', 'image_private', 'file', 'file_private'].includes(message.msgType)) return;
	const payload = await encrypt(scope, message.id, new TextEncoder().encode(JSON.stringify(message)), 'message');
	const file = attachment ? await encrypt(scope, message.id, await attachment.arrayBuffer(), 'attachment') : null;
	if (revoked.has(scope) || sessionDiscarded()) return;
	return transaction(tx => {
		if (revoked.has(scope) || sessionDiscarded()) return;
		const base = { id: message.id, scope, session: sessionId() };
		tx.objectStore('sessions').put({ id: sessionId(), lastActive: Date.now() });
		tx.objectStore('messages').put({ ...base, ...payload });
		if (file) tx.objectStore('attachments').put({ ...base, ...file });
	});
}
export async function loadAttachment(scope, id) {
	const row = await transaction((tx, done) => {
		const request = tx.objectStore('attachments').get([scope, id]);
		request.onsuccess = () => done(request.result);
	});
	if (!row || row.scope !== scope) return null;
	const bytes = await decrypt(scope, id, row, 'attachment');
	return bytes ? new Blob([bytes], { type: 'application/json' }) : null;
}
export function clearHistory(scope) {
	return transaction(tx => {
		for (const name of ['messages', 'attachments', 'replicas']) deleteByIndex(tx.objectStore(name), 'scope', scope);
	});
}
export function revokeRoomHistory(scope) {
	revoked.add(scope);
	forgetHistoryKey(scope);
}
export function allowRoomHistory(scope) { revoked.delete(scope); }

export function canReadRecord(access, seq) {
	return !!access && Number.isSafeInteger(seq) && seq > 0 && (seq >= access.readFrom || (access.historyRanges || []).some(([start, end]) => seq >= start && seq <= end));
}
export function loadReplicas(scope, access) {
	return transaction((tx, done) => {
		const request = tx.objectStore('replicas').index('scope').getAll(scope);
		request.onsuccess = () => {
			// Remove hidden replicas left by the previous replication policy on refresh.
			const kept = [];
			for (const record of request.result) {
				if (canReadRecord(access, record.seq)) kept.push(record);
				else tx.objectStore('replicas').delete([scope, record.id]);
			}
			done(kept);
		};
	});
}
export async function saveReplica(scope, record) {
	await historyKey(scope, true);
	if (revoked.has(scope) || sessionDiscarded()) return Promise.resolve();
	return transaction(tx => {
		if (!revoked.has(scope) && !sessionDiscarded()) tx.objectStore('replicas').put({ ...record, scope, session: sessionId() });
	});
}

