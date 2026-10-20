import { Button, Row, useToast, type MenuItem } from '@orderloop/ui';
import { useState } from 'react';
import { messageFor } from '../forms/errors';
import { useCan } from '../core/permissions';
import { useApi } from '../core/runtime';
import { saveTextFile } from '../lib/saveFile';

type Kind = 'products' | 'stock';
const LABEL: Record<Kind, string> = { products: 'Export catalog CSV', stock: 'Export stock CSV' };

/** Downloading the catalog or the stock levels as CSV; only for what the person's role may read. Shared by the buttons and menus. */
export function useCsvExport(kinds: Kind[]) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const [busy, setBusy] = useState<Kind | null>(null);

  async function run(kind: Kind) {
    setBusy(kind);
    try {
      const file = kind === 'products' ? await api.exports.products() : await api.exports.stock();
      await saveTextFile(file.filename, file.csv);
      toast.success(`${file.filename}: ${file.rowCount} rows`);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(null);
    }
  }

  const allowed = kinds.filter((k) => can(k === 'products' ? 'catalog:read' : 'inventory:read'));
  return {
    busy,
    kinds: allowed,
    run,
    label: (k: Kind) => LABEL[k],
    /** The same exports as entries for a `Menu`. */
    menuItems: (): MenuItem[] =>
      allowed.map((k) => ({
        key: `export-${k}`,
        label: LABEL[k],
        icon: 'download' as const,
        disabled: busy !== null,
        onPress: () => void run(k),
      })),
  };
}

/** Download the catalog or the stock levels as CSV. Only offered for what the person's role may read. */
export function ExportButtons({ kinds }: { kinds: Kind[] }) {
  const exporter = useCsvExport(kinds);
  return (
    <Row gap={2} wrap>
      {exporter.kinds.map((k) => (
        <Button
          key={k}
          variant="secondary"
          icon="download"
          loading={exporter.busy === k}
          onPress={() => exporter.run(k)}
        >
          {exporter.label(k)}
        </Button>
      ))}
    </Row>
  );
}
