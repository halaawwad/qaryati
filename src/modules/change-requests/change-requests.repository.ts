import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { SubmitChangeRequestInput } from './change-requests.schemas.js';

export const changeRequestsRepository = {
 transaction<T>(fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> { return prisma.$transaction(fn); },
 create(input: SubmitChangeRequestInput, actorId: string, client: Prisma.TransactionClient) {
  return client.changeRequest.create({data:{entityType:input.entityType,entityId:input.entityId,baseVersion:input.baseVersion,
   proposedChanges:input.proposedChanges,reason:input.reason,requestedById:actorId,status:'PENDING'}});
 },
};
