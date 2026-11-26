import type { RequestHandler } from 'express';
import { changeRequestsService } from './change-requests.service.js';
export const submit: RequestHandler = async (req,res,next) => {
 try { const item=await changeRequestsService.submit(req.body,{actorId:req.user.id,role:req.user.role,requestId:req.requestId}); res.status(201).json({data:item}); }
 catch(error) { next(error); }
};
