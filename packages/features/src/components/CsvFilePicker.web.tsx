import { Button, Text, Row } from '@orderloop/ui';
import { createElement, useRef, useState } from 'react';

/** "Choose CSV file": reads the file in the browser and hands its text over, so it can be checked like pasted text. */
export function CsvFilePicker({ onText }: { onText: (text: string, filename: string) => void }) {
  const input = useRef<{ click(): void; value: string } | null>(null);
  const [name, setName] = useState('');
  return (
    <Row gap={3} align="center" wrap>
      <Button variant="secondary" icon="upload" onPress={() => input.current?.click()}>
        Choose CSV file
      </Button>
      <Text tone="muted" variant="small">
        {name || 'No file chosen'}
      </Text>
      {createElement('input', {
        ref: input,
        type: 'file',
        accept: '.csv,text/csv',
        'aria-label': 'CSV file',
        style: { display: 'none' },
        onChange: async (event: {
          target: { files: ArrayLike<{ name: string; text(): Promise<string> }> | null };
        }) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setName(file.name);
          onText(await file.text(), file.name);
          if (input.current) input.current.value = '';
        },
      })}
    </Row>
  );
}
