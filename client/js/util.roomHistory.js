// Public history lives exclusively in member browsers. The relay handles metadata only.
import { canReadRecord, historyScope, loadHistory, loadReplicas, saveReplica, clearHistory, allowRoomHistory, revokeRoomHistory } from './util.history.js';
import { sessionId } from './util.session.js';
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const bytes = value => Uint8Array.from(value.match(/../g), v => parseInt(v, 16));
const hash = async raw => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(raw))));
const encode = value => { let result = ''; for (let i = 0; i < value.length; i += 8192) result += String.fromCharCode(...value.subarray(i, i + 8192)); return btoa(result); };
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export class RoomHistory {
  constructor(rd, saved, hooks) {
    this.rd = rd; this.saved = saved || {}; this.hooks = hooks;
    this.records = new Map(); this.parts = new Map(); this.requested = new Set(); this.syncing = new Set();
    this.queue = Promise.resolve(); this.outgoing = Promise.resolve();
  }
  run(work) { this.queue = this.queue.then(() => { if (!this.rd.left) return work(); }).catch(this.hooks.error); return this.queue; }
  info(info) { return this.run(async () => {
    if (this.epoch !== info.epoch) {
      if (this.rd.scope) { const old = await this.rd.scope; revokeRoomHistory(old); await clearHistory(old).catch(this.hooks.error); }
      this.epoch = info.epoch; this.key = null; this.raw = null; this.records.clear(); this.parts.clear(); this.requested.clear(); this.syncing.clear();
      this.rd.messages = []; this.rd.fileTransfers.clear(); this.rd.connected = false;
      this.rd.scope = historyScope(this.rd.roomName, this.rd.password, this.rd.myUserName, info.epoch);
      const scope = await this.rd.scope; allowRoomHistory(scope);
      try {
        this.rd.messages = (await loadHistory(scope)).map(m => ({ ...m, restored: true }));
        for (const m of this.rd.messages) if (m.attachmentId) this.rd.fileTransfers.set(m.text.fileId, { ...m.text, status: 'completed', attachmentId: m.attachmentId, scope });
        for (const r of await loadReplicas(scope, info)) this.records.set(r.id, r);
      } catch (error) { this.hooks.error(error); }
    }
    this.state = info;
    this.rd.chat.roomJoin = { resumeToken: info.resumeToken };
    if (!this.key) {
      let raw = this.saved.epoch === info.epoch ? this.saved.key : null;
      if (!info.keyHash && info.owner === info.self) {
        raw = hex(crypto.getRandomValues(new Uint8Array(32)));
        await this.rd.chat.requestRoomState('register', { epoch: this.epoch, keyHash: await hash(raw) });
      }
      if (raw && /^[a-f0-9]{64}$/.test(raw) && (!info.keyHash || await hash(raw) === info.keyHash)) await this.acceptKey(raw);
    } else if (!this.rd.connected) await this.acceptKey(this.raw);
    this.sync();
    this.hooks.render();
  }); }
  async acceptKey(raw) {
    this.raw = raw;
    this.key = await crypto.subtle.importKey('raw', bytes(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    await this.rd.chat.requestRoomState('ready', { epoch: this.epoch, keyHash: await hash(raw) });
    this.rd.sharedHistory = { epoch: this.epoch, key: raw, resumeToken: this.state.resumeToken };
    this.saved = this.rd.sharedHistory;
    this.rd.connected = true;
    this.hooks.ready();
  }
  sync() {
    if (!this.state || this.rd.left) return;
    for (const id of this.state.readyPeers) {
      if (!this.rd.chat.channel[id]?.username) continue;
      if (!this.key) this.rd.chat.sendPeerMessage(id, 'room_history_key_request', { epoch: this.epoch });
      else if (!this.requested.has(id)) {
        this.requested.add(id); this.syncing.add(id);
        this.hooks.render();
        this.rd.chat.sendPeerMessage(id, 'room_history_sync', { epoch: this.epoch });
      }
    }
  }
  peerLeft(id) { this.requested.delete(id); this.syncing.delete(id); this.hooks.render(); for (const [key, part] of this.parts) if (part.peer === id) this.parts.delete(key); }
  receive(msg) {
    if (!msg.type.startsWith('room_history_')) return false;
    this.run(async () => {
      const d = msg.data;
      if (!d || d.epoch !== this.epoch) return;
      if (msg.type === 'room_history_key_request' && this.key) this.rd.chat.sendPeerMessage(msg.clientId, 'room_history_key', { epoch: this.epoch, key: this.raw });
      if (msg.type === 'room_history_key' && !this.key && /^[a-f0-9]{64}$/.test(d.key) && await hash(d.key) === this.state.keyHash) { await this.acceptKey(d.key); this.sync(); }
      if (msg.type === 'room_history_end') { this.syncing.delete(msg.clientId); this.hooks.render(); }
      if (msg.type === 'room_history_sync' && this.key) {
        // Do not block incoming traffic while a large snapshot is being sent.
        this.sendSnapshot(msg.clientId).catch(this.hooks.error);
      }
      if (msg.type === 'room_history_chunk' && this.key) {
        if (typeof d.id !== 'string' || !Number.isSafeInteger(d.seq) || !canReadRecord(this.state, d.seq) || !Number.isInteger(d.total) || d.total < 1 || !Number.isInteger(d.part) || d.part < 0 || d.part >= d.total || typeof d.data !== 'string' || d.data.length > 49152 || this.records.has(d.id)) return;
        const bufferKey = msg.clientId + ':' + d.id;
        let buffer = this.parts.get(bufferKey);
        if (!buffer) { buffer = { peer: msg.clientId, seq: d.seq, total: d.total, chunks: new Map() }; this.parts.set(bufferKey, buffer); }
        if (buffer.total !== d.total || buffer.seq !== d.seq) return;
        buffer.chunks.set(d.part, d.data);
        if (buffer.chunks.size === d.total) {
          this.parts.delete(bufferKey);
          let ciphertext = ''; for (let i = 0; i < d.total; i++) ciphertext += buffer.chunks.get(i);
          await this.merge({ id: d.id, seq: d.seq, ciphertext });
        }
      }
    });
    return true;
  }
  async sendRecord(peer, record) {
    // Apply the recipient’s server-issued join boundary before sending any bytes.
    if (!canReadRecord(this.state?.peerAccess?.[peer], record.seq)) return;
    const epoch = this.epoch;
    const total = Math.ceil(record.ciphertext.length / 49152);
    for (let part = 0; part < total; part++) {
      if (this.rd.left || epoch !== this.epoch) return;
      while (this.rd.chat?.connection?.bufferedAmount > 512 * 1024) {
        await new Promise(resolve => setTimeout(resolve, 20));
        if (this.rd.left || !this.rd.chat?.isOpen()) return;
      }
      if (!this.rd.chat.sendPeerMessage(peer, 'room_history_chunk', { epoch, id: record.id, seq: record.seq, part, total, data: record.ciphertext.slice(part * 49152, (part + 1) * 49152) })) return;
      if (part % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  async sendSnapshot(peer) { const epoch = this.epoch; for (const record of this.records.values()) { if (epoch !== this.epoch) return; await this.sendRecord(peer, record); } if (!this.rd.left && epoch === this.epoch) this.rd.chat.sendPeerMessage(peer, 'room_history_end', { epoch }); }
  publish(message, attachment) {
    if (message.type !== 'me' || message.imported || !['text', 'image', 'file'].includes(message.msgType)) return;
    const queuedEpoch = this.epoch;
    this.outgoing = this.outgoing.then(async () => {
      if (queuedEpoch !== this.epoch || this.rd.left || !this.key || this.records.has(message.id)) return;
      const epoch = this.epoch;
      const { seq } = await this.rd.chat.requestRoomState('sequence', { epoch });
      const value = { id: message.id, seq, text: message.text, msgType: message.msgType, timestamp: message.timestamp, author: this.rd.myUserName, authorSession: sessionId(), attachment: attachment ? await attachment.text() : null };
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, new TextEncoder().encode(JSON.stringify(value))));
      if (this.rd.left || epoch !== this.epoch) return;
      const record = { id: message.id, seq, ciphertext: encode(iv) + '.' + encode(encrypted) };
      this.records.set(record.id, record);
      await saveReplica(await this.rd.scope, record).catch(this.hooks.error);
      await Promise.all(Object.keys(this.rd.chat.channel).map(peer => this.sendRecord(peer, record)));
    }).catch(this.hooks.error);
    return this.outgoing;
  }
  async merge(record) {
    if (!canReadRecord(this.state, record.seq)) return;
    const [iv, ciphertext] = record.ciphertext.split('.');
    const value = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv) }, this.key, decode(ciphertext))));
    if (value.id !== record.id || value.seq !== record.seq || !['text', 'image', 'file'].includes(value.msgType)) return;
    this.records.set(record.id, record);
    await saveReplica(await this.rd.scope, record).catch(this.hooks.error);
    const existing = this.rd.messages.find(m => m.id === value.id || (value.msgType === 'file' && m.text?.fileId === value.text?.fileId));
    const message = existing || { id: value.id, seq: value.seq, text: value.text, msgType: value.msgType, timestamp: value.timestamp, type: value.authorSession === sessionId() ? 'me' : 'other', userName: value.author, avatar: value.author, restored: true, imported: true };
    if (!existing) {
      this.rd.messages.push(message);
      if (value.seq > this.state.seq) this.hooks.incoming?.(message);
    }
    let attachment;
    if (value.msgType === 'file' && value.attachment) {
      const volumeData = JSON.parse(value.attachment);
      attachment = new Blob([value.attachment], { type: 'application/json' });
      this.rd.fileTransfers.set(value.text.fileId, { ...value.text, volumeData, status: 'completed' });
    }
    await this.hooks.remember(message, attachment);
    this.rd.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    this.hooks.render();
  }
  async share(includeHistory) {
    if (!this.rd.connected) throw new Error('Room is disconnected');
    // Freeze the displayed public message set at click time, including pending own writes.
    const visibleIds = new Set(this.rd.messages.filter(m => ['text', 'image', 'file'].includes(m.msgType)).map(m => m.id));
    const epoch = this.epoch;
    let result = {};
    if (includeHistory) {
      await this.outgoing;
      if (this.rd.left || epoch !== this.epoch) throw new Error('Room has expired');
      const sequences = [...this.records.values()].filter(r => visibleIds.has(r.id) && canReadRecord(this.state, r.seq)).map(r => r.seq).sort((a, b) => a - b);
      const ranges = [];
      for (const seq of sequences) {
        const last = ranges.at(-1);
        if (last && seq <= last[1] + 1) last[1] = Math.max(last[1], seq);
        else ranges.push([seq, seq]);
      }
      result = await this.rd.chat.requestRoomState('share', { epoch, ranges });
    }
    return { historyToken: result.token };
  }
}
