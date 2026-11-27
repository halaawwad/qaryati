import type { ChangeRequest, Role } from '@prisma/client';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination } from '../../shared/pagination.js';
import { recordAudit } from '../audit/audit.service.js';
import { populationService } from '../population/population.service.js';
import { changeRequestsRepository } from './change-requests.repository.js';
import { populationParamsSchema, populationProposalSchema } from '../population/population.schemas.js';
import type { ApproveChangeRequestInput, ListChangeRequestsQuery, RejectChangeRequestInput, SubmitChangeRequestInput } from './change-requests.schemas.js';

function snapshot(item: ChangeRequest) {
 return {id:item.id,entityType:item.entityType,entityId:item.entityId,baseVersion:item.baseVersion,proposedChanges:item.proposedChanges,
  reason:item.reason,status:item.status,requestedById:item.requestedById,reviewedById:item.reviewedById,reviewComment:item.reviewComment,
  createdAt:item.createdAt.toISOString(),updatedAt:item.updatedAt.toISOString(),reviewedAt:item.reviewedAt?.toISOString() ?? null};
}

export const changeRequestsService = {
 async approve(id:string, input:ApproveChangeRequestInput, context:{actorId:string;role:Role;requestId:string}) {
  if (context.role !== 'REVIEWER' && context.role !== 'ADMIN') throw new ForbiddenError();
  return changeRequestsRepository.transaction(async client => {
   const before=await changeRequestsRepository.lockById(id,client);
   if (!before) throw new NotFoundError('Change request not found');
   if (before.status !== 'PENDING') throw new ConflictError('Change request is not pending');
   if (before.requestedById.toLowerCase() === context.actorId.toLowerCase()) throw new ForbiddenError('Self-approval is not permitted');
   if (before.entityType !== 'PopulationRecord') throw new ConflictError('Unsupported change request entity');
   const parsed=populationProposalSchema.safeParse(before.proposedChanges);
   if (!parsed.success) throw new ConflictError('Invalid stored population proposal');
   if (!populationParamsSchema.safeParse({id:before.entityId}).success) throw new NotFoundError('Population record not found');
   const population=await populationService.applyApprovedChange(before.entityId,before.baseVersion,parsed.data,context.actorId,client);
   const after=await changeRequestsRepository.approve(id,context.actorId,input.reviewComment,client);
   await recordAudit({entityType:'PopulationRecord',entityId:before.entityId,action:'UPDATE',actorId:context.actorId,requestId:context.requestId,before:population.before,after:population.after},client);
   await recordAudit({entityType:'ChangeRequest',entityId:id,action:'APPROVE',actorId:context.actorId,requestId:context.requestId,before:snapshot(before),after:snapshot(after)},client);
   return after;
  });
 },
 async reject(id:string, input:RejectChangeRequestInput, context:{actorId:string;role:Role;requestId:string}) {
  if (context.role !== 'REVIEWER' && context.role !== 'ADMIN') throw new ForbiddenError();
  return changeRequestsRepository.transaction(async client=>{
   const before=await changeRequestsRepository.lockById(id,client);
   if (!before) throw new NotFoundError('Change request not found');
   if (before.status !== 'PENDING') throw new ConflictError('Change request is not pending');
   const after=await changeRequestsRepository.reject(id,context.actorId,input.reviewComment,client);
   await recordAudit({entityType:'ChangeRequest',entityId:id,action:'REJECT',actorId:context.actorId,requestId:context.requestId,before:snapshot(before),after:snapshot(after)},client);
   return after;
  });
 },
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
