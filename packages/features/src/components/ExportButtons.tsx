import { Button, Row, useToast } from '@orderloop/ui';
import { useState } from 'react';
import { messageFor } from '../errors';
import { useCan } from '../permissions';
import { useApi } from '../runtime';
import { saveTextFile } from '../saveFile';

type Kind = 'products' | 'stock';
const LABEL: Record<Kind, string> = { products: 'Export catalog CSV', stock: 'Export stock CSV' };

/** Download the catalog or the stock levels as CSV. Only offered for what the person's role may read. */
export function ExportButtons({ kinds }: { kinds: Kind[] }) {
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

  return (
    <Row gap={2} wrap>
      {kinds
        .filter((k) => can(k === 'products' ? 'catalog:read' : 'inventory:read'))
        .map((k) => (
          <Button key={k} variant="secondary" loading={busy === k} onPress={() => run(k)}>
            {LABEL[k]}
          </Button>
        ))}
    </Row>
  );
}
