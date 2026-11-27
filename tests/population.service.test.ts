import { describe, expect, it, vi } from 'vitest';
import { PopulationService } from '../src/modules/population/population.service.js';
import { NotFoundError } from '../src/shared/errors.js';
vi.mock('../src/shared/db.js', () => ({ prisma: {} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));
describe('population service', () => {
 it.each([
  [{},true], [{isPreferred:true},true], [{isPreferred:false},false], [{includeAll:true},undefined],
  [{includeAll:false},true], [{includeAll:false,isPreferred:true},true], [{includeAll:false,isPreferred:false},false],
 ] as const)('passes the effective preference filter for %j',async(query,expected)=>{
  const repository={preferredTransaction:vi.fn(),transaction:vi.fn(),findLatestVerified:vi.fn(),create:vi.fn(),findForUpdate:vi.fn(),findForDelete:vi.fn(),lockPreferredGroup:vi.fn(),findPreferredSlot:vi.fn(),lockPreferredRows:vi.fn(),setPreferred:vi.fn(),review:vi.fn(),softDelete:vi.fn(),update:vi.fn(),findMany:vi.fn().mockResolvedValue({items:[],total:0}),findById:vi.fn()};
  const villages={ensureExists:vi.fn().mockResolvedValue(undefined)};
  await new PopulationService(repository,villages).list('v',{...query,referenceYear:2020,sourceId:'source',isEstimate:false,needsReview:true,verificationStatus:'REJECTED',page:2,limit:3,sort:'population',order:'asc'});
  expect(repository.findMany).toHaveBeenCalledWith({villageId:'v',filters:{referenceYear:2020,sourceId:'source',isEstimate:false,isPreferred:expected,needsReview:true,verificationStatus:'REJECTED'},sort:{field:'population',order:'asc'},skip:3,take:3});
 });
 it('passes filters and pagination and constructs metadata', async () => {
  const repository = {preferredTransaction:vi.fn(),transaction:vi.fn(),findLatestVerified:vi.fn(),create:vi.fn(),findForUpdate:vi.fn(),findForDelete:vi.fn(),lockPreferredGroup:vi.fn(),findPreferredSlot:vi.fn(),lockPreferredRows:vi.fn(),setPreferred:vi.fn(),review:vi.fn(),softDelete:vi.fn(),update:vi.fn(),findMany:vi.fn().mockResolvedValue({items:[{id:'x'}],total:21}),findById:vi.fn()}; const villages={ensureExists:vi.fn().mockResolvedValue(undefined)};
  const result=await new PopulationService(repository,villages).list('v',{page:2,limit:10,isEstimate:false});
  expect(repository.findMany).toHaveBeenCalledWith(expect.objectContaining({villageId:'v',filters:expect.objectContaining({isEstimate:false}),skip:10,take:10,sort:{field:'referenceYear',order:'desc'}}));
  expect(result.meta).toMatchObject({page:2,total:21,totalPages:3});
 });
 it('rechecks village on an empty page', async () => { const villages={ensureExists:vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new NotFoundError('Village not found'))}; const service=new PopulationService({preferredTransaction:vi.fn(),transaction:vi.fn(),findLatestVerified:vi.fn(),create:vi.fn(),findForUpdate:vi.fn(),findForDelete:vi.fn(),lockPreferredGroup:vi.fn(),findPreferredSlot:vi.fn(),lockPreferredRows:vi.fn(),setPreferred:vi.fn(),review:vi.fn(),softDelete:vi.fn(),update:vi.fn(),findMany:vi.fn().mockResolvedValue({items:[],total:0}),findById:vi.fn()},villages); await expect(service.list('v',{})).rejects.toBeInstanceOf(NotFoundError); });
 it('returns 404 for missing details', async () => { const service=new PopulationService({preferredTransaction:vi.fn(),transaction:vi.fn(),findLatestVerified:vi.fn(),create:vi.fn(),findForUpdate:vi.fn(),findForDelete:vi.fn(),lockPreferredGroup:vi.fn(),findPreferredSlot:vi.fn(),lockPreferredRows:vi.fn(),setPreferred:vi.fn(),review:vi.fn(),softDelete:vi.fn(),update:vi.fn(),findMany:vi.fn(),findById:vi.fn().mockResolvedValue(null)},{ensureExists:vi.fn()}); await expect(service.getById('x')).rejects.toBeInstanceOf(NotFoundError); });
 it.each([{page:1,total:0},{page:3,total:1}])('returns empty page $page with total $total', async ({page,total}) => {
  const repository={preferredTransaction:vi.fn(),transaction:vi.fn(),findLatestVerified:vi.fn(),create:vi.fn(),findForUpdate:vi.fn(),findForDelete:vi.fn(),lockPreferredGroup:vi.fn(),findPreferredSlot:vi.fn(),lockPreferredRows:vi.fn(),setPreferred:vi.fn(),review:vi.fn(),softDelete:vi.fn(),update:vi.fn(),findMany:vi.fn().mockResolvedValue({items:[],total}),findById:vi.fn()}; const villages={ensureExists:vi.fn().mockResolvedValue(undefined)};
  const result=await new PopulationService(repository,villages).list('v',{page,limit:500,sort:'population',order:'asc'});
  expect(repository.findMany).toHaveBeenCalledWith(expect.objectContaining({skip:(page-1)*100,take:100,sort:{field:'population',order:'asc'}}));
  expect(result).toEqual({items:[],meta:{page,limit:100,total,totalPages:total?1:0,hasNextPage:false,hasPrevPage:page>1}});
 });
 it('returns 404 for a missing or deleted village before querying records', async () => {
  const repository={preferredTransaction:vi.fn(),transaction:vi.fn(),findLatestVerified:vi.fn(),create:vi.fn(),findForUpdate:vi.fn(),findForDelete:vi.fn(),lockPreferredGroup:vi.fn(),findPreferredSlot:vi.fn(),lockPreferredRows:vi.fn(),setPreferred:vi.fn(),review:vi.fn(),softDelete:vi.fn(),update:vi.fn(),findMany:vi.fn(),findById:vi.fn()}; const villages={ensureExists:vi.fn().mockRejectedValue(new NotFoundError('Village not found'))};
  await expect(new PopulationService(repository,villages).list('v',{})).rejects.toBeInstanceOf(NotFoundError);
  expect(repository.findMany).not.toHaveBeenCalled();
 });
});
