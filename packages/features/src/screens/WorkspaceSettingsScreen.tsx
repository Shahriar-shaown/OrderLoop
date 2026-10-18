import type { Language, TenantInfo } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  FieldGrid,
  Form,
  PageHeader,
  Row,
  Section,
  SelectField,
  Stack,
  Text,
  useNavigation,
  useToast,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth';
import { FormError } from '../components/FormError';
import { FormSelectField } from '../components/FormSelectField';
import { FormTextField } from '../components/FormTextField';
import { QueryBoundary } from '../components/QueryBoundary';
import { messageFor } from '../errors';
import { useCan } from '../permissions';
import { useRuntime } from '../runtime';
import {
  BusinessProfileForm,
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  useBusiness,
  type BusinessProfileValues,
} from '../workspaces';
import { useZodForm } from '../zodForm';

const toValues = (t: TenantInfo): BusinessProfileValues => ({
  name: t.name,
  logoUrl: t.logoUrl ?? '',
  contactEmail: t.contactEmail ?? '',
  contactPhone: t.contactPhone ?? '',
  addressLine1: t.addressLine1 ?? '',
  addressLine2: t.addressLine2 ?? '',
  city: t.city ?? '',
  district: t.district ?? '',
  postalCode: t.postalCode ?? '',
  country: t.country,
  currency: t.currency,
  timezone: t.timezone,
  defaultLanguage: t.defaultLanguage,
});

function ProfileForm({ business, canEdit }: { business: TenantInfo; canEdit: boolean }) {
  const { api, session: manager } = useRuntime();
  const toast = useToast();
  const queryClient = useQueryClient();
  const form = useZodForm(BusinessProfileForm, toValues(business));
  const editable = canEdit;

  useEffect(() => {
    form.reset(toValues(business));
  }, [business]);

  const submit = form.submit(async (data) => {
    const updated = await api.updateTenant(data);
    queryClient.setQueryData(['tenant', updated.id], updated);
    await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    await manager.refresh();
    toast.success('Business settings saved');
  });

  return (
    <Form onSubmit={submit}>
      <FormError message={form.formError} />
      <Section title="Business profile" description="Shown to your team and used on documents.">
        <FormTextField
          control={form.control}
          name="name"
          label="Business name"
          required
          editable={editable}
        />
        <FormTextField
          control={form.control}
          name="logoUrl"
          label="Logo link"
          kind="text"
          autoCapitalize="none"
          editable={editable}
          hint="A link to your logo image, starting with https://"
        />
      </Section>
      <Section title="Contact" description="How customers and couriers can reach the business.">
        <FieldGrid>
          <FormTextField
            control={form.control}
            name="contactEmail"
            label="Contact email"
            kind="email"
            editable={editable}
          />
          <FormTextField
            control={form.control}
            name="contactPhone"
            label="Contact phone"
            editable={editable}
            keyboardType="phone-pad"
            hint="For example +880 1712-345678"
          />
        </FieldGrid>
      </Section>
      <Section title="Address">
        <FormTextField
          control={form.control}
          name="addressLine1"
          label="Address line 1"
          editable={editable}
        />
        <FormTextField
          control={form.control}
          name="addressLine2"
          label="Address line 2"
          editable={editable}
        />
        <FieldGrid>
          <FormTextField control={form.control} name="city" label="City" editable={editable} />
          <FormTextField
            control={form.control}
            name="district"
            label="District"
            editable={editable}
          />
          <FormTextField
            control={form.control}
            name="postalCode"
            label="Postal code"
            editable={editable}
          />
        </FieldGrid>
      </Section>
      <Section
        title="Regional settings"
        description="Amounts are shown in this currency and dates in this time zone."
      >
        <FieldGrid>
          <FormSelectField
            control={form.control}
            name="currency"
            label="Currency"
            options={CURRENCY_OPTIONS}
            disabled={!editable}
          />
          <FormSelectField
            control={form.control}
            name="timezone"
            label="Time zone"
            options={TIMEZONE_OPTIONS}
            disabled={!editable}
          />
          <FormSelectField
            control={form.control}
            name="defaultLanguage"
            label="Business language"
            options={LANGUAGE_OPTIONS}
            disabled={!editable}
          />
        </FieldGrid>
      </Section>
      {editable ? (
        <Button type="submit" loading={form.formState.isSubmitting}>
          Save changes
        </Button>
      ) : (
        <Alert tone="info">Only an owner or admin can change business settings.</Alert>
      )}
    </Form>
  );
}

/** The person's own language, separate from the business setting: it follows them into every business. */
function MyPreferences() {
  const { api, session: manager } = useRuntime();
  const { session } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  if (!session) return null;

  async function change(language: string) {
    setSaving(true);
    try {
      await api.updatePreferences(language as Language);
      await manager.refresh();
      toast.success('Language saved');
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Section
      title="Your preferences"
      description="Saved to your account. Screen translations are rolling out; your choice will apply as they arrive."
    >
      <SelectField
        label="Your language"
        value={session.user.language}
        onChange={change}
        options={LANGUAGE_OPTIONS}
        disabled={saving}
      />
    </Section>
  );
}

export function WorkspaceSettingsScreen() {
  const can = useCan();
  const { session } = useAuth();
  const query = useBusiness();
  const navigation = useNavigation();
  return (
    <Stack gap={5}>
      <PageHeader
        title="Business settings"
        description="Profile, contact details and regional defaults for this business."
        actions={
          session ? (
            <Row gap={2} wrap>
              <Text tone="muted">Your role</Text>
              <Badge>{session.role.toLowerCase()}</Badge>
              <Button
                variant="secondary"
                size="sm"
                onPress={() => navigation.push('/workspaces/new')}
              >
                New business
              </Button>
            </Row>
          ) : undefined
        }
      />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading settings">
        {query.data ? <ProfileForm business={query.data} canEdit={can('tenant:update')} /> : null}
      </QueryBoundary>
      {can('couriers:read') && (
        <Section
          title="Couriers"
          description="Connect Pathao or Steadfast, or practise with the simulated courier."
        >
          <Row>
            <Button variant="secondary" href="/settings/couriers">
              Courier settings
            </Button>
          </Row>
        </Section>
      )}
      <MyPreferences />
    </Stack>
  );
}
