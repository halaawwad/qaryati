import type { RequestHandler } from 'express';
import { changeRequestsService } from './change-requests.service.js';
import type { ListChangeRequestsQuery } from './change-requests.schemas.js';
export const list: RequestHandler = async (req,res,next) => {
 try { const result=await changeRequestsService.list(req.query as ListChangeRequestsQuery,{actorId:req.user.id,role:req.user.role}); res.status(200).json({data:result.items,meta:result.meta}); } catch(error) {next(error);}
};
export const getById: RequestHandler = async (req,res,next) => {
 try { const item=await changeRequestsService.getById(String(req.params.id),{actorId:req.user.id,role:req.user.role}); res.status(200).json({data:item}); } catch(error) {next(error);}
};
export const submit: RequestHandler = async (req,res,next) => {
 try { const item=await changeRequestsService.submit(req.body,{actorId:req.user.id,role:req.user.role,requestId:req.requestId}); res.status(201).json({data:item}); }
 catch(error) { next(error); }
};
