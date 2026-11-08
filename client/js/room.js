import { RoomHistory } from './util.roomHistory.js';
import { saveMessage, clearHistory, revokeRoomHistory } from './util.history.js';
import { readSession, writeSession, roomURL, invitationData } from './util.session.js';
// Room management logic for NodeCrypt web client
// NodeCrypt 网页客户端的房间管理逻辑

import {
	createAvatarSVG
} from './util.avatar.js';
import {
	renderChatArea,
	addSystemMsg,
	updateChatInputStyle
} from './chat.js';
import {
	renderMainHeader,
	renderUserList
} from './ui.js';
import {
	escapeHTML
} from './util.string.js';
import {
	$id,
	createElement
} from './util.dom.js';
import { t } from './util.i18n.js';
let roomsData = [];
let activeRoomIndex = -1;

// Get a new room data object
// 获取一个新的房间数据对象
export function getNewRoomData() {
	return {
		roomName: '',
		userList: [],
		userMap: {},
		myId: null,
		myUserName: '',
		chat: null,
		messages: [],
		fileTransfers: new Map(),
		prevUserList: [],
		knownUserIds: new Set(),
		unreadCount: 0,
		privateChatTargetId: null,
		privateChatTargetName: null
	}
}

// Switch to another room by index
// 切换到指定索引的房间
export function switchRoom(index) {
	if (index < 0 || index >= roomsData.length) return;
	activeRoomIndex = index;
	const rd = roomsData[index];
	if (typeof rd.unreadCount === 'number') rd.unreadCount = 0;
	const sidebarUsername = document.getElementById('sidebar-username');
	if (sidebarUsername) sidebarUsername.textContent = rd.myUserName;
	setSidebarAvatar(rd.myUserName);
	renderRooms(index);
	renderMainHeader();
	renderUserList(false);
	renderChatArea();
	updateChatInputStyle();
	persistSession();
}

// Set the sidebar avatar
// 设置侧边栏头像
export function setSidebarAvatar(userName) {
	if (!userName) return;
	const svg = createAvatarSVG(userName);
	const el = $id('sidebar-user-avatar');
	if (el) {
		const cleanSvg = svg.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
		el.innerHTML = cleanSvg
	}
}

// Render the room list
// 渲染房间列表
export function renderRooms(activeId = 0) {
	const roomList = $id('room-list');
	roomList.innerHTML = '';
	roomsData.forEach((rd, i) => {
		const div = createElement('div', {
			class: 'room' + (i === activeId ? ' active' : ''),
			onclick: () => switchRoom(i)
		});
		const safeRoomName = escapeHTML(rd.roomName);
		let unreadHtml = '';
		if (rd.unreadCount && i !== activeId) {
			unreadHtml = `<span class="room-unread-badge">${rd.unreadCount>99?'99+':rd.unreadCount}</span>`
		}
		div.innerHTML = `<div class="info"><div class="title">#${safeRoomName}</div></div>${unreadHtml}`;
		roomList.appendChild(div)
	})
}

// Join a room
// 加入一个房间
export function joinRoom(userName, roomName, password, modal = null, onResult, saved = null) {
	const newRd = getNewRoomData();
	Object.assign(newRd, { roomName, myUserName: userName, password, connected: false });
	roomsData.push(newRd);
	const idx = roomsData.length - 1;
	const invitation = invitationData();
	const options = saved || (invitation?.roomName === roomName && invitation.password === password ? invitation : {});
	newRd.history = new RoomHistory(newRd, options.sharedHistory, {
		error: historyError,
		incoming: message => {
			if (roomsData[activeRoomIndex] !== newRd) { newRd.unreadCount++; renderRooms(activeRoomIndex); }
			window.notifyMessage?.(newRd.roomName, message.msgType, message.text, message.userName);
		},
		render: () => { if (roomsData[activeRoomIndex] === newRd) renderChatArea(); },
		remember: (m, attachment) => rememberMessage(newRd, m, attachment, true),
		ready: () => {
			if (newRd.securedEpoch !== newRd.history.epoch) {
				newRd.securedEpoch = newRd.history.epoch;
				newRd.messages.push({ type: 'system', text: t('system.secured'), timestamp: Date.now() });
			}
			newRd.joined = true;
			if (modal) modal.remove();
			persistSession();
			if (roomsData[activeRoomIndex] === newRd) renderChatArea();
			report(true);
		}
	});
	switchRoom(idx);
	if (!modal) {
		$id('login-container').style.display = 'none';
		$id('chat-container').style.display = '';
	}
	let reported = false;
	const report = success => {
		if (!reported && onResult) onResult(success);
		reported = true;
	};
	const callbacks = {
		onServerClosed: () => {
			if (!roomsData.includes(newRd)) return;
			newRd.connected = false;
			if (roomsData[activeRoomIndex] === newRd) renderChatArea();
			report(false);
		},
		onRoomState: info => newRd.history.info(info),
		// Resolve current indices: exiting another room can shift this room's index.
		onClientSecured: user => { handleClientSecured(roomsData.indexOf(newRd), user); newRd.history.sync(); },
		onClientList: (list, selfId) => handleClientList(roomsData.indexOf(newRd), list, selfId),
		onClientLeft: clientId => handleClientLeft(roomsData.indexOf(newRd), clientId),
		onClientMessage: msg => handleClientMessage(roomsData.indexOf(newRd), msg)
	};
	const chatInst = new window.NodeCrypt(window.config, callbacks);
	newRd.chat = chatInst;
	chatInst.roomJoin = { historyToken: options.historyToken, resumeToken: options.sharedHistory?.resumeToken };
	chatInst.setCredentials(userName, roomName, password);
	chatInst.connect();
	return newRd;
}

