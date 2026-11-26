import type { Role } from '@prisma/client';
import { ForbiddenError, NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination } from '../../shared/pagination.js';
import { recordAudit } from '../audit/audit.service.js';
import { populationService } from '../population/population.service.js';
import { changeRequestsRepository } from './change-requests.repository.js';
import type { ListChangeRequestsQuery, SubmitChangeRequestInput } from './change-requests.schemas.js';

export const changeRequestsService = {
 async list(query: ListChangeRequestsQuery, context: {actorId:string;role:Role}) {
  if (!['EDITOR','REVIEWER','ADMIN'].includes(context.role)) throw new ForbiddenError();
  if (context.role === 'EDITOR' && query.requestedById !== undefined) throw new ForbiddenError();
  const pagination=parsePagination(query);
  const {status,entityType,entityId}=query;
  const requestedById=context.role==='EDITOR' ? context.actorId : query.requestedById;
  const result=await changeRequestsRepository.list({status,entityType,entityId,requestedById},pagination.skip,pagination.take);
  return {items:result.items,meta:buildPaginationMeta(result.total,pagination)};
 },
 async getById(id: string, context: {actorId:string;role:Role}) {
  if (!['EDITOR','REVIEWER','ADMIN'].includes(context.role)) throw new ForbiddenError();
  const item=await changeRequestsRepository.findById(id,context.role==='EDITOR'?context.actorId:undefined);
  if (!item) throw new NotFoundError('Change request not found');
  return item;
 },
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
