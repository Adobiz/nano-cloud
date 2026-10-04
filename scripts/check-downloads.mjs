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
  stdin: { contents: ['db', 'public', 'codes', 'settings', 'download-accounting', 'storage', 'webdav', 'oauth', 'oauth_handlers', 'auth', 'admin', 'range', 'crypto']
    .map(name => `export * from './src/${name}.ts';`).join('\n') + "\nexport {default as worker} from './src/index.ts';", resolveDir: root },
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

test('share-page name matches the download filename, with original-name fallback',async()=>{
  const f=await fixture();
  for (const customName of ['指定的名称.zip', null]) {
    f.sqlite.prepare('UPDATE shares SET download_name=?').run(customName);
    const expected=customName || 'file.txt';
    const info=await f.api.handleShareInfo(f.request('/s/share/info'),f.env,'share');
    assert.equal((await info.json()).name,expected);
    const download=await f.api.handleDownload(f.request('/s/share/download',{method:'HEAD'}),f.env,f.ctx,'share');
    assert.equal(download.status,200);
    assert.equal(download.headers.get('content-disposition'),`attachment; filename*=UTF-8''${encodeURIComponent(expected)}`);
  }
  assert.equal(f.sqlite.prepare('SELECT name FROM files').get().name,'file.txt');
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
    return new Response(new Uint8Array([255,0,128]),{status:headers.has('range')?206:200,headers:{'content-length':'3',...(headers.has('range')?{'content-range':'bytes 0-2/3'}:{})}});
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

test('concurrent normal downloads cannot exceed monthly quota and record usage before return',async()=>{
  const f=await fixture({traffic_limit_bytes:'15'});
  const responses=await Promise.all(Array.from({length:6},()=>f.api.handleDownload(f.request(),f.env,f.ctx,'share')));
  assert.equal(responses.filter(r=>r.status===200).length,1);
  assert.equal(responses.filter(r=>r.status===503).length,5);
  assert.equal(f.count(),1);assert.equal((await f.api.getSettings(f.env)).trafficUsedBytes,10);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM download_logs').get().n,1);
  await f.settle();assert.equal((await f.api.getSettings(f.env)).trafficUsedBytes,10);
});

test('concurrent normal downloads cannot bypass the IP download count',async()=>{
  const f=await fixture({max_downloads_per_ip:'1',auto_ban:'0'});
  const responses=await Promise.all(Array.from({length:6},()=>f.api.handleDownload(f.request(),f.env,f.ctx,'share')));
  assert.equal(responses.filter(r=>r.status===200).length,1);
  assert.equal(responses.filter(r=>r.status===403).length,5);
  assert.equal(f.count(),1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM download_logs').get().n,1);await f.settle();
});

test('storage changes apply to public and DAV reads without reloading the Worker',async()=>{
  const f=await davFixture();const first=await f.api.handleDownload(f.request(),f.env,f.ctx,'share');assert.equal(first.status,200);await first.arrayBuffer();
  assert.equal((await f.dav('HEAD','/safe/file.txt')).status,200);
  await f.api.updateSettings(f.env,{storage_provider:'s3',s3_endpoint:'https://storage.test',s3_bucket:'bucket',s3_access_key_id:'testing',s3_secret_key_cipher:await f.api.encryptSecret('secret',f.env.admin)});
  const original=globalThis.fetch;let reads=0;
  globalThis.fetch=async()=>{reads++;return new Response(new Uint8Array([5,4,3]),{headers:{'content-length':'3'}});};
  try {
    const next=await f.api.handleDownload(f.request(),f.env,f.ctx,'share');assert.equal(next.status,200);assert.deepEqual([...new Uint8Array(await next.arrayBuffer())],[5,4,3]);
    assert.equal((await f.dav('HEAD','/safe/file.txt')).status,200);assert.equal(reads,2);await f.settle();
    await f.api.updateSettings(f.env,{s3_secret_key_cipher:''});
    await assert.rejects(f.api.createStorageProvider(f.env,await f.api.getSettings(f.env)),/secret/);
  } finally {globalThis.fetch=original;}
});

test('S3 streaming upload records HEAD size and listing decodes XML/continuation tokens',async()=>{
  const f=await fixture();const p=f.api.createS3Provider({endpoint:'https://storage.test',region:'auto',bucket:'bucket',accessKeyId:'key',secretAccessKey:'secret'});
  const original=globalThis.fetch;const urls=[];
  globalThis.fetch=async(url,opts)=>{
    urls.push(new URL(url));
    if(opts.method==='HEAD')return new Response(null,{headers:{'content-length':'10'}});
    if(opts.method==='PUT')return new Response(null,{status:200});
    return new Response('<ListBucketResult><Contents><Key>a&amp;b.txt</Key><Size>10</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>abc&amp;+</NextContinuationToken></ListBucketResult>');
  };
  try {
    assert.equal((await p.put('file',new ReadableStream({start(c){c.enqueue(new Uint8Array(10));c.close();}}),{})).size,10);
    const page=await p.list({marker:'opaque+/='});assert.equal(page.entries[0].key,'a&b.txt');assert.equal(page.nextMarker,'abc&+');
    assert.equal(urls.at(-1).searchParams.get('continuation-token'),'opaque+/=');assert.equal(urls.at(-1).searchParams.has('start-after'),false);
  } finally {globalThis.fetch=original;}
});

test('remote storage refusing a range fails before any quota or allowance is spent',async()=>{
  const f=await fixture();await f.api.updateSettings(f.env,{storage_provider:'s3',s3_endpoint:'https://storage.test',s3_bucket:'bucket',s3_access_key_id:'key',s3_secret_key_cipher:await f.api.encryptSecret('secret',f.env.admin)});
  const code=f.code();const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(new Uint8Array(10),{headers:{'content-length':'10'}});
  const originalError=console.error;console.error=()=>{};
  try {
    const r=await f.api.handleDownload(f.request('/s/share/download?code='+code.code,{headers:{range:'bytes=0-2'}}),f.env,f.ctx,'share');
    assert.equal(r.status,502);assert.equal(f.codeRow().used_bytes,0);assert.equal(f.count(),0);
  } finally {globalThis.fetch=original;console.error=originalError;}
});

test('DAV PROPFIND handles legacy admin paths, empty subdirectories, URI encoding and file namespace',async()=>{
  const f=await davFixture();f.sqlite.prepare("UPDATE files SET name='报告 &.txt',path='/safe'").run();
  const r=await f.dav('PROPFIND','/safe',{depth:'infinity'});assert.equal(r.status,207);
  const xml=await r.text();assert.match(xml,/xmlns="DAV:"/);assert.match(xml,/%E6%8A%A5%E5%91%8A%20%26\.txt<\/href>/);assert.match(xml,/\/safe\/sub\/nested\//);
  assert.equal((xml.match(/报告 &amp;\.txt/g)||[]).length,1);
  const file=await f.dav('PROPFIND','/safe/'+encodeURIComponent('报告 &.txt'),{depth:'0'});assert.equal(file.status,207);assert.doesNotMatch(await file.text(),/<collection\/>/);
  assert.equal((await f.dav('GET','/safe/'+encodeURIComponent('报告 &.txt'))).status,200);
  assert.equal((await f.dav('PROPFIND','/safe',{depth:'invalid'})).status,400);
});

test('DAV directory MOVE and DELETE include files stored with a parent-directory path',async()=>{
  const f=await davFixture();f.sqlite.prepare("UPDATE files SET path='/safe/sub'").run();
  assert.equal((await f.dav('MOVE','/safe/sub',{destination:'https://test.invalid/webdav/safe/moved'})).status,201);
  assert.equal(f.sqlite.prepare("SELECT path FROM files WHERE id='file'").get().path,'/safe/moved/file.txt');
  assert.equal((await f.dav('DELETE','/safe/moved')).status,204);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get().n,0);
});

test('DAV suffix ranges clamp to file length and malformed ranges return 416',async()=>{
  const f=await davFixture();
  const r=await f.dav('GET','/safe/file.txt',{range:'bytes=-100'});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 0-9/10');assert.equal((await r.arrayBuffer()).byteLength,10);
  for(const range of ['bytes=-0','bytes=-','bytes=20-','bytes=5-2','garbage','bytes=9007199254740992-']) assert.equal((await f.dav('GET','/safe/file.txt',{range})).status,416,range);
});

test('failed DAV overwrite transactions preserve the previous file and remove the staged upload',async()=>{
  const f=await davFixture();const batch=f.env.db.batch;
  f.env.db.batch=async statements=>{throw new Error('simulated write failure');};
  const r=await f.api.handleWebDAV(f.request('/webdav/safe/file.txt',{method:'PUT',headers:{authorization:'Basic '+btoa('tester:password')},body:new Uint8Array([9])}),f.env,f.ctx);
  assert.equal(r.status,502);assert.equal(f.objects.size,1);assert.equal(f.objects.has('object'),true);
  assert.equal(f.sqlite.prepare('SELECT key FROM files').get().key,'object');f.env.db.batch=batch;
});

async function adminCall(f,path,opts={}){
  const cookie=(await f.api.createSession(f.env)).split(';')[0];
  return f.api.handleAdminApi(f.request(path,{...opts,headers:{cookie,'content-type':'application/json',...opts.headers}}),f.env,f.ctx,path.split('?')[0]);
}

test('share cleanup protects direct-only files, respects unlimited shares and chunks orphan deletes',async()=>{
  const f=await fixture();f.sqlite.prepare("UPDATE shares SET revoked=1").run();
  for(let i=0;i<150;i++)f.sqlite.prepare('INSERT INTO files(id,key,name,size,mime,uploaded_at) VALUES(?,?,?,?,?,?)').run('orphan'+i,'missing'+i,'orphan'+i,0,'text/plain',Date.now());
  const prepare=f.env.db.prepare;f.env.db.prepare=sql=>{const statement=prepare(sql),bind=statement.bind;statement.bind=function(...values){assert.ok(values.length<=100,'D1 bound parameter limit');return bind.apply(this,values);};return statement;};
  const r=await adminCall(f,'/api/admin/shares/cleanup',{method:'POST'});assert.equal(r.status,200);
  assert.equal((await r.json()).deleted_orphan_files,150);await f.settle();assert.equal(f.objects.has('object'),true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get().n,1);
  f.sqlite.prepare("INSERT INTO shares(id,file_id,created_at,max_downloads) VALUES('unlimited','file',?,0)").run(Date.now());
  assert.equal((await adminCall(f,'/api/admin/shares/cleanup',{method:'POST'})).status,200);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM shares WHERE id='unlimited'").get().n,1);
});

test('admin file deletion clears direct links and malformed JSON produces a controlled error',async()=>{
  const f=await fixture();
  assert.equal((await adminCall(f,'/api/admin/login',{method:'POST',body:'null'})).status,401);
  assert.equal((await adminCall(f,'/api/admin/login',{method:'POST',body:JSON.stringify({key:123})})).status,401);
  assert.equal((await adminCall(f,'/api/admin/files/file',{method:'DELETE'})).status,200);await f.settle();
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM direct_links').get().n,0);assert.equal(f.objects.has('object'),false);
});

test('market view counts persist and malformed pagination never reaches SQLite as Infinity/fractions',async()=>{
  const f=await fixture();f.sqlite.prepare('UPDATE shares SET is_market=1').run();
  await f.api.handleShareInfo(f.request('/s/share/info'),f.env,'share');assert.equal(f.sqlite.prepare('SELECT market_views FROM shares').get().market_views,1);
  const r=await f.api.worker.fetch(f.request('/api/market?page=Infinity&size=6.5'),f.env,f.ctx);assert.equal(r.status,200);
  const data=await r.json();assert.equal(data.page,1);assert.equal(data.size,6);assert.equal(data.items.length,1);
});

async function oauthFixture(){
  const f=await fixture({oauth_enabled:'1'});
  f.sqlite.prepare("INSERT INTO oauth_providers(id,label,provider_type,client_id,client_secret_cipher,enabled,created_at,updated_at) VALUES('provider','GitHub','github','client',?,1,?,?)").run(await f.api.encryptSecret('secret',f.env.admin),Date.now(),Date.now());
  return f;
}

test('OAuth state is consumed atomically and sessions last one hour with arbitrary user IDs',async()=>{
  const f=await oauthFixture();const state=await f.api.createOAuthState(f.env,'provider','https://test.invalid/oauth/callback');
  const results=await Promise.all([f.api.verifyOAuthState(f.env,state),f.api.verifyOAuthState(f.env,state)]);assert.equal(results.filter(r=>r.ok).length,1);
  const session=await f.api.signOAuthSession(f.env,'provider','user.name@域名');assert.ok(session.expiresAt-Date.now()<=3600000);
  assert.equal((await f.api.verifyOAuthSession(f.env,session.cookie)).userId,'user.name@域名');
  assert.equal((await f.api.verifyOAuthSession(f.env,'fake_'+session.cookie)).ok,false);
  f.sqlite.prepare('UPDATE oauth_providers SET enabled=0').run();assert.equal((await f.api.verifyOAuthSession(f.env,session.cookie)).ok,false);
});

test('OAuth callbacks bind state to the browser, restrict redirects and append separate cookies',async()=>{
  const f=await oauthFixture();
  const start=await f.api.handleOAuthStart(f.request('/oauth/start?provider=provider&redirect='+encodeURIComponent('//evil.test/')),f.env);
  const state=new URL(start.headers.get('location')).searchParams.get('state');const cookies=start.headers.getSetCookie();
  assert.equal(cookies.length,2);assert.match(cookies[0],/cd_oauth_redirect=%2F;/);
  const callback='/oauth/callback?code=code&state='+state;
  const unbound=await f.api.handleOAuthCallback(f.request(callback),f.env);assert.match(unbound.headers.get('location'),/oauth_state_invalid/);
  const original=globalThis.fetch;
  globalThis.fetch=async url=>Response.json(String(url).includes('/access_token')?{access_token:'token'}:{id:'user.name'});
  try {
    const r=await f.api.handleOAuthCallback(f.request(callback,{headers:{cookie:cookies.map(c=>c.split(';')[0]).join('; ')}}),f.env);
    assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/');assert.equal(r.headers.getSetCookie().length,3);
    assert.equal((await f.api.verifyOAuthSession(f.env,r.headers.getSetCookie()[0])).ok,true);
    const error=await f.api.handleOAuthCallback(f.request('/oauth/callback?error=denied',{headers:{cookie:'cd_oauth_redirect=%ZZ'}}),f.env);assert.equal(error.status,302);
  } finally {globalThis.fetch=original;}
});

test('OAuth download login uses the enabled provider database ID',async()=>{
  const f=await oauthFixture();const r=await f.api.handleDownload(f.request(),f.env,f.ctx,'share');assert.equal(r.status,401);assert.match(await r.text(),/provider=provider/);
});

test('settings and schema caches do not leak across database bindings',async()=>{
  const f=await fixture({site_title:'First'});await f.api.getSettings(f.env);
  const sqlite=new DatabaseSync(':memory:');const env={...f.env,db:database(sqlite)};await f.api.ensureSchema(env);
  await f.api.updateSettings(env,{site_title:'Second'});assert.equal((await f.api.getSettings(env)).siteTitle,'Second');assert.equal((await f.api.getSettings(f.env)).siteTitle,'First');
});

test('remote DAV decodes names, authenticates UTF-8 credentials, paginates and reports deletion failures',async()=>{
  const f=await fixture();const provider=f.api.createWebDAVProvider({url:'https://dav.test/root',username:'用户',password:'密码'});
  const original=globalThis.fetch;let requestHeaders;
  const xml='<D:multistatus xmlns:D="DAV:">'+['/root/','/root/%E4%B8%AD%20%26.txt','/root/z.txt'].map(href=>`<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:getcontentlength>10</D:getcontentlength><D:resourcetype/></D:prop></D:propstat></D:response>`).join('')+'</D:multistatus>';
  globalThis.fetch=async(url,opts)=>{requestHeaders=new Headers(opts.headers);if(opts.method==='DELETE')return new Response('Denied',{status:500});return new Response(xml,{status:207});};
  try {
    const first=await provider.list({limit:1});assert.equal(first.truncated,true);assert.equal(first.nextMarker,'z.txt');
    const next=await provider.list({limit:1,marker:first.nextMarker});assert.equal(next.entries[0].key,'中 &.txt');assert.equal(next.truncated,false);
    const raw=requestHeaders.get('authorization').slice(6);assert.equal(Buffer.from(raw,'base64').toString('utf8'),'用户:密码');
    await assert.rejects(provider.delete('file'),/500/);await assert.rejects(provider.delete('../outside'),/Invalid WebDAV/);
  } finally {globalThis.fetch=original;}
});

test('failed storage deletion preserves metadata and surfaces an error',async()=>{
  const f=await fixture();f.env.r2.delete=async()=>{throw new Error('storage unavailable');};
  const original=console.error;console.error=()=>{};
  try {
    const r=await adminCall(f,'/api/admin/files/file',{method:'DELETE'});assert.equal(r.status,500);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get().n,1);
    f.sqlite.prepare('DELETE FROM shares').run();f.sqlite.prepare('DELETE FROM direct_links').run();
    assert.equal((await adminCall(f,'/api/admin/shares/cleanup',{method:'POST'})).status,502);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM files').get().n,1);
  } finally {console.error=original;}
});

test('schema migrations do not mark failed migrations complete, retry successfully and repair missing indexes',async()=>{
  const f=await fixture();const sqlite=new DatabaseSync(':memory:');const db=database(sqlite),env={...f.env,db};
  const prepare=db.prepare;let fail=true;
  db.prepare=sql=>{if(fail && sql==='ALTER TABLE files ADD COLUMN path TEXT NOT NULL DEFAULT \'/\'')return {async run(){throw new Error('simulated D1 outage');}};return prepare(sql);};
  await assert.rejects(f.api.ensureSchema(env),/simulated D1/);
  assert.ok(Number(sqlite.prepare("SELECT value FROM settings WHERE key='migration_version'").get().value)<11);
  fail=false;await f.api.ensureSchema(env);assert.ok(sqlite.prepare('PRAGMA table_info(files)').all().some(c=>c.name==='path'));
  sqlite.exec('DROP INDEX idx_files_path');const result=await f.api.repairDatabase(env);assert.equal(result.ok,true);assert.ok(result.indexesCreated.includes('idx_files_path'));
});

test('a D1 recovery code can only reset 2FA once under concurrent login requests',async()=>{
  const f=await fixture({totp_enabled:'1',totp_secret_cipher:'',totp_recovery_hash:await (await fixture()).api.sha256Hex('RECOVERY-CODE')});
  await f.api.updateSettings(f.env,{totp_secret_cipher:await f.api.encryptSecret(f.api.totpGenerateSecret(),f.env.admin)});
  const results=await Promise.all(Array.from({length:2},()=>adminCall(f,'/api/admin/login',{method:'POST',body:JSON.stringify({key:f.env.admin,code:'RECOVERY-CODE'})})));
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===401).length,1);await f.settle();
});

