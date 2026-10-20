import { CreateWorkspaceBody } from '@orderloop/contracts';
import {
  Button,
  FieldGrid,
  Form,
  PageHeader,
  Section,
  Stack,
  StickyActions,
  useNavigation,
  useToast,
} from '@orderloop/ui';
import { View } from 'react-native';
import { FormError } from '../../forms/FormError';
import { FormSelectField } from '../../forms/FormSelectField';
import { FormTextField } from '../../forms/FormTextField';
import { useZodForm } from '../../forms/zodForm';
import {
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  useSwitchWorkspace,
} from '../../lib/workspaces';
import { useRuntime } from '../../core/runtime';

/** Start another business. You become its owner and are taken into it. */
export function WorkspaceCreateScreen() {
  const { api } = useRuntime();
  const navigation = useNavigation();
  const toast = useToast();
  const switchTo = useSwitchWorkspace();
  const form = useZodForm(CreateWorkspaceBody, {
    name: '',
    currency: 'BDT',
    timezone: 'Asia/Dhaka',
    defaultLanguage: 'en',
  });

  const submit = form.submit(async (data) => {
    const created = await api.workspaces.create(data);
    await switchTo(created.id);
    toast.success(`${created.name} is ready`);
    navigation.replace('/settings');
  });

  return (
    <Stack gap={5}>
      <PageHeader
        title="New business"
        description="Each business has its own products, stock and team. You will be its owner."
        breadcrumbs={[{ label: 'Your businesses', href: '/workspaces' }, { label: 'New business' }]}
      />
      <View style={{ maxWidth: 720, width: '100%' }}>
        <Form onSubmit={submit}>
          <FormError message={form.formError} />
          <Section title="Business details" description="You can change these later in Settings.">
            <FormTextField
              control={form.control}
              name="name"
              label="Business name"
              autoComplete="organization"
              required
            />
            <FieldGrid minWidth={180}>
              <FormSelectField
                control={form.control}
                name="currency"
                label="Currency"
                options={CURRENCY_OPTIONS}
              />
              <FormSelectField
                control={form.control}
                name="timezone"
                label="Time zone"
                options={TIMEZONE_OPTIONS}
              />
              <FormSelectField
                control={form.control}
                name="defaultLanguage"
                label="Business language"
                options={LANGUAGE_OPTIONS}
              />
            </FieldGrid>
          </Section>
          <StickyActions>
            <Button type="submit" icon="plus" loading={form.formState.isSubmitting}>
              Create business
            </Button>
            <Button variant="secondary" href="/workspaces">
              Cancel
            </Button>
          </StickyActions>
        </Form>
      </View>
    </Stack>
  );
}
