import { Controller, Req } from '@nestjs/common';
import { routes, type ParsedInput, type TenantInfo, type Workspace } from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { WorkspacesService } from './workspaces.service.js';

@Controller()
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Endpoint(routes.tenant)
  tenant(@Auth() auth: AuthContext): Promise<TenantInfo> {
    return this.workspaces.current(auth);
  }

  @Endpoint(routes.updateTenant)
  updateTenant(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateTenant>,
    @Req() req: AppRequest,
  ): Promise<TenantInfo> {
    return this.workspaces.update(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.listWorkspaces)
  list(@Auth() auth: AuthContext): Promise<Workspace[]> {
    return this.workspaces.list(auth);
  }

  @Endpoint(routes.createWorkspace)
  create(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.createWorkspace>,
    @Req() req: AppRequest,
  ): Promise<Workspace> {
    return this.workspaces.create(auth, input.body, req.ip ?? null);
  }
}
