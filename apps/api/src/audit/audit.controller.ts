import { Controller } from '@nestjs/common';
import { routes, type AuditPage, type ParsedInput } from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AuthContext } from '../common/endpoint.js';
import { AuditService } from './audit.service.js';

@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Endpoint(routes.listAuditLogs)
  list(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listAuditLogs>,
  ): Promise<AuditPage> {
    return this.audit.list(auth.tenantId, input.query);
  }
}
