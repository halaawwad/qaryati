import type { Role } from '@prisma/client';
import { ForbiddenError } from '../../shared/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { populationService } from '../population/population.service.js';
import { changeRequestsRepository } from './change-requests.repository.js';
import type { SubmitChangeRequestInput } from './change-requests.schemas.js';

export const changeRequestsService = {
 async submit(input: SubmitChangeRequestInput, context: {actorId:string; role:Role; requestId:string}) {
  if (context.role !== 'EDITOR') throw new ForbiddenError();
  return changeRequestsRepository.transaction(async client => {
   await populationService.validateChangeProposal(input.entityId, {expectedVersion:input.baseVersion,...input.proposedChanges}, client);
   const item = await changeRequestsRepository.create(input, context.actorId, client);
   await recordAudit({entityType:'ChangeRequest',entityId:item.id,action:'CREATE',actorId:context.actorId,requestId:context.requestId,before:null,
    after:{id:item.id,entityType:item.entityType,entityId:item.entityId,baseVersion:item.baseVersion,proposedChanges:input.proposedChanges,
     reason:item.reason,status:item.status,requestedById:item.requestedById,reviewedById:item.reviewedById,reviewComment:item.reviewComment,
     createdAt:item.createdAt.toISOString(),updatedAt:item.updatedAt.toISOString(),reviewedAt:item.reviewedAt?.toISOString() ?? null}},client);
   return item;
  });
 },
};
