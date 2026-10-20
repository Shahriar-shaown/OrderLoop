import { Controller, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  routes,
  type Invitation,
  type InvitationSummary,
  type Member,
  type ParsedInput,
} from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { MembersService } from './members.service.js';

@Controller()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Endpoint(routes.listMembers)
  list(@Auth() auth: AuthContext): Promise<Member[]> {
    return this.members.list(auth);
  }

  @Endpoint(routes.inviteMember)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  invite(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.inviteMember>,
    @Req() req: AppRequest,
  ): Promise<Invitation> {
    return this.members.invite(auth, input.body, req.ip ?? null);
  }

  @Endpoint(routes.listInvitations)
  listInvitations(@Auth() auth: AuthContext): Promise<InvitationSummary[]> {
    return this.members.listInvitations(auth);
  }

  @Endpoint(routes.revokeInvitation)
  async revokeInvitation(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.revokeInvitation>,
    @Req() req: AppRequest,
  ): Promise<Record<string, never>> {
    await this.members.revokeInvitation(auth, input.params.id, req.ip ?? null);
    return {};
  }

  @Endpoint(routes.updateMember)
  update(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateMember>,
    @Req() req: AppRequest,
  ): Promise<Member> {
    return this.members.updateRole(auth, input.params.id, input.body, req.ip ?? null);
  }

  @Endpoint(routes.removeMember)
  async remove(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.removeMember>,
    @Req() req: AppRequest,
  ): Promise<Record<string, never>> {
    await this.members.remove(auth, input.params.id, req.ip ?? null);
    return {};
  }
}
