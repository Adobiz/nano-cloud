// Regression checks use real handlers and SQL, in-memory SQLite and fake R2.
// They never connect to Cloudflare or modify an existing database.
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSync } = require('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'nano-cloud-downloads-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
buildSync({
  stdin: { contents: ['db', 'public', 'codes', 'settings', 'download-accounting', 'storage', 'webdav']
    .map(name => `export * from './src/${name}.ts';`).join('\n'), resolveDir: root },
  outfile: join(dir, 'backend.mjs'), bundle: true, format: 'esm', platform: 'node',
  loader: { '.html': 'text', '.svg': 'text', '.geojson': 'text', '.txt': 'text' },
});
let instance = 0;
function database(sqlite) {
  return {
    prepare(sql) {
      let bindings = [];
      const execute = () => {
        const statement = sqlite.prepare(sql);
        const results = /\?[0-9]/.test(sql)
          ? statement.all(Object.fromEntries(bindings.map((value, i) => [String(i + 1), value])))
          : statement.all(...bindings);
        return { results, success: true, meta: { changes: Number(sqlite.prepare('SELECT changes() AS c').get().c) } };
      };
      return {
        bind(...values) { bindings = values; return this; },
        async all() { return execute(); }, async run() { return execute(); },
        async first() { return execute().results[0] || null; }, execute,
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}
async function fixture(settings = {}) {
  // A separate module instance also isolates existing provider/settings caches.
  const api = await import(pathToFileURL(join(dir, 'backend.mjs')) + '?instance=' + ++instance);
  const sqlite = new DatabaseSync(':memory:');
  const db = database(sqlite);
  await api.ensureSchema({ db });
  const objects = new Map([['object', new Uint8Array([1,2,3,4,5,6,7,8,9,10])]]);
  const env = { db, admin:'in-memory-only', r2:{
    async delete(key) { objects.delete(key); },
    async put(key, body) { const bytes = new Uint8Array(await new Response(body).arrayBuffer()); objects.set(key, bytes); return {size:bytes.length,httpEtag:'test'}; },
    async head(key) { const bytes=objects.get(key); return bytes ? {size:bytes.length,httpMetadata:{contentType:'text/plain'}} : null; },
    async get(key, range) {
      const bytes=objects.get(key); if (!bytes) return null;
      const content=range ? bytes.slice(range.offset, range.offset+range.length) : bytes;
      return {body:new ReadableStream({start(c){c.enqueue(content);c.close();}}),size:bytes.length,httpEtag:'"test"',httpMetadata:{contentType:'text/plain'}};
    },
  }};
  for (const [key,value] of Object.entries({traffic_limit_bytes:'0',max_downloads_per_ip:'0',...settings}))
    sqlite.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));
  sqlite.prepare("INSERT INTO files(id,key,name,size,mime,uploaded_at) VALUES('file','object','file.txt',10,'text/plain',?)").run(Date.now());
  sqlite.prepare("INSERT INTO shares(id,file_id,created_at) VALUES('share','file',?)").run(Date.now());
  sqlite.prepare("INSERT INTO direct_links(id,file_id,created_at) VALUES('direct','file',?)").run(Date.now());
  api.invalidateSettingsCache();
  const pending=[];
  return {api,env,sqlite,objects,ctx:{waitUntil(p){pending.push(p);}},
    request(path='/s/share/download',opts){return new Request('https://test.invalid'+path,opts);},
    async settle(){await Promise.all(pending);},
    count(table='shares'){return sqlite.prepare(`SELECT download_count FROM ${table}`).get().download_count;},
    code(total=100,used=0){
      const code='R2PAN-ABCD-EFGH-JKLM';
      sqlite.prepare("INSERT INTO activation_codes(id,code,traffic_bytes,used_bytes,days_valid,status,created_at) VALUES('code',?,?,?,1,'unused',?)").run(code,total,used,Date.now());
      return sqlite.prepare("SELECT * FROM activation_codes WHERE id='code'").get();
    },
    codeRow(){return sqlite.prepare("SELECT * FROM activation_codes WHERE id='code'").get();},
  };
}

test('traffic initializes, accumulates, refreshes cache and resets across months',async()=>{
  const f=await fixture();
  await f.api.getSettings(f.env);
  await f.api.addTraffic(f.env,10); await f.api.addTraffic(f.env,20);
  assert.equal((await f.api.getSettings(f.env)).trafficUsedBytes,30);
  f.sqlite.prepare("UPDATE settings SET value='2000-01' WHERE key='traffic_month'").run();
  await Promise.all(Array.from({length:10},()=>f.api.addTraffic(f.env,10)));
  assert.equal((await f.api.getSettings(f.env)).trafficUsedBytes,100);
  assert.equal(f.sqlite.prepare('SELECT downloads FROM traffic_stats').get().downloads,12);
});

test('quota is deducted before the handler returns and is not charged twice',async()=>{
  const f=await fixture(); const code=f.code();
  const response=await f.api.handleDownload(f.request('/s/share/download?code='+code.code),f.env,f.ctx,'share');
  assert.equal(response.status,200);
  assert.equal(f.codeRow().used_bytes,10); assert.equal(f.codeRow().status,'active');
  assert.equal((await response.arrayBuffer()).byteLength,10);
  await f.settle(); assert.equal(f.codeRow().used_bytes,10);
  assert.equal((await f.api.getSettings(f.env)).trafficUsedBytes,10);
});

test('insufficient quota returns no file and spends no link allowance',async()=>{
  const f=await fixture(); const code=f.code(100,99);
  const response=await f.api.handleDownload(f.request('/s/share/download?code='+code.code),f.env,f.ctx,'share');
  assert.equal(response.status,403);assert.equal(f.codeRow().used_bytes,99);
  assert.equal(f.codeRow().status,'unused');assert.equal(f.count(),0);
});

test('concurrent transactions cannot overspend either quota or link allowance',async()=>{
  const f=await fixture(); const code=f.code(30);
  const results=await Promise.all(Array.from({length:10},()=>f.api.reserveDownload(f.env,'share','share',code,10)));
  assert.equal(results.filter(r=>r.ok).length,3); assert.equal(f.codeRow().used_bytes,30);assert.equal(f.count(),3);
  f.sqlite.prepare("UPDATE activation_codes SET traffic_bytes=100,used_bytes=0,status='unused'").run();
  f.sqlite.prepare('UPDATE shares SET max_downloads=4').run();
  const limited=await Promise.all(Array.from({length:10},()=>f.api.reserveDownload(f.env,'share','share',code,10)));
  assert.equal(limited.filter(r=>r.ok).length,1);assert.equal(f.count(),4);assert.equal(f.codeRow().used_bytes,10);
});

test('password failure, missing objects and invalid ranges never activate or pay',async()=>{
  const f=await fixture(); const code=f.code();const path='/s/share/download?code='+code.code;
  f.sqlite.prepare("UPDATE shares SET password_hash='protected',max_downloads=1").run();
  assert.equal((await f.api.handleDownload(f.request(path),f.env,f.ctx,'share')).status,403);
  f.sqlite.prepare('UPDATE shares SET password_hash=NULL').run();
  assert.equal((await f.api.handleDownload(f.request(path,{headers:{range:'bytes=100-200'}}),f.env,f.ctx,'share')).status,416);
  f.objects.clear();assert.equal((await f.api.handleDownload(f.request(path),f.env,f.ctx,'share')).status,404);
  assert.equal(f.count(),0);assert.equal(f.codeRow().used_bytes,0);assert.equal(f.codeRow().status,'unused');
});

test('HEAD reads metadata without quota, activation, counts or logs',async()=>{
  const f=await fixture();const code=f.code();
  const response=await f.api.handleDownload(f.request('/s/share/download?code='+code.code,{method:'HEAD'}),f.env,f.ctx,'share');
  assert.equal(response.status,200);assert.equal(await response.text(),'');assert.equal(response.headers.get('content-length'),'10');
  assert.equal(f.count(),0);assert.equal(f.codeRow().used_bytes,0);assert.equal(f.codeRow().status,'unused');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS c FROM download_logs').get().c,0);
});

test('Range charges only requested bytes and a direct link uses the same reservation',async()=>{
  const f=await fixture();const code=f.code(13);
  const response=await f.api.handleDownload(f.request('/s/share/download?code='+code.code,{headers:{range:'bytes=2-4'}}),f.env,f.ctx,'share');
  assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,3);assert.equal(f.codeRow().used_bytes,3);
  const direct=await f.api.handleDirectDownload(f.request('/d/direct?code='+code.code),f.env,f.ctx,'direct');
  assert.equal(direct.status,200);assert.equal(f.codeRow().used_bytes,13);assert.equal(f.codeRow().status,'exhausted');
  assert.equal(f.count(),1);assert.equal(f.count('direct_links'),1);await f.settle();
  assert.equal((await f.api.getSettings(f.env)).trafficUsedBytes,13);
});

test('revoked, expired and unknown codes are rejected without spending counts',async()=>{
  const f=await fixture();const code=f.code();const path='/s/share/download?code='+code.code;
  f.sqlite.prepare("UPDATE activation_codes SET status='revoked'").run();
  assert.equal((await f.api.handleDownload(f.request(path),f.env,f.ctx,'share')).status,403);
  f.sqlite.prepare("UPDATE activation_codes SET status='active',expires_at=1").run();
  assert.equal((await f.api.handleDownload(f.request(path),f.env,f.ctx,'share')).status,403);
  assert.equal((await f.api.handleDownload(f.request('/s/share/download?code=bad'),f.env,f.ctx,'share')).status,403);
  assert.equal(f.count(),0);assert.equal(f.codeRow().used_bytes,0);
});

test('unlimited quota accumulates atomically and invalid amounts cannot credit balance',async()=>{
  const f=await fixture();const code=f.code(0);
  const results=await Promise.all(Array.from({length:10},()=>f.api.deductQuota(f.env,code,10)));
  assert(results.every(r=>r.ok));assert.equal(f.codeRow().used_bytes,100);
  await assert.rejects(f.api.deductQuota(f.env,code,-10),/Invalid quota byte count/);
  assert.equal(f.codeRow().used_bytes,100);
});


test('concurrent real downloads return only the bodies covered by available quota',async()=>{
  const f=await fixture();const code=f.code(30);
  const responses=await Promise.all(Array.from({length:10},()=>f.api.handleDownload(f.request('/s/share/download?code='+code.code),f.env,f.ctx,'share')));
  assert.equal(responses.filter(r=>r.status===200).length,3);
  assert.equal(responses.filter(r=>r.status===403).length,7);
  assert.equal(f.codeRow().used_bytes,30);assert.equal(f.count(),3);
  await f.settle();assert.equal((await f.api.getSettings(f.env)).trafficUsedBytes,30);
});

test('download logs use Cloudflare country metadata when the header is absent',async()=>{
  const f=await fixture();const request=f.request();Object.defineProperty(request,'cf',{value:{country:'CN'}});
  const response=await f.api.handleDownload(request,f.env,f.ctx,'share');assert.equal(response.status,200);
  await f.settle();assert.equal(f.sqlite.prepare('SELECT country FROM download_logs').get().country,'CN');
});


test('password and Turnstile both mode spend a challenge once and bind the proof to IP', async()=>{
  const f=await fixture({turnstile_mode:'both'});
  f.env.turnstile_secret='test-secret';
  f.sqlite.prepare("UPDATE shares SET password_hash=?").run(await f.api.hashPassword('password'));
  const original=globalThis.fetch; let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({success:calls===1});};
  const headers={'content-type':'application/json','cf-connecting-ip':'192.0.2.1'};
  try {
    let r=await f.api.handleVerify(f.request('/s/share/verify',{method:'POST',headers,body:JSON.stringify({password:'wrong',turnstile:'single'})}),f.env,'share');
    assert.equal(r.status,401); assert.equal(calls,0);
    r=await f.api.handleVerify(f.request('/s/share/verify',{method:'POST',headers,body:JSON.stringify({password:'password',turnstile:'single'})}),f.env,'share');
    const result=await r.json(); assert.equal(r.status,200); assert.match(result.url,/ts=/);
    assert.equal((await f.api.handleDownload(f.request(result.url,{headers}),f.env,f.ctx,'share')).status,200);
    assert.equal(calls,1); await f.settle();
    assert.equal((await f.api.handleDownload(f.request(result.url,{headers:{'cf-connecting-ip':'192.0.2.2'}}),f.env,f.ctx,'share')).status,403);
    const changed=new URL(result.url,'https://test.invalid'); changed.searchParams.set('ts',changed.searchParams.get('ts')+'0');
    assert.equal((await f.api.handleDownload(new Request(changed,{headers}),f.env,f.ctx,'share')).status,403);
  } finally {globalThis.fetch=original;}
});