function historyError(error) {
	console.warn('Local history unavailable', error);
	const notice = document.getElementById('history-error');
	if (notice) notice.hidden = false;
}

export function rememberMessage(rd, message, attachment = null, imported = false) {
	if (!rd || rd.left || !['text', 'text_private', 'image', 'image_private', 'file', 'file_private'].includes(message.msgType)) return;
	// Incomplete transfers must not become broken download cards after a refresh.
	if (message.msgType.startsWith('file') && !attachment) return;
	message.id ||= message.msgType === 'file' ? message.text.fileId : crypto.randomUUID();
	const published = imported ? null : rd.history?.publish(message, attachment);
	if (attachment) message.attachmentId = message.id;
	rd.pendingWrites = (rd.pendingWrites || 0) + 1;
	updateSavingStatus(rd);
	rd.historyQueue = (rd.historyQueue || Promise.resolve()).then(async () => {
		if (!rd.left) await saveMessage(await rd.scope, message, attachment);
		await published;
	}).catch(historyError).finally(() => {
		rd.pendingWrites--;
		updateSavingStatus(rd);
	});
	return rd.historyQueue;
}

function updateSavingStatus(rd) {
	const saving = document.getElementById('history-saving');
	if (saving && roomsData[activeRoomIndex] === rd) saving.hidden = !rd.pendingWrites;
}

export function rememberFile(rd, transfer) {
	const message = rd.messages.find(m => m.text?.fileId === transfer.fileId && ['file', 'file_private'].includes(m.msgType));
	if (!message || transfer.status !== 'completed') return;
	const attachment = new Blob([JSON.stringify(transfer.volumeData)], { type: 'application/json' });
	rememberMessage(rd, message, attachment);
}

function persistSession() {
	const saved = roomsData.filter(rd => rd.joined);
	const current = roomsData[activeRoomIndex];
	if (!writeSession(saved.map(rd => ({ userName: rd.myUserName, roomName: rd.roomName, password: rd.password, sharedHistory: rd.sharedHistory })), Math.max(0, saved.indexOf(current)))) {
		const notice = document.getElementById('session-error');
		if (notice) notice.hidden = false;
	}
	if (current?.joined) history.replaceState({}, '', roomURL(current.roomName, current.password));
}

export function restoreSession() {
	const saved = readSession();
	if (!saved?.rooms.length) return;
	const invitation = invitationData();
	let active = Number.isInteger(saved.active) ? saved.active : 0;
	if (invitation !== null) {
		const matches = rd => rd?.roomName === invitation.roomName && rd.password === invitation.password;
		if (!matches(saved.rooms[active])) active = saved.rooms.findIndex(matches);
		if (active < 0) return; // A different invitation takes precedence.
	}
	for (const room of saved.rooms) {
		const rd = joinRoom(room.userName, room.roomName, room.password, null, null, room);
		rd.joined = true; // Retain saved rooms while an offline reconnect is pending.
	}
	switchRoom(Math.min(Math.max(active, 0), roomsData.length - 1));
}

