import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import { ConflictError } from '../../shared/errors.js';
import type { SubmitChangeRequestInput } from './change-requests.schemas.js';

export const changeRequestsRepository = {
 transaction<T>(fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> { return prisma.$transaction(fn); },
 async lockById(id: string, client: Prisma.TransactionClient) {
  const rows=await client.$queryRaw<Array<{id:string}>>`SELECT id FROM change_requests WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) return null;
  return client.changeRequest.findUnique({where:{id}});
 },
 async reject(id: string, actorId: string, reviewComment: string, client: Prisma.TransactionClient) {
  try {
   return await client.changeRequest.update({where:{id,status:'PENDING'},data:{status:'REJECTED',reviewedById:actorId,reviewComment,reviewedAt:new Date()}});
  } catch(error) {
   if (error instanceof Prisma.PrismaClientKnownRequestError && error.code==='P2025') throw new ConflictError('Change request changed during review');
   throw error;
  }
 },
 create(input: SubmitChangeRequestInput, actorId: string, client: Prisma.TransactionClient) {
  return client.changeRequest.create({data:{entityType:input.entityType,entityId:input.entityId,baseVersion:input.baseVersion,
   proposedChanges:input.proposedChanges,reason:input.reason,requestedById:actorId,status:'PENDING'}});
 },
 async list(where: Prisma.ChangeRequestWhereInput, skip: number, take: number) {
  return prisma.$transaction(async client => {
   const [total,items]=await Promise.all([
    client.changeRequest.count({where}),
    client.changeRequest.findMany({where,skip,take,orderBy:[{createdAt:'desc'},{id:'asc'}]}),
   ]);
   return {total,items};
  }, {isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
 },
 findById(id: string, requestedById?: string) {
  return prisma.changeRequest.findFirst({where:{id,...(requestedById !== undefined ? {requestedById} : {})}});
 },
};
