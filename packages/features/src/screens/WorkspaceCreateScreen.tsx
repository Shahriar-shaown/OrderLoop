import { CreateWorkspaceBody } from '@orderloop/contracts';
import { Button, Form, PageHeader, Stack, useNavigation, useToast } from '@orderloop/ui';
import { FormError } from '../components/FormError';
import { FormSelectField } from '../components/FormSelectField';
import { FormTextField } from '../components/FormTextField';
import { useZodForm } from '../zodForm';
import {
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  useSwitchWorkspace,
} from '../workspaces';
import { useRuntime } from '../runtime';

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
      />
      <Form onSubmit={submit}>
        <FormError message={form.formError} />
        <FormTextField
          control={form.control}
          name="name"
          label="Business name"
          autoComplete="organization"
          required
        />
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
        <Button type="submit" loading={form.formState.isSubmitting}>
          Create business
        </Button>
      </Form>
    </Stack>
  );
}
