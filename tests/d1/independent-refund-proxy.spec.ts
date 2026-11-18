import { test, expect } from '@playwright/test';
import { StrKey } from '@stellar/stellar-sdk';
import { proxyD1 } from '../../src/lib/d1/server-proxy';

// S1-S3/S17: synthetic correlation/transport evidence, never authority or funds.
const pool = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7));
const other = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 8));
const namespace = '12345678-1234-1234-1234-123456789abc';
const requestId = 'abcdef12-1234-1234-1234-123456789abc';
const ref = 'abcdefghijklmnopqrst';
const enc = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
const key = `${enc({alg:'HS256',typ:'JWT'})}.${enc({role:'anon',ref})}.${Buffer.alloc(32).toString('base64url')}`;
const env = { D1_CUSTODY_SUPABASE_URL: `https://${ref}.supabase.co`, D1_CUSTODY_ANON_KEY: key, D1_CUSTODY_NAMESPACE: namespace };
const routes = ['refund-status','refund','refund-reconcile','refund-remainder-status','refund-remainder','refund-remainder-reconcile'];
function command(path: string) {
  return {version:path.includes('remainder') ? 2 : 1, action:path.replaceAll('-','_'), network:'TESTNET',namespace,pool,request_id:requestId};
}
function dto(path: string) {
  const c = command(path); const execute = c.version === 1 ? 'refund' : 'refund_remainder';
  return {version:c.version, network:'TESTNET',namespace,pool,requestId,state:'not_started',verification:'unverified',deadline:'2026-11-01T00:05:00Z',
    donation:{paymentOperationId:'1',paymentTransactionHash:'a'.repeat(64),donor:other,asset:{type:'native'},grossAmount:'10.0000000'},refund:null,
    settlement:{beneficiaryClaimedAmount:null,donorRefundedAmount:null,remainingPrincipalAmount:null},safeActions:[execute,`${execute}_status`],reason:null as string | null};
}
async function call(path: string, body: string | Uint8Array, upstream: () => Response, status = 200) {
  let calls = 0;
  const response = await proxyD1(new Request(`https://web.invalid/api/d1/${path}`, {method:'POST',headers:{'content-type':'application/json',authorization:'browser',cookie:'private',apikey:'browser'},body:body as BodyInit}),path,{env,fetch:async (url, init) => {
    calls++;
    expect(url).toBe(`https://${ref}.supabase.co/functions/v1/d1-custody/${path}`);
    expect(init?.body).toEqual(typeof body === 'string' ? new TextEncoder().encode(body) : body);
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({accept:'application/json','content-type':'application/json',authorization:`Bearer ${key}`,apikey:key});
    expect([init?.method,init?.redirect,init?.credentials,init?.cache]).toEqual(['POST','manual','omit','no-store']);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return upstream();
  }});
  expect(response.status).toBe(status);
  expect(Object.fromEntries(response.headers)).toEqual({'cache-control':'no-store','content-type':'application/json'});
  return {calls,text:await response.text()};
}
const wire = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status,headers:{'content-type':'application/json','set-cookie':'private'}});

test('S1-S3/S17: all six routes preserve bytes, server headers and unverified reports', async () => {
  for (const path of routes) {
    // Deliberately absent proof/admin and stale timestamp: backend owns authentication.
    const body = `  ${JSON.stringify({...command(path),timestamp:0,payload:{note:'é'}})}\n`;
    const report = dto(path);
    const result = await call(path,body,() => wire(report));
    expect(result).toEqual({calls:1,text:JSON.stringify(report)});
    const changedPool = {...command(path),pool:other};
    expect(await call(path,JSON.stringify(changedPool),() => wire({...report,pool:other}))).toEqual({calls:1,text:JSON.stringify({...report,pool:other})});
  }
});

test('S1/S17: correlation and byte boundaries reject before any upstream attempt', async () => {
  for (const path of routes) {
    for (const patch of [{version:0},{action:'refund/status'},{network:'PUBLIC'},{namespace:requestId},{pool:'bad'},{request_id:''},{request_id:requestId.toUpperCase()}]) {
      expect(await call(path,JSON.stringify({...command(path),...patch}),() => {throw new Error('must not fetch');},400)).toEqual({calls:0,text:'{"error":"invalid_request"}'});
    }
  }
  const path = 'refund'; const raw = JSON.stringify(command(path));
  expect((await call(path,raw.padEnd(8192),() => wire(dto(path)))).calls).toBe(1);
  for (const [body,status,error] of [[raw.padEnd(8193),413,'body_too_large'],[new Uint8Array([0xc3,0x28]),400,'invalid_json'],['[]',400,'invalid_json']] as const) {
    expect(await call(path,body,() => {throw new Error('must not fetch');},status)).toEqual({calls:0,text:JSON.stringify({error})});
  }
});

test('S1/S17: narrow conflicts, bound reports, private errors and single failed attempt', async () => {
  for (const path of routes) {
    const body = JSON.stringify(command(path)); const base = dto(path);
    const execute = path === 'refund' || path === 'refund-remainder';
    for (const state of ['not_due','blocked']) {
      const report = {...base,state,reason:state === 'not_due' ? 'deadline_not_reached' : 'remainder_protected',safeActions:state === 'not_due' ? [base.safeActions[1]] : [base.safeActions[1],`${base.safeActions[0]}_reconcile`]};
      expect(await call(path,body,() => wire(report,409),execute ? 409 : 502)).toEqual({calls:1,text:execute ? JSON.stringify(report) : '{"error":"invalid_upstream_response"}'});
    }
    expect(await call(path,body,() => wire({error:'not_authorized'},409),409)).toEqual({calls:1,text:'{"error":"not_authorized"}'});
    for (const bad of [{...base,pool:other},{...base,requestId:namespace},{...base,version:3},{...base,extra:'private'},{error:'private details'},{error:'safe',detail:'private'}]) {
      expect(await call(path,body,() => wire(bad),502)).toEqual({calls:1,text:'{"error":"invalid_upstream_response"}'});
    }
    expect(await call(path,body,() => {throw new Error('private');},502)).toEqual({calls:1,text:'{"error":"upstream_unavailable"}'});
    const text = JSON.stringify(base);
    expect((await call(path,body,() => new Response(text.padEnd(65536),{headers:{'content-type':'application/json'}}))).calls).toBe(1);
    expect(await call(path,body,() => new Response(text.padEnd(65537),{headers:{'content-type':'application/json'}}),502)).toEqual({calls:1,text:'{"error":"invalid_upstream_response"}'});
    expect(await call(path,body,() => new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}}),502)).toEqual({calls:1,text:'{"error":"invalid_upstream_response"}'});
  }
});
