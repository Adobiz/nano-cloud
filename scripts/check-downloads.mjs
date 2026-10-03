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
  stdin: { contents: ['db', 'public', 'codes', 'settings', 'download-accounting']
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