// Handle the client list update
// 处理客户端列表更新
export function handleClientList(idx, list, selfId) {
	const rd = roomsData[idx];
	if (!rd) return;
	const oldUserIds = new Set((rd.userList || []).map(u => u.clientId));
	const newUserIds = new Set(list.map(u => u.clientId));
	for (const oldId of oldUserIds) {
		if (!newUserIds.has(oldId)) {
			handleClientLeft(idx, oldId)
		}
	}
	rd.userList = list;
	rd.userMap = {};
	list.forEach(u => {
		rd.userMap[u.clientId] = u
	});
	rd.myId = selfId;
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
	}
	rd.initCount = (rd.initCount || 0) + 1;
	if (rd.initCount === 2) {
		rd.isInitialized = true;
		rd.knownUserIds = new Set(list.map(u => u.clientId))
	}
}

// Handle client secured event
// 处理客户端安全连接事件
export function handleClientSecured(idx, user) {
	const rd = roomsData[idx];
	if (!rd) return;
	rd.userMap[user.clientId] = user;
	const existingUserIndex = rd.userList.findIndex(u => u.clientId === user.clientId);
	if (existingUserIndex === -1) {
		rd.userList.push(user)
	} else {
		rd.userList[existingUserIndex] = user
	}
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
	}
	if (!rd.isInitialized) {
		return
	}
	const isNew = !rd.knownUserIds.has(user.clientId);
	if (isNew) {
		rd.knownUserIds.add(user.clientId);		const name = user.userName || user.username || user.name || t('ui.anonymous', 'Anonymous');
		const msg = `${name} ${t('system.joined', 'joined the conversation')}`;
		rd.messages.push({
			type: 'system',
			text: msg
		});
		if (activeRoomIndex === idx) addSystemMsg(msg, true);
		if (window.notifyMessage) {
			window.notifyMessage(rd.roomName, 'system', msg)
		}
	}
}

// Handle client left event
// 处理客户端离开事件
export function handleClientLeft(idx, clientId) {
	const rd = roomsData[idx];
	if (!rd) return;
	rd.history?.peerLeft(clientId);
	if (rd.privateChatTargetId === clientId) {
		rd.privateChatTargetId = null;
		rd.privateChatTargetName = null;
		if (activeRoomIndex === idx) {
			updateChatInputStyle()
		}
	}
	const user = rd.userMap[clientId];
	const name = user ? (user.userName || user.username || user.name || 'Anonymous') : 'Anonymous';
	const msg = `${name} ${t('system.left', 'left the conversation')}`;
	rd.messages.push({
		type: 'system',
		text: msg
	});
	if (activeRoomIndex === idx) addSystemMsg(msg, true);
	rd.userList = rd.userList.filter(u => u.clientId !== clientId);
	delete rd.userMap[clientId];
	if (activeRoomIndex === idx) {
		renderUserList(false);
		renderMainHeader()
	}
}