test('on_share threshold is enforced on downloads and grants a signed proof', async()=>{
  const f=await fixture({turnstile_mode:'on_share',turnstile_threshold:'0'}); f.env.turnstile_secret='secret';
  await f.api.handleShareInfo(f.request('/s/share/info'),f.env,'share');
  assert.equal((await f.api.handleDownload(f.request(),f.env,f.ctx,'share')).status,403);
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>Response.json({success:true});
    const r=await f.api.handleVerify(f.request('/s/share/verify',{method:'POST',body:JSON.stringify({turnstile:'single'})}),f.env,'share');
    assert.equal((await f.api.handleDownload(f.request((await r.json()).url),f.env,f.ctx,'share')).status,200); await f.settle();
  } finally {globalThis.fetch=original;}
});

async function davFixture(root='/safe') {
  const f=await fixture({webdav_enabled:'1',webdav_username:'tester',webdav_root_path:root});
  f.sqlite.prepare("INSERT INTO settings(key,value) VALUES('webdav_password_hash',?)").run(await f.api.hashPassword('password'));
  f.api.invalidateSettingsCache();
  f.sqlite.prepare("UPDATE files SET path='/safe/file.txt'").run();
  for(const path of ['/safe','/safe/sub','/safe/sub/nested']) f.sqlite.prepare('INSERT INTO directories(path,created_at) VALUES(?,?)').run(path,Date.now());
  f.dav=async(method,path,extra={})=>f.api.handleWebDAV(f.request('/webdav'+path,{method,headers:{authorization:'Basic '+btoa('tester:password'),...extra}}),f.env,f.ctx);
  return f;
}

