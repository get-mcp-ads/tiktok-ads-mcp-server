/** Copyright 2026 getmcpads. SPDX-License-Identifier: Apache-2.0 */
import {NO_REDIRECT,refuseRedirect} from '../../core/redirects.js';
import {parseTikTokJson} from '../../core/tiktok-json.js';
import {REQUEST_TIMEOUT_MS,readBoundedText,tiktokApiBase} from '../../core/hosts.js';
/** Closed endpoint selection: a tool argument can never switch hosts or tenants. */
export function tiktokWriteApi(config: Record<string,unknown>) {
  const environment=String(config.tiktokEnvironment||'production');
  if(!['production','sandbox'].includes(environment))throw new Error('Invalid TikTok API environment.');
  const sandbox=environment==='sandbox';
  const base=tiktokApiBase(environment);
  const accessToken=String(config.accessToken??'');
  // Undefined keeps the 2.0 behaviour: every advertiser the token reaches. A set list is enforced, empty or not.
  const allowed=Array.isArray(config.allowedAccountIds)?config.allowedAccountIds.map(String):undefined;
  function scope(advertiserId:string){
    if(!/^\d+$/.test(advertiserId))throw new Error('Use a numeric advertiser ID string.');
    if(sandbox&&(!config.sandboxAdvertiserId||advertiserId!==config.sandboxAdvertiserId))throw new Error('Sandbox writes require the explicitly bound sandbox advertiser. No production account is allowed.');
    if(allowed&&!allowed.includes(advertiserId))throw new Error(`Advertiser ${advertiserId} is not in TIKTOK_ADVERTISER_IDS. Nothing was sent.`);
  }
  async function call(path:string,method:'GET'|'POST',data:Record<string,unknown>,file?:{field:string,name:string,bytes:Uint8Array,mime:string}){
    const ids=typeof data.advertiser_id==='string'?[data.advertiser_id]:Array.isArray(data.advertiser_ids)?data.advertiser_ids.map(String):[];
    if(allowed&&!ids.length)throw new Error('Every TikTok call must name an advertiser from TIKTOK_ADVERTISER_IDS. Nothing was sent.');
    ids.forEach(scope);
    const url=new URL(`${base}/${path}`);
    if(method==='GET')for(const[k,v]of Object.entries(data))if(v!==undefined)url.searchParams.set(k,typeof v==='object'?JSON.stringify(v):String(v));
    let multipart:FormData|undefined;
    if(file){multipart=new FormData();for(const[k,v]of Object.entries(data))if(v!==undefined)multipart.set(k,typeof v==='object'?JSON.stringify(v):String(v));multipart.set(file.field,new Blob([file.bytes as Uint8Array<ArrayBuffer>],{type:file.mime}),file.name);}
    let response:Response;
    try{response=await fetch(url,{method,redirect:NO_REDIRECT,headers:{'Access-Token':accessToken,...(!file?{'content-type':'application/json'}:{})},...(method==='POST'?{body:multipart??JSON.stringify(data)}:{}),signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)});refuseRedirect(response,'TikTok Business API');}
    catch{throw Object.assign(new Error(method==='POST'?'TikTok did not confirm the write. Reconcile the advertiser before retrying to avoid duplicates.':'TikTok could not be reached.'),{outcome:method==='POST'?'unknown':'not_applied'});}
    let result:any;try{result=parseTikTokJson(await readBoundedText(response));}catch{throw Object.assign(new Error(`TikTok HTTP ${response.status}: unreadable response.`),{outcome:method==='POST'&&response.status!==404?'unknown':'not_applied'});}
    // TikTok answers HTTP 200 even on failure: a non-zero code is an error.
    if(!response.ok||result.code!==0)throw Object.assign(new Error(String(result.message||`TikTok HTTP ${response.status}`).replaceAll(accessToken||'\u0000','[redacted]').slice(0,700)),{code:result.code,requestId:result.request_id,outcome:response.status>=500&&method==='POST'?'unknown':'not_applied'});
    return result;
  }
  const info=async(advertiserId:string)=>{
    scope(advertiserId);const r=await call('advertiser/info/','GET',{advertiser_ids:[advertiserId],fields:['advertiser_id','name','currency','timezone','country','status']});
    const found=r.data?.list?.find((x:any)=>String(x.advertiser_id)===advertiserId);if(!found)throw new Error('Cannot verify the selected TikTok advertiser. Nothing was changed.');return found;
  };
  const entity=async(advertiserId:string,level:'campaign'|'adgroup'|'ad',id:string,smart=false,afterCreate=false)=>{
    scope(advertiserId);
    // Newly created entities can be absent from the read index briefly. Retry
    // only these exact-ID GETs; never repeat a POST or retry permission failures.
    for(const delay of afterCreate?[0,1000,3000,6000]:[0]){
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      const r=await call(`${smart?'smart_plus/':''}${level}/get/`,'GET',{advertiser_id:advertiserId,filtering:{[`${smart&&level==='ad'?'smart_plus_ad':level}_ids`]:[id],primary_status:'STATUS_ALL'},page_size:100});
      const row=r.data?.list?.find((x:any)=>String(x[`${smart&&level==='ad'?'smart_plus_ad':level}_id`])===id);
      if(row){if(row.advertiser_id!==undefined&&String(row.advertiser_id)!==advertiserId)break;return row;}
    }
    throw new Error(`Cannot verify this ${level} in the selected advertiser. Nothing was changed.`);
  };
  return {base,environment,scope,call,info,entity};
}
