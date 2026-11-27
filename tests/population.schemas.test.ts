import { describe, expect, it } from 'vitest';
import { listPopulationQuerySchema, populationParamsSchema } from '../src/modules/population/population.schemas.js';
describe('population schemas', () => {
 it('parses false and years', () => expect(listPopulationQuerySchema.parse({referenceYear:'2021',isEstimate:'false',isPreferred:'true'})).toEqual({referenceYear:2021,isEstimate:false,isPreferred:true}));
 it('accepts historical and future integer years', () => expect(listPopulationQuerySchema.parse({referenceYear:'1799'}).referenceYear).toBe(1799));
 it('parses all false flags and exact source and status filters', () => {
  const sourceId = '11111111-1111-4111-8111-111111111111';
  expect(listPopulationQuerySchema.parse({isEstimate:'false',isPreferred:'false',needsReview:'false',sourceId,verificationStatus:'VERIFIED'})).toEqual({isEstimate:false,isPreferred:false,needsReview:false,sourceId,verificationStatus:'VERIFIED'});
 });
 it('accepts the largest offset after the limit cap and rejects the next', () => {
  expect(listPopulationQuerySchema.safeParse({page:'2147483648',limit:'1'}).success).toBe(true);
  expect(listPopulationQuerySchema.safeParse({page:'2147483649',limit:'1'}).success).toBe(false);
  expect(listPopulationQuerySchema.safeParse({page:'21474837',limit:'1000'}).success).toBe(true);
  expect(listPopulationQuerySchema.safeParse({page:'21474838',limit:'1000'}).success).toBe(false);
 });
 it.each([{referenceYear:''},{referenceYear:'2147483648'},{referenceYear:'-2147483649'},{referenceYear:'2000.5'},{sourceId:'bad'},{needsReview:'yes'},{page:'0'},{page:'2147483649',limit:'1'},{sort:'notes'}])('rejects %j', q => expect(listPopulationQuerySchema.safeParse(q).success).toBe(false));
 it('rejects invalid ids', () => expect(populationParamsSchema.safeParse({id:'bad'}).success).toBe(false));
 it.each([
  [{includeAll:'true'},{includeAll:true}], [{includeAll:'false',isPreferred:'true'},{includeAll:false,isPreferred:true}],
  [{includeAll:'false',isPreferred:'false'},{includeAll:false,isPreferred:false}],
  [{includeAll:'false',unknown:'ignored'},{includeAll:false}],
 ])('parses preference query %j', (input,expected)=>expect(listPopulationQuerySchema.parse(input)).toEqual(expected));
 it.each([{includeAll:'true',isPreferred:'true'},{includeAll:'true',isPreferred:'false'},{includeAll:'yes'},{includeAll:'TRUE'},{isPreferred:'1'}])('rejects conflicting or invalid preference query %j',input=>expect(listPopulationQuerySchema.safeParse(input).success).toBe(false));
 it.each([
  {includeAll:['true','false']}, {includeAll:['true','true']},
  {isPreferred:['true','false']}, {isPreferred:['false','false']},
 ])('rejects repeated preference values %j',input=>expect(listPopulationQuerySchema.safeParse(input).success).toBe(false));
});
