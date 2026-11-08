const {test} = require('node:test');
const assert = require('node:assert/strict');
const {RoomPresence} = require('../server/room-presence.cjs');
function fixture() {
  let n=0; const output=[], timers=new Map();
  const presence=new RoomPresence({uuid:()=>String(++n),send:(id,data)=>output.push({id,...data}),delay:(fn,ms)=>{const id=++n;timers.set(id,{fn,ms});return id;},cancel:id=>timers.delete(id)});
  const request=(id,op,data={})=>{presence.handle(id,{id:'request',op,...data});return output.findLast(m=>m.op==='reply');};
  const expire=()=>{const pending=[...timers.values()];timers.clear();for(const {fn,ms} of pending){assert.equal(ms,10000);fn();}};
  return {presence,output,request,expire};
}
test('metadata tracks normal/full/resumed visibility; never retains message content',()=>{
  const {presence:p,request:r,output}=fixture(); p.join('a','room'); const epoch=p.rooms.get('room').epoch;
  r('a','register',{keyHash:'a'.repeat(64)});r('a','sequence');
  p.join('b','room');assert.equal(p.members.get('b').readFrom,2);
  r('b','ready',{keyHash:'a'.repeat(64)});
  assert.equal(output.findLast(m=>m.id==='a'&&m.op==='info').peerAccess.b.readFrom,2);
  const token=r('a','share',{ranges:[[1,1]]}).result.token;p.join('c','room',{historyToken:token});assert.equal(p.members.get('c').readFrom,2);
  const resume=p.members.get('b').resumeToken;p.leave('b');r('a','sequence');p.join('b2','room',{resumeToken:resume});assert.equal(p.members.get('b2').readFrom,2);
  p.join('d','room',{historyToken:'wrong'});assert.equal(p.members.get('d').readFrom,3);
  assert.equal(r('a','append',{record:'must never be stored'}).error,'unknown_action');
  assert.equal(r('a','sequence',{epoch:'old'}).error,'room_expired');
  assert.equal(p.rooms.get('room').epoch,epoch);assert.ok(!JSON.stringify([...p.rooms.values()]).includes('must never be stored'));
  assert.ok(!output.some(m=>Object.hasOwn(m,'records')));
});
test('sole refresh within grace restores epoch; empty room expires and old invitations lose access',()=>{
  const {presence:p,request:r,expire}=fixture();p.join('a','room');r('a','register',{keyHash:'a'.repeat(64)});
  r('a','sequence');
  const old=p.rooms.get('room'),resume=p.members.get('a').resumeToken,token=r('a','share',{ranges:[[1,1]]}).result.token;
  p.leave('a');p.join('refresh','room',{resumeToken:resume});r('refresh','ready',{keyHash:old.keyHash});expire();assert.equal(p.rooms.get('room'),old);
  p.leave('refresh');expire();assert.equal(p.rooms.has('room'),false);
  p.join('new','room',{historyToken:token});assert.notEqual(p.rooms.get('room').epoch,old.epoch);assert.equal(p.members.get('new').readFrom,1);assert.equal(p.members.get('new').historyExpired,true);
});
test('unkeyed waiting users cannot preserve a room after its last key holder leaves',()=>{
  const {presence:p,request:r,expire}=fixture();p.join('a','room');r('a','register',{keyHash:'a'.repeat(64)});const old=p.rooms.get('room').epoch;
  p.leave('a');p.join('waiting','room');expire();assert.notEqual(p.rooms.get('room').epoch,old);assert.equal(p.rooms.get('room').keyHash,null);assert.equal(p.rooms.get('room').owner,'waiting');
});
test('default scheduler does not bind native timer functions to the presence instance',()=>{
  const originalDelay=global.setTimeout, originalCancel=global.clearTimeout;
  let callback, cancelled=false;
  try {
    global.setTimeout=function(fn){assert.equal(this,globalThis);callback=fn;return 1;};
    global.clearTimeout=function(){assert.equal(this,globalThis);cancelled=true;};
    let n=0;const p=new RoomPresence({uuid:()=>String(++n),send:()=>{}});
    p.join('a','room');p.handle('a',{id:'1',op:'register',keyHash:'a'.repeat(64)});p.leave('a');
    p.join('b','room');p.handle('b',{id:'2',op:'ready',keyHash:'a'.repeat(64)});assert.ok(cancelled);
    p.leave('b');callback();assert.equal(p.rooms.has('room'),false);
  } finally {global.setTimeout=originalDelay;global.clearTimeout=originalCancel;}
});

test('invites freeze sharer ranges, preserve holes on resume, and reject privilege expansion',()=>{
 const {presence:p,request:r}=fixture();p.join('a','room');r('a','register',{keyHash:'a'.repeat(64)});
 for(let i=0;i<10;i++)r('a','sequence');p.join('c','room');r('c','ready',{keyHash:'a'.repeat(64)});
 for(let i=0;i<10;i++)r('a','sequence');
 const a=r('a','share',{ranges:[[1,20]]}).result.token;
 const c=r('c','share',{ranges:[[11,20]]}).result.token;assert.notEqual(a,c);
 assert.equal(r('c','share',{ranges:[[1,20]]}).error,'history_not_allowed');
 r('a','sequence');p.join('d','room',{historyToken:c});
 assert.deepEqual(p.members.get('d').historyRanges,[[11,20]]);assert.equal(p.members.get('d').readFrom,22);
 r('d','ready',{keyHash:'a'.repeat(64)});r('a','sequence');
 assert.equal(r('d','share',{ranges:[[11,22]]}).error,'history_not_allowed');
 const inherited=r('d','share',{ranges:[[11,20],[22,22]]}).result.token;
 p.join('e','room',{historyToken:inherited});assert.deepEqual(p.members.get('e').historyRanges,[[11,20],[22,22]]);
 const resume=p.members.get('d').resumeToken;p.leave('d');p.join('d2','room',{resumeToken:resume});
 assert.deepEqual(p.members.get('d2').historyRanges,[[11,20]]);assert.equal(p.members.get('d2').readFrom,22);
 p.join('f','room',{historyToken:a});assert.deepEqual(p.members.get('f').historyRanges,[[1,20]]);
});