test('storage connectivity tests reject missing configuration and failed read-back while cleaning the test object',async()=>{
  const f=await fixture();
  assert.equal((await adminCall(f,'/api/admin/storage/test',{method:'POST',body:JSON.stringify({provider:'s3'})})).status,400);
  const original=globalThis.fetch;let deletes=0;
  globalThis.fetch=async(url,opts)=>{if(opts.method==='DELETE')deletes++;return new Response(opts.method==='GET'?'wrong':null,{headers:{'content-length':'5'}});};
  try {
    const r=await adminCall(f,'/api/admin/storage/test',{method:'POST',body:JSON.stringify({provider:'s3',endpoint:'https://storage.test',bucket:'bucket',access_key_id:'key',secret_key:'secret'})});
    assert.equal(r.status,502);assert.equal(deletes,1);
  } finally {globalThis.fetch=original;}
});

test('file counters include direct downloads and stale sizes are refreshed from storage',async()=>{
  const f=await fixture();f.sqlite.prepare("UPDATE files SET size=0").run();
  const r=await f.api.handleDirectDownload(f.request('/d/direct'),f.env,f.ctx,'direct');assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),'10');
  assert.equal(f.sqlite.prepare('SELECT size FROM files').get().size,10);
  const files=await (await adminCall(f,'/api/admin/files')).json();assert.equal(files.files[0].download_count,1);await f.settle();
});

