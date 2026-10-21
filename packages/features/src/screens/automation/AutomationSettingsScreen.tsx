import { AUTOMATION_KINDS } from '@orderloop/contracts';
import { Alert, EmptyState, PageHeader, Stack, Text } from '@orderloop/ui';
import { RecentProblems } from '../../components/automation/RecentProblems';
import { RuleCard } from '../../components/automation/RuleCard';
import { useCan } from '../../core/permissions';
import { useAutomationRules } from '../../lib/automation';
import { QueryBoundary } from '../../shell/QueryBoundary';

/**
 * Automation: which alerts the business sends, when, and through which channels. People who may read it see how it is set up;
 * people who may manage it change it, run a rule now, and retry what failed.
 */
export function AutomationSettingsScreen() {
  const can = useCan();
  const allowed = can('automation:read');
  const canManage = can('automation:manage');
  const query = useAutomationRules(allowed);

  if (!allowed)
    return (
      <Stack gap={5}>
        <PageHeader title="Automation" />
        <EmptyState icon="shield" title="You do not have access to automation">
          Ask an owner or admin if you need to see how alerts are set up. You can still choose which
          alerts you receive in Notification preferences.
        </EmptyState>
      </Stack>
    );

  const providers = query.data?.providers;
  const order = (kind: (typeof AUTOMATION_KINDS)[number]) => AUTOMATION_KINDS.indexOf(kind);
  return (
    <Stack gap={5}>
      <PageHeader
        title="Automation"
        description="Choose which alerts OrderLoop sends for this business, when, and how. Each person can still turn channels off for themselves."
      />
      {canManage ? null : (
        <Alert tone="info">
          Only an owner or admin can change automation. You can see how it is set up.
        </Alert>
      )}
      {providers?.push === 'dev' ? (
        <Alert tone="warning" title="Push is in test mode on this server">
          Push alerts are recorded but not delivered to phones until the server is set up for it.
        </Alert>
      ) : null}
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading automation">
        {providers ? (
          <Stack gap={4}>
            {[...(query.data?.rules ?? [])]
              .sort((a, b) => order(a.kind) - order(b.kind))
              .map((rule) => (
                <RuleCard key={rule.kind} rule={rule} providers={providers} canManage={canManage} />
              ))}
            <RecentProblems canManage={canManage} />
          </Stack>
        ) : (
          <Text tone="muted">Nothing to show.</Text>
        )}
      </QueryBoundary>
    </Stack>
  );
}
