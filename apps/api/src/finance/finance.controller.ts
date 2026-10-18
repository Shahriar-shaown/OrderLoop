import { Controller, Req } from '@nestjs/common';
import {
  routes,
  type Discrepancy,
  type FinanceSummary,
  type ManualCost,
  type OutstandingCod,
  type ParsedInput,
  type SettlementBatch,
  type SettlementBatchDetail,
  type SettlementImportResult,
  type SettlementItem,
  type SettlementItemDetail,
} from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { FinanceService } from './finance.service.js';
import { SettlementsService } from './settlements.service.js';

@Controller()
export class FinanceController {
  constructor(
    private readonly settlements: SettlementsService,
    private readonly finance: FinanceService,
  ) {}

  @Endpoint(routes.importSettlement)
  import(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.importSettlement>,
    @Req() req: AppRequest,
  ): Promise<SettlementImportResult> {
    return this.settlements.import(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.listSettlementBatches)
  batches(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listSettlementBatches>,
  ): Promise<SettlementBatch[]> {
    return this.settlements.listBatches(auth, input.query.provider);
  }

  @Endpoint(routes.getSettlementBatch)
  batch(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getSettlementBatch>,
  ): Promise<SettlementBatchDetail> {
    return this.settlements.getBatch(auth, input.params.id);
  }

  @Endpoint(routes.reconcileSettlementBatch)
  reconcile(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.reconcileSettlementBatch>,
    @Req() req: AppRequest,
  ): Promise<SettlementBatchDetail> {
    return this.settlements.reconcile(auth, input.params.id, req.ip ?? null);
  }

  @Endpoint(routes.listUnmatchedSettlementItems)
  unmatched(@Auth() auth: AuthContext): Promise<SettlementItem[]> {
    return this.settlements.listUnmatched(auth);
  }

  @Endpoint(routes.getSettlementItem)
  item(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getSettlementItem>,
  ): Promise<SettlementItemDetail> {
    return this.settlements.getItem(auth, input.params.id);
  }

  @Endpoint(routes.matchSettlementItem)
  match(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.matchSettlementItem>,
    @Req() req: AppRequest,
  ): Promise<SettlementItemDetail> {
    return this.settlements.match(auth, input.params.id, input.body, req.ip ?? null);
  }

  @Endpoint(routes.unmatchSettlementItem)
  unmatch(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.unmatchSettlementItem>,
    @Req() req: AppRequest,
  ): Promise<SettlementItemDetail> {
    return this.settlements.unmatch(auth, input.params.id, input.body.reason, req.ip ?? null);
  }

  @Endpoint(routes.ignoreSettlementItem)
  ignore(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.ignoreSettlementItem>,
    @Req() req: AppRequest,
  ): Promise<SettlementItemDetail> {
    return this.settlements.ignore(auth, input.params.id, input.body.reason, req.ip ?? null);
  }

  @Endpoint(routes.listDiscrepancies)
  discrepancies(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listDiscrepancies>,
  ): Promise<Discrepancy[]> {
    return this.finance.listDiscrepancies(auth, input.query.status);
  }

  @Endpoint(routes.resolveDiscrepancy)
  resolve(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.resolveDiscrepancy>,
    @Req() req: AppRequest,
  ): Promise<Discrepancy> {
    return this.finance.resolveDiscrepancy(auth, input.params.id, input.body, req.ip ?? null);
  }

  @Endpoint(routes.recheckFinance)
  recheck(@Auth() auth: AuthContext) {
    return this.finance.recheck(auth);
  }

  @Endpoint(routes.getOutstandingCod)
  outstanding(@Auth() auth: AuthContext): Promise<OutstandingCod> {
    return this.finance.getOutstanding(auth);
  }

  @Endpoint(routes.getFinanceSummary)
  summary(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getFinanceSummary>,
  ): Promise<FinanceSummary> {
    return this.finance.getSummary(auth, input.query);
  }

  @Endpoint(routes.listCosts)
  costs(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listCosts>,
  ): Promise<ManualCost[]> {
    return this.finance.listCosts(auth, input.query);
  }

  @Endpoint(routes.createCost)
  createCost(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.createCost>,
    @Req() req: AppRequest,
  ): Promise<ManualCost> {
    return this.finance.createCost(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.voidCost)
  voidCost(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.voidCost>,
    @Req() req: AppRequest,
  ): Promise<ManualCost> {
    return this.finance.voidCost(auth, input.params.id, input.body.reason, req.ip ?? null);
  }
}
