import { AppError } from '../../shared/errors.js';

export class GeoError extends AppError {
  constructor(code = 'GEO_UNAVAILABLE', message = 'Geographic lookup is temporarily unavailable', readonly transient = false) {
    super(503, code, message);
    // The shared development error handler may expose stacks; provider failures
    // must remain safe in every environment, without changing shared behavior.
    delete this.stack;
  }
}
