import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { SubmitChangeRequestInput } from './change-requests.schemas.js';

export const changeRequestsRepository = {
 transaction<T>(fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> { return prisma.$transaction(fn); },
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
