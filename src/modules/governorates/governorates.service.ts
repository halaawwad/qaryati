import { NotFoundError } from '../../shared/errors.js';
import {
  governorateRepository,
  type GovernorateDetails,
  type GovernorateRepository,
  type GovernorateSummary,
  type LocalAuthoritySummary,
} from './governorates.repository.js';
import type { LocalAuthoritiesQuery } from './governorates.schemas.js';

export class GovernorateService {
  constructor(private readonly repository: GovernorateRepository = governorateRepository) {}

  list(): Promise<GovernorateSummary[]> {
    return this.repository.findAll();
  }

  async getById(id: string): Promise<GovernorateDetails> {
    const governorate = await this.repository.findById(id);
    if (!governorate) {
      throw new NotFoundError('Governorate not found');
    }

    return governorate;
  }

  async listLocalAuthorities(governorateId: string, query: LocalAuthoritiesQuery): Promise<LocalAuthoritySummary[]> {
    const localAuthorities = await this.repository.findLocalAuthorities(governorateId, { type: query.type });
    if (!localAuthorities) {
      throw new NotFoundError('Governorate not found');
    }

    return localAuthorities;
  }
}

export const governorateService = new GovernorateService();
