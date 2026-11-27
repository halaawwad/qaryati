const { PrismaClient }=require('@prisma/client');
const fs=require('node:fs');
const readline=require('node:readline');
const run=process.env.PERF_RUN_ID,phase=process.env.PERF_PHASE;
if(!/^qperf[0-9a-f]{24}$/.test(run||'')||process.env.PERF_DB!==run||!['warmup','measure'].includes(phase))throw Error('Reconciliation guard rejected environment');
const db=new PrismaClient();
(async()=>{
 const identity=await db.$queryRaw`SELECT current_database() AS database,current_user AS username`;
 if(identity[0]?.database!==run||identity[0]?.username!==process.env.PERF_USER)throw Error('Database identity mismatch');
 const fixture=JSON.parse(fs.readFileSync('/perf-output/fixtures.json','utf8'));
 if(fixture.run!==run)throw Error('Fixture manifest mismatch');
 const file=`/perf-output/${phase}-events.json`,summary=JSON.parse(fs.readFileSync(`/perf-output/${phase}-summary.json`,'utf8'));
 const attempts=new Map(),outcomes=new Map(),problems=[];
 const lines=readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity});
 for await(const line of lines){if(!line)continue;const e=JSON.parse(line);if(e.type!=='Point'||!['audit_attempt','audit_outcome'].includes(e.metric))continue;const tags=e.data.tags||{},rid=tags.rid;
  if(typeof rid!=='string'||!rid.startsWith(`${run}.${phase}.`)){problems.push('invalid request ID');continue;}
  const map=e.metric==='audit_attempt'?attempts:outcomes;if(map.has(rid))problems.push(`duplicate ${e.metric} ${rid}`);map.set(rid,tags);
 }
 if(!attempts.size)problems.push('no attempted writes recorded');
 for(const rid of attempts.keys())if(!outcomes.has(rid))problems.push(`interrupted or missing outcome ${rid}`);
 for(const rid of outcomes.keys())if(!attempts.has(rid))problems.push(`outcome without attempt ${rid}`);
 const audits=await db.auditLog.findMany({where:{requestId:{startsWith:`${run}.${phase}.`}},select:{id:true,requestId:true,entityType:true,entityId:true,action:true,actorId:true}});
 const grouped=new Map();for(const a of audits){const list=grouped.get(a.requestId)||[];list.push(a);grouped.set(a.requestId,list);}
 let expected=0;const sourceIds=new Set(),populationIds=new Set();
 const operations={source_create:{expected:0,actual:0},source_update:{expected:0,actual:0},population_create:{expected:0,actual:0},population_update:{expected:0,actual:0},contention_create:{expected:0,actual:0},contention_update:{expected:0,actual:0},stale_and_losing_conflicts:{expected:0,actual:0}};
 for(const [rid,o] of outcomes){const rows=grouped.get(rid)||[];const count=o.action==='NONE'?0:1;expected+=count;
  const kind=rid.split('.').at(-1);const bucket=kind==='contend_a'||kind==='contend_b'?(o.action==='NONE'?'stale_and_losing_conflicts':'contention_update'):(kind==='source_stale'||kind==='population_stale'?'stale_and_losing_conflicts':kind);
  if(!operations[bucket])problems.push(`${rid}: unknown operation`);else{operations[bucket].expected+=count;operations[bucket].actual+=rows.length;}
  if(rows.length!==count)problems.push(`${rid}: expected ${count} audit rows, got ${rows.length}`);
  if(count){if(!o.entity_id)problems.push(`${rid}: missing returned entity ID`);if(o.entity_type==='Source')sourceIds.add(o.entity_id);else if(o.entity_type==='PopulationRecord')populationIds.add(o.entity_id);else problems.push(`${rid}: invalid entity type`);
   if(rows.length===1&&(rows[0].entityType!==o.entity_type||rows[0].entityId!==o.entity_id||rows[0].action!==o.action||rows[0].actorId!==fixture.userId))problems.push(`${rid}: audit identity mismatch`);
  }
 }
 for(const rid of grouped.keys())if(!outcomes.has(rid))problems.push(`unexpected audit without outcome ${rid}`);
 const metric=name=>summary.metrics?.[name]?.values?.count??0;
 const started=metric('write_iterations_started'),finished=metric('write_iterations_completed');
 if(!started)problems.push('no iterations started');if(started!==finished)problems.push(`incomplete iterations: ${started-finished}`);
 if(metric('unexpected_responses')||metric('invalid_contracts'))problems.push('workload correctness counters nonzero');
 if(metric('write_mutations')!==expected)problems.push('successful mutation count differs from expected audit count');
 const result={run,phase,setupAuditCount:fixture.setupAuditCount,started,finished,interrupted:started-finished,attempted:attempts.size,expectedAudit:expected,actualAudit:audits.length,operations,expectedConflicts:metric('expected_conflicts'),successfulMutations:metric('write_mutations'),sourceIds:[...sourceIds],populationIds:[...populationIds],problems};
 fs.writeFileSync(`/perf-output/${phase}-manifest.json`,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({run,phase,started,finished,expectedAudit:expected,actualAudit:audits.length,operations,problems},null,2));
 if(problems.length)process.exitCode=1;
})().finally(()=>db.$disconnect()).catch(error=>{console.error(error.message);process.exitCode=1;});
