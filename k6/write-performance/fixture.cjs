const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const run = process.env.PERF_RUN_ID;
if (!/^qperf[0-9a-f]{24}$/.test(run || '') || process.env.PERF_DB !== run || !process.env.PERF_LOGIN_PASSWORD || !process.env.PERF_EMAIL) throw Error('Fixture guard rejected environment');
const db = new PrismaClient();
(async () => {
 const identity = await db.$queryRaw`SELECT current_database() AS database, current_user AS username`;
 if (identity[0]?.database !== run || identity[0]?.username !== process.env.PERF_USER) throw Error('Database identity mismatch');
 const [users, villages, logs] = await Promise.all([db.user.count(), db.village.count(), db.auditLog.count()]);
 if (users || villages || logs) throw Error('Expected a freshly migrated empty database');
 const userId=randomUUID(), governorateId=randomUUID(), villageId=randomUUID();
 const passwordHash=await bcrypt.hash(process.env.PERF_LOGIN_PASSWORD,12);
 await db.$transaction(async tx => {
  await tx.user.create({data:{id:userId,email:process.env.PERF_EMAIL,fullName:'Synthetic performance editor',passwordHash,role:'EDITOR'}});
  await tx.governorate.create({data:{id:governorateId,nameAr:run,nameEn:run,code:run}});
  await tx.village.create({data:{id:villageId,governorateId,slug:run,nameAr:run,createdById:userId,updatedById:userId}});
 });
 const setupAuditCount=await db.auditLog.count();
 if(setupAuditCount!==0)throw Error(`Expected zero setup audit rows, got ${setupAuditCount}`);
 fs.writeFileSync('/perf-output/fixtures.json',JSON.stringify({run,userId,governorateId,villageId,setupAuditCount},null,2)+'\n',{flag:'wx'});
})().finally(()=>db.$disconnect()).catch(error=>{console.error(error.message);process.exitCode=1;});
