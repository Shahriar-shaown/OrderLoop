/** Native apps have no file chooser here: the CSV is pasted instead. (CsvFilePicker.web.tsx is the browser's file input.) */
export function CsvFilePicker(props: { onText: (text: string, filename: string) => void }) {
  void props;
  return null;
}
