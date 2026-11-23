import { describe, expect, it, vi } from 'vitest';
import { PopulationService } from '../src/modules/population/population.service.js';
import { NotFoundError } from '../src/shared/errors.js';
vi.mock('../src/shared/db.js', () => ({ prisma: {} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));
describe('population service', () => {
 it('passes filters and pagination and constructs metadata', async () => {
  const repository = {findMany:vi.fn().mockResolvedValue({items:[{id:'x'}],total:21}),findById:vi.fn()}; const villages={ensureExists:vi.fn().mockResolvedValue(undefined)};
  const result=await new PopulationService(repository,villages).list('v',{page:2,limit:10,isEstimate:false});
  expect(repository.findMany).toHaveBeenCalledWith(expect.objectContaining({villageId:'v',filters:expect.objectContaining({isEstimate:false}),skip:10,take:10,sort:{field:'referenceYear',order:'desc'}}));
  expect(result.meta).toMatchObject({page:2,total:21,totalPages:3});
 });
 it('rechecks village on an empty page', async () => { const villages={ensureExists:vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new NotFoundError('Village not found'))}; const service=new PopulationService({findMany:vi.fn().mockResolvedValue({items:[],total:0}),findById:vi.fn()},villages); await expect(service.list('v',{})).rejects.toBeInstanceOf(NotFoundError); });
 it('returns 404 for missing details', async () => { const service=new PopulationService({findMany:vi.fn(),findById:vi.fn().mockResolvedValue(null)},{ensureExists:vi.fn()}); await expect(service.getById('x')).rejects.toBeInstanceOf(NotFoundError); });
 it.each([{page:1,total:0},{page:3,total:1}])('returns empty page $page with total $total', async ({page,total}) => {
  const repository={findMany:vi.fn().mockResolvedValue({items:[],total}),findById:vi.fn()}; const villages={ensureExists:vi.fn().mockResolvedValue(undefined)};
  const result=await new PopulationService(repository,villages).list('v',{page,limit:500,sort:'population',order:'asc'});
  expect(repository.findMany).toHaveBeenCalledWith(expect.objectContaining({skip:(page-1)*100,take:100,sort:{field:'population',order:'asc'}}));
  expect(result).toEqual({items:[],meta:{page,limit:100,total,totalPages:total?1:0,hasNextPage:false,hasPrevPage:page>1}});
 });
 it('returns 404 for a missing or deleted village before querying records', async () => {
  const repository={findMany:vi.fn(),findById:vi.fn()}; const villages={ensureExists:vi.fn().mockRejectedValue(new NotFoundError('Village not found'))};
  await expect(new PopulationService(repository,villages).list('v',{})).rejects.toBeInstanceOf(NotFoundError);
  expect(repository.findMany).not.toHaveBeenCalled();
 });
});