test('WebDAV DELETE returns an empty 204 and removes share/direct links',async()=>{
  const f=await davFixture(); const r=await f.dav('DELETE','/safe/file.txt');
  assert.equal(r.status,204); assert.equal(r.body,null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM direct_links').get().n,0);
  assert.equal(f.objects.has('object'),false);
});

test('WebDAV blocks siblings, traversal, foreign/malformed destinations and overlapping paths without deleting the source',async()=>{
  const f=await davFixture();
  for(const path of ['/safe-other/file.txt','/safe%2F..%2Foutside/file.txt']) assert.equal((await f.dav('GET',path)).status,403);
  assert.equal((await f.dav('GET','/safe/%ZZ')).status,400);
  for(const method of ['MOVE','COPY']) {
    for(const destination of ['https://other.invalid/webdav/safe/new.txt','https://test.invalid/other/safe/new.txt','https://test.invalid/webdav/outside/new.txt','https://test.invalid/webdav/safe/file.txt','https://test.invalid/webdav/safe','https://test.invalid/webdav/safe%2F..%2Foutside/new.txt']) {
      const r=await f.dav(method,'/safe/file.txt',{destination}); assert.ok([400,403].includes(r.status),destination+' '+r.status);
      assert.equal(f.objects.has('object'),true); assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get().n,1);
    }
  }
  assert.equal((await f.dav('MOVE','/safe/sub',{destination:'https://test.invalid/webdav/safe/sub/new'})).status,403);
});

