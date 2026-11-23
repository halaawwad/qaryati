import { AppError, NotFoundError } from '../../shared/errors.js';

export function villageNotFound(): NotFoundError {
  return new NotFoundError('Village not found');
}

export function versionConflict(currentVersion: number, entity = 'village'): AppError {
  return new AppError(409, 'VERSION_CONFLICT', `The ${entity} was changed by someone else; reload it and retry`, [
    { field: 'version', message: `Current version is ${currentVersion}` },
  ]);
}

export function unprocessable(code: string, field: string, message: string): AppError {
  return new AppError(422, code, message, [{ field, message }]);
}