// Handle client message event
// 处理客户端消息事件
export function handleClientMessage(idx, msg) {
	const newRd = roomsData[idx];
	if (!newRd) return;
	if (newRd.history.receive(msg)) return;
	msg.userName ||= msg.username;

	// Prevent processing own messages unless it's a private message sent to oneself
	if (msg.clientId === newRd.myId && msg.userName === newRd.myUserName && !(msg.type || 'text').includes('_private')) {
		return;
	}

	let msgType = msg.type || 'text';

	// Handle file messages
	if (msgType.startsWith('file_')) {
		// Part 1: Update message history and send notifications (for 'file_start' type)
		if (msgType === 'file_start' || msgType === 'file_start_private') {
			let realUserName = msg.userName;
			if (!realUserName && msg.clientId && newRd.userMap[msg.clientId]) {
				realUserName = newRd.userMap[msg.clientId].userName || newRd.userMap[msg.clientId].username || newRd.userMap[msg.clientId].name;
			}
			const historyMsgType = msgType === 'file_start_private' ? 'file_private' : 'file';
			
			const fileId = msg.data && msg.data.fileId;
			if (fileId) { // Only proceed if we have a fileId
				const messageAlreadyInHistory = newRd.messages.some(
					m => m.msgType === historyMsgType && m.text && m.text.fileId === fileId && m.userName === realUserName
				);

				if (!messageAlreadyInHistory) {
					newRd.messages.push({
						id: fileId,
						type: 'other',
						text: msg.data, // This is the file metadata object
						userName: realUserName,
						avatar: realUserName,
						msgType: historyMsgType,
						timestamp: Date.now()
					});
				}
			}

			const notificationMsgType = msgType.includes('_private') ? 'private file' : 'file';
			if (window.notifyMessage && msg.data && msg.data.fileName) {
				window.notifyMessage(newRd.roomName, notificationMsgType, `${msg.data.fileName}`, realUserName);
			}
		}

		// Receive all volumes even when another room is active.
		if (window.handleFileMessage) window.handleFileMessage(msg.data, msgType.includes('_private'), newRd);
		if (activeRoomIndex !== idx && (msgType === 'file_start' || msgType === 'file_start_private')) {
			newRd.unreadCount = (newRd.unreadCount || 0) + 1;
			renderRooms(activeRoomIndex);
		}
		return; // File messages are fully handled.
	}

	// Handle image messages (both new and legacy formats)
	if (msgType === 'image' || msgType === 'image_private') {
		// Already has correct type
	} else if (!msgType.includes('_private')) {
		// Handle legacy image detection
		if (msg.data && typeof msg.data === 'string' && msg.data.startsWith('data:image/')) {
			msgType = 'image';
		} else if (msg.data && typeof msg.data === 'object' && msg.data.image) {
			msgType = 'image';
		}
	}
	let realUserName = msg.userName;
	if (!realUserName && msg.clientId && newRd.userMap[msg.clientId]) {
		realUserName = newRd.userMap[msg.clientId].userName || newRd.userMap[msg.clientId].username || newRd.userMap[msg.clientId].name;
	}

	// Add message to messages array for chat history
	roomsData[idx].messages.push({
		type: 'other',
		text: msg.data,
		userName: realUserName,
		avatar: realUserName,
		msgType: msgType,
		timestamp: Date.now()
	});

	rememberMessage(newRd, newRd.messages[newRd.messages.length - 1]);

	// Only add message to chat display if it's for the active room
	if (activeRoomIndex === idx) {
		if (window.addOtherMsg) {
			window.addOtherMsg(msg.data, realUserName, realUserName, false, msgType);
		}
	} else {
		roomsData[idx].unreadCount = (roomsData[idx].unreadCount || 0) + 1;
		renderRooms(activeRoomIndex);
	}

	const notificationMsgType = msgType.includes('_private') ? `private ${msgType.split('_')[0]}` : msgType;
	if (window.notifyMessage) {
		window.notifyMessage(newRd.roomName, notificationMsgType, msg.data, realUserName);
	}
}

// Toggle private chat with a user
// 切换与某用户的私聊
export function togglePrivateChat(targetId, targetName) {
	const rd = roomsData[activeRoomIndex];
	if (!rd) return;
	if (rd.privateChatTargetId === targetId) {
		rd.privateChatTargetId = null;
		rd.privateChatTargetName = null
	} else {
		rd.privateChatTargetId = targetId;
		rd.privateChatTargetName = targetName
	}
	renderUserList();
	updateChatInputStyle()
}


// Exit the current room
// 退出当前房间
export async function exitRoom() {
	const rd = roomsData[activeRoomIndex];
	if (!rd) return false;
	rd.left = true;
	const chat = rd.chat;
	rd.chat = null;
	roomsData.splice(activeRoomIndex, 1);
	chat?.destruct?.();
	rd.messages = [];
	rd.fileTransfers.clear();
	if (roomsData.length) switchRoom(0);
	else {
		activeRoomIndex = -1;
		persistSession();
		history.replaceState({}, '', location.pathname);
	}
	// Wait for already-started writes, then revoke this room's key and delete its data.
	try {
		const scope = await rd.scope;
		revokeRoomHistory(scope);
		await rd.historyQueue;
		await clearHistory(scope);
	} catch (error) { historyError(error); }
	return roomsData.length > 0;
}

window.addEventListener('whisper-session-ended', () => {
	for (const rd of roomsData) {
		rd.left = true;
		rd.chat?.destruct?.();
		rd.messages = [];
		rd.fileTransfers.clear();
	}
	roomsData = [];
	activeRoomIndex = -1;
	const area = document.getElementById('chat-area');
	if (area) area.replaceChildren();
});

export { roomsData, activeRoomIndex };

// Listen for sidebar username update event
// 监听侧边栏用户名更新事件
window.addEventListener('updateSidebarUsername', () => {
	if (activeRoomIndex >= 0 && roomsData[activeRoomIndex]) {
		const rd = roomsData[activeRoomIndex];
		const sidebarUsername = document.getElementById('sidebar-username');
		if (sidebarUsername && rd.myUserName) {
			sidebarUsername.textContent = rd.myUserName;
		}
		// Also update the avatar to ensure consistency
		if (rd.myUserName) {
			setSidebarAvatar(rd.myUserName);
		}
	}
});