test('CSV export quotes every text field rather than corrupting plan and batch columns',async()=>{
  const f=await fixture();f.code();f.sqlite.prepare('UPDATE activation_codes SET plan_id=?,batch_id=?').run('A,B','"quoted"');
  const r=await adminCall(f,'/api/admin/codes?export=1');assert.equal(r.status,200);assert.match(await r.text(),/,"A,B","""quoted""",/);
});

test('WebDAV accepts UTF-8 account credentials and advertises the charset',async()=>{
  const f=await davFixture();await f.api.updateSettings(f.env,{webdav_username:'用户',webdav_password_hash:await f.api.hashPassword('密码')});
  const authorization='Basic '+Buffer.from('用户:密码','utf8').toString('base64');
  assert.equal((await f.dav('HEAD','/safe/file.txt',{authorization})).status,200);
  const unauthorized=await f.api.handleWebDAV(f.request('/webdav/safe/file.txt'),f.env,f.ctx);
  assert.equal(unauthorized.status,401);assert.match(unauthorized.headers.get('www-authenticate'),/charset="UTF-8"/);
});

test('missing D1 binding preserves the actionable configuration error',async()=>{
  const f=await fixture();await assert.rejects(f.api.ensureSchema({...f.env,db:undefined}),/Database binding 'db'/);
});

 test('GitHub visibility persists through admin settings and reaches share info',async()=>{
  const f=await fixture();
  assert.equal((await (await adminCall(f,'/api/admin/settings')).json()).github_button_enabled,true);
  for (const enabled of [false,true,false]) {
    const saved=await adminCall(f,'/api/admin/settings',{method:'PUT',body:JSON.stringify({github_button_enabled:enabled})});
    assert.equal(saved.status,200);
    assert.equal(f.sqlite.prepare("SELECT value FROM settings WHERE key='github_button_enabled'").get().value,enabled?'1':'0');
    assert.equal((await (await adminCall(f,'/api/admin/settings')).json()).github_button_enabled,enabled);
    const info=await f.api.handleShareInfo(f.request('/s/share/info'),f.env,'share');
    assert.equal((await info.json()).github_button_enabled,enabled);
  }
});

