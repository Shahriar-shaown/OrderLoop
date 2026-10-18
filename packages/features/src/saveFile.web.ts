/** Download a text file in the browser. */
export async function saveTextFile(
  filename: string,
  text: string,
  mime = 'text/csv',
): Promise<void> {
  // A byte-order mark makes Excel read UTF-8 (Bangla names, the taka sign) correctly.
  const blob = new Blob(['﻿', text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
