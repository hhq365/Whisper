// Presence/epoch metadata only. No messages, ciphertext, images or files are stored here.
class RoomPresence {
  constructor({ send, uuid, delay = (fn, ms) => setTimeout(fn, ms), cancel = timer => clearTimeout(timer), graceMs = 10000 }) {
    Object.assign(this, { send, uuid, delay, cancel, graceMs });
    this.rooms = new Map(); this.members = new Map();
  }
  create(channel) {
    const room = { channel, epoch: this.uuid(), invitations: new Map(), members: new Set(), resumes: new Map(), sequence: 0, keyHash: null, owner: null, timer: null };
    this.rooms.set(channel, room); return room;
  }
  join(id, channel, options = {}) {
    const room = this.rooms.get(channel) || this.create(channel);
    const resumed = typeof options.resumeToken === 'string' && room.resumes.get(options.resumeToken);
    const invitation = room.invitations.get(options.historyToken);
    const readFrom = resumed ? resumed.readFrom : room.sequence + 1;
    const historyRanges = resumed ? resumed.historyRanges : (invitation || []);
    const resumeToken = resumed ? options.resumeToken : this.uuid() + this.uuid();
    room.resumes.set(resumeToken, { readFrom, historyRanges });
    const member = { id, room, readFrom, historyRanges, resumeToken, ready: false, historyExpired: !!options.historyToken && !invitation && !resumed };
    this.members.set(id, member); room.members.add(id);
    if (!room.owner || !room.members.has(room.owner)) room.owner = id;
    this.info(member);
    if (room.keyHash && !this.hasReady(room) && !room.timer) this.scheduleEmpty(room);
  }
  hasReady(room) { return [...room.members].some(id => this.members.get(id)?.ready); }
  info(member) {
    const room = member.room;
    this.send(member.id, { a: 'room_state', op: 'info', epoch: room.epoch, keyHash: room.keyHash, owner: room.owner, self: member.id, readFrom: member.readFrom, historyRanges: member.historyRanges, resumeToken: member.resumeToken, historyExpired: member.historyExpired, peerAccess: Object.fromEntries([...room.members].map(id => { const peer = this.members.get(id); return [id, { readFrom: peer.readFrom, historyRanges: peer.historyRanges }]; })), readyPeers: [...room.members].filter(id => id !== member.id && this.members.get(id)?.ready), seq: room.sequence });
  }
  broadcastInfo(room) { for (const id of room.members) this.info(this.members.get(id)); }
  scheduleEmpty(room) {
    if (room.timer) return;
    room.timer = this.delay(() => {
      if (this.rooms.get(room.channel) !== room || this.hasReady(room)) return;
      const waiting = [...room.members];
      this.rooms.delete(room.channel);
      for (const id of waiting) this.members.delete(id);
      for (const id of waiting) this.join(id, room.channel);
      room.resumes.clear();
    }, this.graceMs);
    room.timer?.unref?.();
  }
  leave(id) {
    const member = this.members.get(id); if (!member) return;
    const room = member.room;
    this.members.delete(id); room.members.delete(id);
    if (room.owner === id) room.owner = [...room.members][0] || null;
    if (!this.hasReady(room)) this.scheduleEmpty(room);
    this.broadcastInfo(room);
  }
  handle(id, request) {
    const member = this.members.get(id);
    if (!member || typeof request.id !== 'string') return;
    const room = member.room;
    const reply = (result, error) => this.send(id, { a: 'room_state', op: 'reply', id: request.id, result, error });
    if (request.epoch && request.epoch !== room.epoch) { reply(null, 'room_expired'); return; }
    try {
      switch (request.op) {
        case 'register':
          if (room.owner !== id || room.keyHash || !/^[a-f0-9]{64}$/.test(request.keyHash)) throw new Error('invalid_key_registration');
          room.keyHash = request.keyHash;
          member.ready = true;
          if (room.timer) { this.cancel(room.timer); room.timer = null; }
          reply({}); this.broadcastInfo(room); break;
        case 'ready': {
          if (!room.keyHash || request.keyHash !== room.keyHash) throw new Error('wrong_key');
          const changed = !member.ready;
          member.ready = true;
          if (room.timer) { this.cancel(room.timer); room.timer = null; }
          reply({}); if (changed) this.broadcastInfo(room); break;
        }
        case 'share': {
          if (!member.ready) throw new Error('not_ready');
          if (!Array.isArray(request.ranges)) throw new Error('invalid_history_range');
          let previous = 0;
          const ranges = request.ranges.map(range => {
            if (!Array.isArray(range) || range.length !== 2) throw new Error('invalid_history_range');
            const [start, end] = range;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= previous || end < start || end > room.sequence) throw new Error('invalid_history_range');
            // Every sequence in the requested interval must be within this member's grant.
            let cursor = start;
            for (const [lo, hi] of member.historyRanges) {
              if (hi < cursor) continue;
              if (lo > cursor) break;
              cursor = Math.max(cursor, hi + 1);
              if (cursor > end) break;
            }
            if (cursor <= end && cursor < member.readFrom) throw new Error('history_not_allowed');
            previous = end;
            return [start, end];
          });
          const token = this.uuid() + this.uuid();
          room.invitations.set(token, ranges);
          reply({ token, epoch: room.epoch }); break;
        }
        case 'sequence':
          if (!member.ready) throw new Error('not_ready');
          reply({ seq: ++room.sequence }); break;
        default: throw new Error('unknown_action');
      }
    } catch (error) { reply(null, error.message); }
  }
}
module.exports = { RoomPresence };
