import { Controller, Req } from '@nestjs/common';
import {
  routes,
  type AutomationRule,
  type AutomationRules,
  type Delivery,
  type DeliveryPage,
  type Notification,
  type NotificationPage,
  type NotificationPreferences,
  type MessagingConsents,
  type ParsedInput,
  type PushDevice,
  type ReadAllResult,
  type Run,
  type RunPage,
  type UnreadCount,
} from '@orderloop/contracts';
import { Auth, Endpoint, Input, type AppRequest, type AuthContext } from '../common/endpoint.js';
import { AutomationService } from './automation.service.js';
import { NotificationsService } from './notifications.service.js';

@Controller()
export class AutomationController {
  constructor(
    private readonly automation: AutomationService,
    private readonly notifications: NotificationsService,
  ) {}

  @Endpoint(routes.listAutomationRules)
  rules(@Auth() auth: AuthContext): Promise<AutomationRules> {
    return this.automation.listRules(auth);
  }

  @Endpoint(routes.updateAutomationRule)
  updateRule(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateAutomationRule>,
    @Req() req: AppRequest,
  ): Promise<AutomationRule> {
    return this.automation.updateRule(auth, input.params.kind, input.body, req.ip ?? null);
  }

  @Endpoint(routes.runAutomationRule)
  runRule(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.runAutomationRule>,
  ): Promise<Run> {
    return this.automation.runRule(auth, input.params.kind, input.body);
  }

  @Endpoint(routes.listAutomationRuns)
  runs(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listAutomationRuns>,
  ): Promise<RunPage> {
    return this.automation.listRuns(auth, input.query);
  }

  @Endpoint(routes.retryAutomationRun)
  retryRun(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.retryAutomationRun>,
  ): Promise<Run> {
    return this.automation.retryRun(auth, input.params.id);
  }

  @Endpoint(routes.listAutomationDeliveries)
  deliveries(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listAutomationDeliveries>,
  ): Promise<DeliveryPage> {
    return this.automation.listDeliveries(auth, input.query);
  }

  @Endpoint(routes.retryAutomationDelivery)
  retryDelivery(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.retryAutomationDelivery>,
  ): Promise<Delivery> {
    return this.automation.retryDelivery(auth, input.params.id);
  }

  // ---- the caller's own notifications ----------------------------------------------------------------------------------

  @Endpoint(routes.listNotifications)
  list(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.listNotifications>,
  ): Promise<NotificationPage> {
    return this.notifications.list(auth, input.query);
  }

  @Endpoint(routes.getUnreadNotificationCount)
  unread(@Auth() auth: AuthContext): Promise<UnreadCount> {
    return this.notifications.unreadCount(auth);
  }

  @Endpoint(routes.markNotificationRead)
  read(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.markNotificationRead>,
  ): Promise<Notification> {
    return this.notifications.markRead(auth, input.params.id);
  }

  @Endpoint(routes.markAllNotificationsRead)
  readAll(@Auth() auth: AuthContext): Promise<ReadAllResult> {
    return this.notifications.markAllRead(auth);
  }

  @Endpoint(routes.getNotificationPreferences)
  preferences(@Auth() auth: AuthContext): Promise<NotificationPreferences> {
    return this.notifications.getPreferences(auth);
  }

  @Endpoint(routes.updateNotificationPreferences)
  updatePreferences(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateNotificationPreferences>,
  ): Promise<NotificationPreferences> {
    return this.notifications.updatePreferences(auth, input.body);
  }

  @Endpoint(routes.registerPushDevice)
  registerDevice(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.registerPushDevice>,
  ): Promise<PushDevice> {
    return this.notifications.registerDevice(auth, input.body);
  }

  @Endpoint(routes.removePushDevice)
  removeDevice(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.removePushDevice>,
  ): Promise<Record<string, never>> {
    return this.notifications.removeDevice(auth, input.params.token);
  }

  @Endpoint(routes.getMessagingConsents)
  consents(@Auth() auth: AuthContext): Promise<MessagingConsents> {
    return this.notifications.getConsents(auth);
  }

  @Endpoint(routes.updateMessagingConsent)
  updateConsent(
    @Auth() auth: AuthContext,
    @Input() input: ParsedInput<typeof routes.updateMessagingConsent>,
    @Req() req: AppRequest,
  ): Promise<MessagingConsents> {
    return this.notifications.updateConsent(auth, input.body, req.ip ?? null);
  }
}
