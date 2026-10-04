import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const admin=readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
const market=readFileSync(new URL('../public/market.html',import.meta.url),'utf8');

test('late admin requests cannot overwrite a newer tab',async()=>{
  const source=admin.slice(admin.indexOf('let navigationEpoch'),admin.indexOf('function toast('));
  let complete;const context=vm.createContext({FormData,fetch:()=>new Promise(resolve=>{complete=resolve;}),showLogin(){throw new Error('must not show an old login response');}});
  vm.runInContext(source,context);
  const pending=context.api('/api/admin/files');
  vm.runInContext('navigationEpoch++',context);complete(Response.json({files:[]}));
  await assert.rejects(pending,/stale_request/);
});

test('late market searches cannot replace a newer result',async()=>{
  const source=market.slice(market.indexOf('let loadEpoch'),market.indexOf('function render(items'));
  const requests=[],rendered=[];
  const context=vm.createContext({state:{page:1,sort:'hot',q:'',total:0},grid:{innerHTML:''},URLSearchParams,totalEl:{},console,
    fetch:()=>new Promise(resolve=>requests.push(resolve)),render:items=>rendered.push(items),renderEmpty(){throw new Error('unexpected empty result');},t:x=>x});
  vm.runInContext(source,context);const old=context.load();context.state.q='new';const next=context.load();
  requests[1](Response.json({ok:true,items:['new'],total:1,page:1,size:12}));await next;
  requests[0](Response.json({ok:true,items:['old'],total:1,page:1,size:12}));await old;
  assert.deepEqual(rendered,[['new']]);
});

function modalFixture(){
  const ids=new Map();let mask;
  class Element {
    set innerHTML(html){for(const m of html.matchAll(/data-(ok|x)/g))ids.set('[data-'+m[1]+']',{});}
    addEventListener(name,fn){this[name]=fn;}remove(){ids.delete('#modal');}
  }
  const context=vm.createContext({document:{createElement:()=>new Element(),body:{appendChild(el){mask=el;ids.set('#modal',el);}}},$:s=>ids.get(s),esc:String,t:x=>x});
  const dialogs=admin.slice(admin.indexOf('const confirmDialog'),admin.indexOf('function toggleLang'));
  const modals=admin.slice(admin.indexOf('let modalCloseHook'),admin.indexOf('/* ═══════════ 登录视图'));
  vm.runInContext(modals+'\n'+dialogs+'\nglobalThis.confirm = confirmDialog;',context);
  return {context,ids,get mask(){return mask;}};
}

test('dismissing a confirmation dialog resolves cancellation instead of leaving actions pending',async()=>{
  const f=modalFixture(),pending=f.context.confirm('Delete','Confirm');
  f.mask.click({target:f.mask});assert.equal(await pending,false);
});

test('accepting a confirmation dialog resolves approval exactly once',async()=>{
  const f=modalFixture(),pending=f.context.confirm('Delete','Confirm');
  f.ids.get('[data-ok]').onclick();assert.equal(await pending,true);
});

test('settings warn on unsaved edits, allow cancellation and clear when changes are reverted',()=>{
  const source=admin.slice(admin.indexOf('let settingsDirty ='),admin.indexOf('/* ═══════════ 设置 ═══════════ */'));
  const fields=new Map([...source.matchAll(/\$\('([^']+)'\)/g)].map(match=>[match[1],{value:'',checked:false,style:{}}]));
  fields.get('#st-title').value='nano-cloud';let leave=false;const events={};
  const context=vm.createContext({LANG:'zh',$:selector=>fields.get(selector),window:{confirm:()=>leave,addEventListener:(name,fn)=>events[name]=fn}});
  vm.runInContext(source+'\nsettingsBaseline = JSON.stringify(settingsFormValues());',context);
  context.updateSettingsDirty();assert.match(fields.get('#settings-save-status').textContent,/已保存/);
  fields.get('#st-github-button').checked=true;context.updateSettingsDirty();assert.match(fields.get('#settings-save-status').textContent,/未保存/);
  assert.equal(context.allowSettingsLeave(),false);
  let prevented=false;events.beforeunload({preventDefault(){prevented=true;}});assert.equal(prevented,true);
  fields.get('#st-github-button').checked=false;context.updateSettingsDirty();assert.equal(context.allowSettingsLeave(),true);
  fields.get('#st-title').value='changed';context.updateSettingsDirty();leave=true;assert.equal(context.allowSettingsLeave(),true);
  prevented=false;events.beforeunload({preventDefault(){prevented=true;}});assert.equal(prevented,false);
});
