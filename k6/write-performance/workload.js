import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';

const run=__ENV.PERF_RUN_ID, phase=__ENV.PERF_PHASE;
const base='http://app:3000/api/v1';
const starts=new Counter('write_iterations_started'),completed=new Counter('write_iterations_completed');
const mutations=new Counter('write_mutations'), conflicts=new Counter('expected_conflicts');
const errors=new Counter('unexpected_responses'), invalid=new Counter('invalid_contracts');
const attempts=new Counter('audit_attempt'), outcomes=new Counter('audit_outcome');
const contention=new Counter('contention_rounds');
const durationKinds=['source_create','source_update','source_stale','population_create','population_update','population_stale','contention_create','contend_a','contend_b','contention_read'];
export const options={
 scenarios:{writes:{executor:'constant-vus',vus:Number(__ENV.VUS||1),duration:__ENV.DURATION||'10s',gracefulStop:'30s'}},
 thresholds:{unexpected_responses:['count==0'],invalid_contracts:['count==0'],checks:['rate==1'],...Object.fromEntries(durationKinds.map(kind=>[`http_req_duration{name:${kind}}`,['max>=0']]))},
 summaryTrendStats:['avg','min','med','p(95)','p(99)','max'],
};
function ensure(value,message){const ok=check(value,{[message]:v=>Boolean(v)});if(!ok)invalid.add(1);return ok;}
function contract(res,path){try{return res.json(path);}catch(_error){return undefined;}}
function identity(kind){return `${run}.${phase}.${__VU}.${__ITER}.${kind}`;}
function params(kind,token,expected,extra={}){return {headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'X-Request-Id':identity(kind)},tags:{name:kind,operation:kind},responseCallback:http.expectedStatuses(...expected),...extra};}
function begin(kind){attempts.add(1,{rid:identity(kind)});}
function end(kind,res,expected,entity,action){
 const rid=identity(kind),status=res.status,valid=expected.includes(status);
 if(!valid) errors.add(1);
 const id=entity||contract(res,'data.id')||'';
 const writes=status===200||status===201;
 outcomes.add(1,{rid,status:String(status),entity_type:action==='NONE'?'':action.startsWith('P')?'PopulationRecord':'Source',entity_id:String(id),action:writes?action.slice(1):'NONE'});
 if(writes)mutations.add(1);else if(status===409&&valid)conflicts.add(1);
 return valid;
}
function call(method,url,body,kind,token,expected,entity,action){begin(kind);const res=http.request(method,url,JSON.stringify(body),params(kind,token,expected));return {res,ok:end(kind,res,expected,entity,action)};}
export function setup(){
 if(__ENV.PERF_GATE!=='verified-disposable' || !/^qperf[0-9a-f]{24}$/.test(run||'') || !['warmup','measure'].includes(phase) || !__ENV.PERF_VILLAGE_ID || !__ENV.PERF_EMAIL || !__ENV.PERF_LOGIN_PASSWORD) fail('Disposable runner guard missing');
 errors.add(0);invalid.add(0);starts.add(0);completed.add(0);mutations.add(0);conflicts.add(0);contention.add(0);
 const response=http.post(`${base}/auth/login`,JSON.stringify({email:__ENV.PERF_EMAIL,password:__ENV.PERF_LOGIN_PASSWORD}),{headers:{'Content-Type':'application/json'},tags:{name:'login'}});
 if(response.status!==200 || !contract(response,'accessToken'))fail('Synthetic editor login failed');
 return {token:response.json('accessToken')};
}
export default function(data){
 starts.add(1);const token=data.token,key=`${run}-${phase}-${__VU}-${__ITER}`;
 const source=call('POST',`${base}/sources`,{title:key,sourceType:'CENSUS'},'source_create',token,[201],null,'SCREATE');
 if(!source.ok)return;
 const sid=contract(source.res,'data.id'),sv=contract(source.res,'data.version');
 if(!ensure(typeof sid==='string'&&sv===1,'source create envelope'))return;
 const update=call('PATCH',`${base}/sources/${sid}`,{expectedVersion:sv,title:`${key}-updated`},'source_update',token,[200],sid,'SUPDATE');
 if(!update.ok||!ensure(contract(update.res,'data.version')===sv+1,'source update envelope'))return;
 const stale=call('PATCH',`${base}/sources/${sid}`,{expectedVersion:sv,title:`${key}-stale`},'source_stale',token,[409],sid,'SUPDATE');
 if(!stale.ok||!ensure(contract(stale.res,'error.code')==='CONFLICT','source stale envelope'))return;
 const population=call('POST',`${base}/villages/${__ENV.PERF_VILLAGE_ID}/population-records`,{sourceId:sid,referenceYear:2020,population:100},'population_create',token,[201],null,'PCREATE');
 if(!population.ok)return;
 const pid=contract(population.res,'data.id'),pv=contract(population.res,'data.version');if(!ensure(typeof pid==='string'&&pv===1,'population create envelope'))return;
 const change=call('PATCH',`${base}/population-records/${pid}`,{expectedVersion:pv,population:110},'population_update',token,[200],pid,'PUPDATE');
 if(!change.ok||!ensure(contract(change.res,'data.version')===pv+1,'population update envelope'))return;
 const stalePop=call('PATCH',`${base}/population-records/${pid}`,{expectedVersion:pv,population:120},'population_stale',token,[409],pid,'PUPDATE');
 if(!stalePop.ok||!ensure(contract(stalePop.res,'error.code')==='CONFLICT','population stale envelope'))return;
 const contested=call('POST',`${base}/sources`,{title:`${key}-contended`,sourceType:'BOOK'},'contention_create',token,[201],null,'SCREATE');
 if(!contested.ok)return;const cid=contract(contested.res,'data.id'),cv=contract(contested.res,'data.version');if(!ensure(typeof cid==='string'&&cv===1,'contention create envelope'))return;
 const kinds=['contend_a','contend_b'];for(const kind of kinds)begin(kind);
 const batch=http.batch(kinds.map((kind,index)=>({method:'PATCH',url:`${base}/sources/${cid}`,body:JSON.stringify({expectedVersion:cv,title:`${key}-winner-${index}`}),params:params(kind,token,[200,409])})));
 for(let i=0;i<2;i++)end(kinds[i],batch[i],[200,409],cid,'SUPDATE');
 if(!ensure(batch.filter(r=>r.status===200).length===1&&batch.filter(r=>r.status===409).length===1,'exactly one contention winner'))return;
 if(!ensure(batch.filter(r=>r.status===409).every(r=>contract(r,'error.code')==='CONFLICT'),'contention conflict envelope'))return;
 const read=http.get(`${base}/sources/${cid}`,{tags:{name:'contention_read'}}),winner=batch.find(r=>r.status===200);
 if(!ensure(read.status===200&&contract(read,'data.version')===cv+1&&contract(read,'data.title')===contract(winner,'data.title')&&[`${key}-winner-0`,`${key}-winner-1`].includes(contract(read,'data.title')),'contention persisted response'))return;
 contention.add(1);completed.add(1);
}
export function handleSummary(data){const {state,metrics,root_group,options}=data;return {[`/perf-output/${phase}-summary.json`]:JSON.stringify({state,metrics,root_group,options},null,2)};}
