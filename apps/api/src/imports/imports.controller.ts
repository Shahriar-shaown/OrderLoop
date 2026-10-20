import { Controller } from '@nestjs/common';
import { routes, type ImportJob, type ImportPreview, type ParsedInput } from '@orderloop/contracts';
import { LoginThrottleService } from '../auth/login-throttle.service.js';
import { Auth, Endpoint, Input, type AuthContext } from '../common/endpoint.js';
import { ImportsService } from './imports.service.js';

@Controller()
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly throttle: LoginThrottleService,
  ) {}

  @Endpoint(routes.validateProductImport)
  async validate(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.validateProductImport>,
  ): Promise<ImportPreview> {
    // Validating parses a whole file: a per-business budget, however many users or IPs it comes from.
    await this.throttle.enforce('import-validate', auth.tenantId, 5, 60);
    return this.imports.validate(auth, input.body);
  }

  @Endpoint(routes.importProducts)
  create(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.importProducts>,
  ): Promise<ImportJob> {
    return this.imports.create(auth, input.body);
  }

  @Endpoint(routes.getImport)
  get(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getImport>,
  ): Promise<ImportJob> {
    return this.imports.get(auth, input.params.id);
  }

  @Endpoint(routes.listImports)
  list(@Auth() auth: AuthContext): Promise<ImportJob[]> {
    return this.imports.list(auth);
  }
}
