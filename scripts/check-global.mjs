// Executes actual frontend map logic with fake DOM/API surfaces. No network.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('public/admin.html', root), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
new vm.Script(script);
const loader = script.slice(script.indexOf('let echartsLoaded'), script.indexOf('/** ISO 3166'));
const render = script.slice(script.indexOf('async function loadGlobal(){'), script.indexOf('/* ═══════════ 激活码管理'));
const world = JSON.parse(readFileSync(new URL('assets/world.geojson', root), 'utf8'));
const countries = [
  {country:'CN',downloads:8,bytes:80,unique_ips:2},
  {country:'US',downloads:2,bytes:20,unique_ips:1},
  {country:'ZZ',downloads:1,bytes:10,unique_ips:1},
];
function fixture() {
  const elements = new Map();
  const get = key => {
    if (!elements.has(key)) elements.set(key, {innerHTML:'',contains:()=>true});
    return elements.get(key);
  };
  const calls = {scripts:0,fetches:0,registrations:0,options:[],disposed:0};
  const echarts = {
    registerMap(name,map){assert.equal(name,'world');assert.equal(map.type,'FeatureCollection');calls.registrations++;},
    init(){return {setOption(option){calls.options.push(option);},resize(){},dispose(){calls.disposed++;}};},
  };
  const context = {
    Set,Intl,AbortSignal,setTimeout,clearTimeout,window:{addEventListener(){},removeEventListener(){}},
    document:{documentElement:{},createElement(){return {remove(){}};},head:{appendChild(node){
      calls.scripts++;assert.equal(node.src,'/echarts.js');context.window.echarts=echarts;queueMicrotask(()=>node.onload());
    }}},
    async fetch(url){calls.fetches++;assert.equal(url,'/world.json');return {ok:true,json:async()=>world};},
    async api(){return {countries,totals:{downloads:11,bytes:110,countries_seen:3}};},
    $:get,LANG:'zh',t:key=>key,esc:value=>String(value??''),fmtSize:value=>String(value),
    countryName:code=>({CN:'中国',US:'美国',ZZ:'未知'}[code]||code),
    getComputedStyle:()=>({getPropertyValue:()=> '#a64f36'}),
  };
  vm.createContext(context);vm.runInContext(loader+render,context);
  return {context,calls,get};
}

test('map assets load once from the Worker and region matching uses GeoJSON names',async()=>{
  const {context,calls}=fixture();
  await Promise.all([context.ensureECharts(),context.ensureECharts()]);
  await context.ensureECharts();
  assert.equal(calls.scripts,1);assert.equal(calls.fetches,1);assert.equal(calls.registrations,1);
  assert.equal(context.countryMapName('CN'),'China');assert.equal(context.countryMapName('US'),'United States');
  assert.equal(context.countryMapName('KR'),'Korea');assert.equal(context.countryMapName('ZZ'),null);
});

test('heatmap uses numeric download values while hotspots retain coordinates',async()=>{
  const {context,calls,get}=fixture();await context.loadGlobal();
  const option=calls.options[0];
  assert.equal(option.series[0].data[0].name,'China');
  assert.equal(option.series[0].data[0].countryLabel,'中国');
  assert.equal(option.series[0].data[0].value,8);
  assert.equal(option.series[0].data.length,2);
  assert.equal(option.series[1].data[0].value.join(','),'104,35,8');
  assert.match(get('#global-table-wrap').innerHTML,/中国/);
  await context.loadGlobal();assert.equal(calls.disposed,1);
});

test('a map-loading failure still leaves totals and rankings available',async()=>{
  const {context,calls,get}=fixture();context.ensureECharts=async()=>{throw Error('unavailable');};
  await context.loadGlobal();
  assert.equal(calls.options.length,0);
  assert.match(get('#globe').innerHTML,/地图加载失败/);
  assert.match(get('#global-totals').innerHTML,/110/);
  assert.match(get('#global-table-wrap').innerHTML,/中国/);
});

test('the bundled ECharts engine can render the real map using SVG',async()=>{
  const fixtureData=fixture();await fixtureData.context.loadGlobal();
  const context={setTimeout,clearTimeout};vm.createContext(context);
  vm.runInContext(readFileSync(new URL('assets/echarts.bundle.txt',root),'utf8'),context);
  const engine=context.echarts;engine.registerMap('world',world);
  const chart=engine.init(null,null,{renderer:'svg',ssr:true,width:800,height:400});
  try {
    chart.setOption({...fixtureData.calls.options[0],animation:false});
    const svg=chart.renderToSVGString();assert.match(svg,/<svg/);assert.match(svg,/<path/);assert.match(svg,/#a64f36/);
  } finally { chart.dispose(); }
});
