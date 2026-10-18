import { Controller } from '@nestjs/common';
import { routes, type Dashboard, type ParsedInput } from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AuthContext } from '../common/endpoint.js';
import { DashboardService } from './dashboard.service.js';

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Endpoint(routes.getDashboard)
  get(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.getDashboard>,
  ): Promise<Dashboard> {
    return this.dashboard.get(auth, input.query.period);
  }
}