test('WebDAV MOVE can overwrite another file with a null 204 response',async()=>{
  const f=await davFixture(); f.objects.set('other',new Uint8Array([9]));
  f.sqlite.prepare("INSERT INTO files(id,key,name,size,mime,path,uploaded_at) VALUES('other','other','other.txt',1,'text/plain','/safe/other.txt',?)").run(Date.now());
  const r=await f.dav('MOVE','/safe/file.txt',{destination:'https://test.invalid/webdav/safe/other.txt'});
  assert.equal(r.status,204); assert.equal(r.body,null);
  assert.equal(f.sqlite.prepare("SELECT path FROM files WHERE id='file'").get().path,'/safe/other.txt');
  assert.equal(f.objects.has('object'),true); assert.equal(f.objects.has('other'),false);
});

test('WebDAV literal directory prefixes cannot delete matching SQL wildcard siblings',async()=>{
  const f=await davFixture('/');
  for(const path of ['/a_b','/axb','/a_b/empty']) f.sqlite.prepare('INSERT INTO directories(path,created_at) VALUES(?,?)').run(path,Date.now());
  f.sqlite.prepare("UPDATE files SET path='/axb/file.txt'").run();
  assert.equal((await f.dav('DELETE','/a_b')).status,204);
  assert.equal(f.objects.has('object'),true);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM directories WHERE path='/a_b/empty'").get().n,0);
});

test('an activation code can download when the monthly global quota is exhausted',async()=>{
  const f=await fixture({traffic_limit_bytes:'1',traffic_used_bytes:'2',traffic_month:new Date().toISOString().slice(0,7)});
  assert.equal((await f.api.handleDownload(f.request(),f.env,f.ctx,'share')).status,503);
  const code=f.code(100);
  assert.equal((await f.api.handleDownload(f.request('/s/share/download?code='+code.code),f.env,f.ctx,'share')).status,200);
  assert.equal(f.codeRow().used_bytes,10); await f.settle();
});

