import { Controller } from '@nestjs/common';
import { routes, type ImportJob, type ParsedInput } from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AuthContext } from '../common/endpoint.js';
import { ImportsService } from './imports.service.js';

@Controller()
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

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
