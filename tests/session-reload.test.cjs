const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {runInNewContext}=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=readFileSync('client/js/util.session.js','utf8').replaceAll('export ', '');
function session(type, handoff, resumeURL) {
 const entries=new Map([
  ['whisper-tab-vault-v1',JSON.stringify({id:'existing-tab',keys:{},resumeOnReload:handoff,resumeURL})],
  ['whisper-session-v1',JSON.stringify({rooms:[{userName:'Alice',roomName:'room',password:''}],active:0})]
 ]);
 return runInNewContext(source+';({beginSession,readSession,discardSession});',{
  location:{href:'https://example.test/?r=room'},crypto:webcrypto,performance:{getEntriesByType:()=>[{type}]},
  sessionStorage:{getItem:k=>entries.get(k)||null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)}
 });
}
test('reload restores identity even if pagehide did not mark a handoff',()=>{
 const s=session('reload',false);assert.equal(s.beginSession(),'existing-tab');assert.equal(s.readSession().rooms[0].userName,'Alice');
});
test('opening the URL normally does not restore an abandoned session',()=>{
 const s=session('navigate',true);assert.notEqual(s.beginSession(),'existing-tab');assert.equal(s.readSession(),null);
});
test('back/forward navigation does not restore old credentials',()=>{
 const s=session('back_forward',true);assert.notEqual(s.beginSession(),'existing-tab');assert.equal(s.readSession(),null);
});
test('explicit discard still revokes the credentials',()=>{
 const s=session('reload',false);s.beginSession();s.discardSession();assert.equal(s.readSession(),null);
});

test('same-URL handoff resumes address-bar navigation',()=>{
 const s=session('navigate',true,'https://example.test/?r=room');assert.equal(s.beginSession(),'existing-tab');assert.equal(s.readSession().rooms[0].userName,'Alice');
});
test('handoff cannot resume a different URL or a history traversal',()=>{
 for(const [type,url] of [['navigate','https://example.test/?r=other'],['back_forward','https://example.test/?r=room']]) {
  const s=session(type,true,url);assert.notEqual(s.beginSession(),'existing-tab');assert.equal(s.readSession(),null);
 }
});
