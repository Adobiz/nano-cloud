// Run the real share-page script against a small DOM/API harness; no network.
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const html=readFileSync(new URL('../public/share.html',import.meta.url),'utf8');
const script=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).join('\n').replace(/\nboot\(\);\s*$/,'');
new vm.Script(script);
const info={status:'ok',name:'file.txt',size:10,created_at:0,downloads:0,quota_exceeded:false,needs_password:false,
  turnstile:{enabled:false},oauth:{enabled:false},codes_floating_button:{enabled:true,position:'top-right'}};
function fixture(initialCode=null) {
  const ids=new Map(),values=new Map(initialCode?[['r2pan_code',initialCode]]:[]),timers=[];
  class Element {
    constructor(){this.style={};this.dataset={};this.children=[];this.value='';this.hidden=false;this.classes=new Set();this.classList={toggle:(c,v)=>v?this.classes.add(c):this.classes.delete(c)};}
    set innerHTML(value){this.html=value;for(const m of value.matchAll(/id="([^"]+)"/g)){const e=new Element();ids.set(m[1],e);e.parentNode=this;} }
    get innerHTML(){return this.html||'';}
    querySelector(s){return s.startsWith('#')?ids.get(s.slice(1))||null:new Element();}
    appendChild(e){e.parentNode=this;this.children.push(e);return e;}
    addEventListener(){} remove(){this.removed=true;} focus(){} select(){}
  }
  for(const id of ['app','loading-text','lang-toggle','brand-text','code-float','code-float-badge','github-button'])ids.set(id,new Element());
  const body=new Element(); const document={body,head:new Element(),documentElement:{},querySelector:s=>ids.get(s.slice(1))||null,getElementById:id=>ids.get(id)||null,createElement:()=>new Element()};
  const localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const location={href:'https://test.invalid/s/share',pathname:'/s/share',search:'',origin:'https://test.invalid',reload(){}};
  const context=vm.createContext({document,localStorage,location,navigator:{language:'zh-CN'},URL,URLSearchParams,console,
    setTimeout:(fn,ms)=>{timers.push({fn,ms});},alert(){},fetch:async()=>Response.json(info)});
  context.window=context;
  vm.runInContext(script,context);
  return {context,ids,values,timers,localStorage,location,body,
    render(d=info){context.render(d,'nano-cloud','',[]);},
    async timersAt(ms){for(const t of timers.filter(t=>t.ms===ms))await t.fn();await new Promise(resolve=>setImmediate(resolve));},
  };
}

test('share page renders the supplied display name safely and uses its extension',()=>{
  const f=fixture();f.render({...info,name:'指定<名称>.zip'});
  assert.match(f.ids.get('app').innerHTML,/<h1>指定&lt;名称&gt;\.zip<\/h1>/);
  assert.match(f.ids.get('app').innerHTML,/>ZIP<\/span>/);
  assert.doesNotMatch(f.ids.get('app').innerHTML,/file\.txt/);
});

test('share page restores activation-code entry, badge and configured visibility/position',()=>{
  assert.match(html,/id="code-float"/);assert.match(html,/id="code-float-badge"/);
  const f=fixture('R2PAN-TEST'); f.render();
  assert.equal(f.ids.get('code-float').hidden,false);assert.equal(f.ids.get('code-float').classes.has('position-right'),true);
  assert.equal(f.ids.get('code-float-badge').style.display,'block');
  f.render({...info,codes_floating_button:{enabled:false,position:'top-left'}});
  assert.equal(f.ids.get('code-float').hidden,true);assert.equal(f.ids.get('code-float').classes.has('position-right'),false);
});

test('monthly quota gates the normal button while a bound code restores password and download controls',()=>{
  const blocked=fixture();blocked.render({...info,quota_exceeded:true});
  assert.match(blocked.ids.get('app').innerHTML,/pointer-events:none/);
  const allowed=fixture('R2PAN-TEST');allowed.render({...info,quota_exceeded:true});
  assert.doesNotMatch(allowed.ids.get('app').innerHTML,/pointer-events:none/);
  assert.equal(typeof allowed.ids.get('dl').onclick,'function');
  allowed.render({...info,quota_exceeded:true,needs_password:true});
  assert.match(allowed.ids.get('app').innerHTML,/id="pw"/);
  assert.equal(typeof allowed.ids.get('pw-go').onclick,'function');
});

test('binding a usable code refreshes the page and storage failure reports an error',async()=>{
  const f=fixture();f.render({...info,quota_exceeded:true});
  f.context.fetch=async url=>Response.json(url.includes('/status')?{usable:true,status:{remaining:100}}:{...info,quota_exceeded:true});
  f.ids.get('code-float').onclick();f.ids.get('code-input').value='r2pan-test';
  await f.ids.get('code-bind').onclick();assert.equal(f.values.get('r2pan_code'),'R2PAN-TEST');
  await f.timersAt(800);assert.doesNotMatch(f.ids.get('app').innerHTML,/pointer-events:none/);
  f.ids.get('code-float').onclick();
  f.localStorage.setItem=()=>{throw new Error('storage blocked');};
  f.ids.get('code-input').value='another';await f.ids.get('code-bind').onclick();
  assert.match(f.ids.get('code-query-result').textContent,/storage blocked/);
  assert.equal(f.ids.get('code-query-result').className,'code-query-result err');
});

test('password and no-password downloads navigate with the server proof instead of a consumed raw token',async()=>{
  for(const password of [undefined,'password']){
    const f=fixture('R2PAN-TEST');f.context.__tsToken='single-use';let calls=0;
    f.context.fetch=async(url,opts)=>{calls++;const body=JSON.parse(opts.body);assert.equal(body.turnstile,'single-use');assert.equal(body.password,password);return Response.json({url:'/s/share/download?ts=signed-proof'+(password?'&t=password-proof':'')});};
    await f.context.verifiedDownload(info,{sitekey:'test',mode:'both'},true,true,password);
    const url=new URL(f.location.href);assert.equal(url.searchParams.get('ts'),'signed-proof');assert.equal(url.searchParams.has('cf'),false);
    assert.equal(url.searchParams.get('code'),'R2PAN-TEST');assert.equal(f.context.__tsToken,null);assert.equal(calls,1);
  }
});

test('wrong passwords retain the challenge; failed challenge verification clears it for retry',async()=>{
  const f=fixture();f.context.__tsToken='single-use';
  for(const [error,status] of [['bad_password',401],['turnstile_failed',403]]){
    f.context.fetch=async()=>Response.json({error},{status});
    await assert.rejects(f.context.verifiedDownload(info,{sitekey:'test'},true,true,'wrong'),new RegExp(error));
    assert.equal(f.context.__tsToken,error==='bad_password'?'single-use':null);
  }
});

test('invalid saved activation codes are cleared before rendering the quota gate',async()=>{
  const f=fixture('EXPIRED');
  f.context.fetch=async url=>Response.json(url.includes('/status')?{usable:false,status:{status:'expired'}}:{...info,quota_exceeded:true});
  await f.context.boot();assert.equal(f.values.has('r2pan_code'),false);assert.match(f.ids.get('app').innerHTML,/pointer-events:none/);
});

test('missing OAuth providers and Turnstile sitekeys produce explicit configuration messages',()=>{
  const f=fixture();f.render({...info,oauth:{enabled:true,authed:false}});assert.match(f.ids.get('app').innerHTML,/登录服务未配置完整/);
  f.render({...info,turnstile:{enabled:true,sitekey:null}});assert.match(f.ids.get('app').innerHTML,/人机验证未配置完整/);
});

test('all shipped HTML scripts parse as JavaScript',()=>{
  for(const page of ['admin','market','share']) {
    const source=readFileSync(new URL('../public/'+page+'.html',import.meta.url),'utf8');
    for(const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(m[1]);
  }
});

 test('GitHub button follows the setting and defaults to visible',()=>{
  const f=fixture();
  f.render({...info,github_button_enabled:false});assert.equal(f.ids.get('github-button').hidden,true);
  f.render({...info,github_button_enabled:true});assert.equal(f.ids.get('github-button').hidden,false);
  f.render(info);assert.equal(f.ids.get('github-button').hidden,false);
});
