import { InsufficientStockError, StockLimitError, StockTargetError } from '@orderloop/catalog';
import { ApiError } from './api-error.js';

/** Translate the stock layer's failures into the API's stable error codes. Anything else is rethrown untouched. */
export function mapStockError(error: unknown): never {
  if (error instanceof InsufficientStockError)
    throw new ApiError(
      409,
      'insufficient_stock',
      `Only ${error.available} available, ${error.requested} requested`,
    );
  if (error instanceof StockTargetError) throw ApiError.notFound(error.message);
  if (error instanceof StockLimitError) throw ApiError.conflict(error.message);
  throw error;
}