test('storage browser resolves original names without changing keys or pagination',async()=>{
  const f=await fixture();
  f.env.r2.list=async()=>({objects:[{key:'object',size:10},{key:'unregistered',size:3}],delimitedPrefixes:['folder/'],truncated:true,cursor:'next-page'});
  const response=await adminCall(f,'/api/admin/storage/objects');assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.nextMarker,'next-page');
  const known=data.entries.find(e=>e.key==='object');assert.equal(known.original_name,'file.txt');assert.equal(known.registered,true);assert.equal(known.name,'object');
  const unknown=data.entries.find(e=>e.key==='unregistered');assert.equal(unknown.original_name,null);assert.equal(unknown.registered,false);
  assert.equal(data.entries.find(e=>e.isDir).name,'folder/');
});

test('share editing keeps token and counters, preserves passwords unless explicitly changed, and updates public metadata',async()=>{
  const f=await fixture();
  const originalHash=await f.api.hashPassword('old');
  f.sqlite.prepare('UPDATE shares SET password_hash=?,download_count=2').run(originalHash);
  const edit=body=>adminCall(f,'/api/admin/shares/share',{method:'PUT',body:JSON.stringify(body)});
  assert.equal((await edit({download_name:'新名称.zip',expires_at:Date.now()+3600000,max_downloads:7})).status,200);
  let row=f.sqlite.prepare('SELECT * FROM shares').get();assert.equal(row.id,'share');assert.equal(row.download_count,2);assert.equal(row.password_hash,originalHash);
  const info=await f.api.handleShareInfo(f.request('/s/share/info'),f.env,'share');assert.equal((await info.json()).name,'新名称.zip');
  assert.equal((await edit({password:'new'})).status,200);
  assert.equal((await f.api.handleVerify(f.request('/s/share/verify',{method:'POST',body:JSON.stringify({password:'old'})}),f.env,'share')).status,401);
  assert.equal((await f.api.handleVerify(f.request('/s/share/verify',{method:'POST',body:JSON.stringify({password:'new'})}),f.env,'share')).status,200);
  assert.equal((await edit({password:null,download_name:null,expires_at:null,max_downloads:0})).status,200);
  row=f.sqlite.prepare('SELECT * FROM shares').get();assert.equal(row.password_hash,null);assert.equal(row.password_cipher,null);assert.equal(row.max_downloads,null);assert.equal(row.download_count,2);
  assert.equal((await (await f.api.handleShareInfo(f.request('/s/share/info'),f.env,'share')).json()).name,'file.txt');
  for (const body of [{max_downloads:-1},{max_downloads:1.5},{expires_at:'bad'},{password:7},{download_name:[]}]) assert.equal((await edit(body)).status,400);
  assert.equal((await adminCall(f,'/api/admin/shares/missing',{method:'PUT',body:'{}'})).status,404);
});