test('S3 uses a valid SigV4 signature for binary slices, virtual hosts, Range and encoded queries',async()=>{
  const {createHash,createHmac}=await import('node:crypto');
  const f=await fixture(); const original=globalThis.fetch; const requests=[];
  const cfg={endpoint:'http://storage.test:9000/base',region:'us-east-1',bucket:'bucket',accessKeyId:'testing',secretAccessKey:'test-secret',addressingStyle:'virtual',pathPrefix:'prefix'};
  const hash=data=>createHash('sha256').update(data).digest('hex');
  const hmac=(key,data)=>createHmac('sha256',key).update(data).digest();
  const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  globalThis.fetch=async(url,opts)=>{
    const u=new URL(url),headers=new Headers(opts.headers),date=headers.get('x-amz-date');
    assert.match(date,/^\d{8}T\d{6}Z$/);
    assert.equal(headers.get('host'),u.host);
    const auth=headers.get('authorization');
    const scope=auth.match(/Credential=testing\/([^,]+)/)[1];
    assert.equal(scope,date.slice(0,8)+'/us-east-1/s3/aws4_request');
    const names=auth.match(/SignedHeaders=([^,]+)/)[1].split(';');
    const query=[...u.searchParams].map(([k,v])=>[encode(k),encode(v)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0).map(([k,v])=>k+'='+v).join('&');
    const canonical=[opts.method,u.pathname,query,names.map(k=>k+':'+headers.get(k).trim().replace(/\s+/g,' ')+'\n').join(''),names.join(';'),headers.get('x-amz-content-sha256')].join('\n');
    const kDate=hmac('AWS4'+cfg.secretAccessKey,date.slice(0,8));
    const signing=hmac(hmac(hmac(kDate,cfg.region),'s3'),'aws4_request');
    const expected=hmac(signing,'AWS4-HMAC-SHA256\n'+date+'\n'+scope+'\n'+hash(canonical)).toString('hex');
    assert.equal(auth.match(/Signature=(\w+)/)[1],expected);
    if(opts.body) assert.equal(headers.get('x-amz-content-sha256'),hash(new Uint8Array(opts.body)));
    requests.push({url:u,headers,opts});
    if(opts.method==='HEAD') return new Response(null,{headers:{'content-length':'3'}});
    if(u.search) return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
    return new Response(new Uint8Array([255,0,128]),{headers:{'content-length':'3'}});
  };
  try {
    const p=f.api.createS3Provider(cfg),slice=new Uint8Array([9,255,0,128,8]).subarray(1,4);
    await p.put('folder/二 !.bin',slice,{contentType:'application/octet-stream',contentDisposition:'attachment; filename="a.bin"'});
    assert.deepEqual([...new Uint8Array(requests[0].opts.body)],[255,0,128]);
    assert.equal(requests[0].url.host,'bucket.storage.test:9000');
    assert.match(requests[0].url.pathname,/^\/base\/prefix\/folder\//);
    await p.get('folder/二 !.bin',{offset:0,length:3}); assert.equal(requests[1].headers.get('range'),'bytes=0-2');
    await p.list({prefix:'a !/中文',marker:'token+ /'});
    await p.head('file');
    await f.api.createS3Provider({...cfg,addressingStyle:'path'}).head('file');
    assert.equal(requests.at(-1).url.pathname,'/base/prefix/bucket/file');
  } finally {globalThis.fetch=original;}
});

test('WebDAV configured roots containing percent signs remain literal',async()=>{
  const f=await davFixture('/100%');
  f.sqlite.prepare("UPDATE files SET path='/100%/file.txt'").run();
  const r=await f.dav('HEAD','/100%25/file.txt');assert.equal(r.status,200);
  assert.equal((await f.dav('HEAD','/100x/file.txt')).status,403);
});

test('WebDAV PUT overwrite and directory deletion return empty 204 responses',async()=>{
  const f=await davFixture();
  const r=await f.api.handleWebDAV(f.request('/webdav/safe/file.txt',{method:'PUT',headers:{authorization:'Basic '+btoa('tester:password')},body:new Uint8Array([3,2,1])}),f.env,f.ctx);
  assert.equal(r.status,204);assert.equal(r.body,null);assert.equal(f.objects.has('object'),false);
  assert.equal(f.sqlite.prepare('SELECT size FROM files').get().size,3);
  assert.equal((await f.dav('DELETE','/safe/sub')).status,204);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM directories WHERE path='/safe/sub/nested'").get().n,0);
});

test('WebDAV COPY to a separate permitted path preserves the source and copies its content',async()=>{
  const f=await davFixture();
  const r=await f.dav('COPY','/safe/file.txt',{destination:'https://test.invalid/webdav/safe/copied.txt'});
  assert.equal(r.status,201); assert.equal(f.objects.has('object'),true);
  const row=f.sqlite.prepare("SELECT * FROM files WHERE path='/safe/copied.txt'").get();
  assert.equal(row.size,10);assert.deepEqual([...f.objects.get(row.key)],[1,2,3,4,5,6,7,8,9,10]);
});
