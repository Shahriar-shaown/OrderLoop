import { Share } from 'react-native';

/**
 * Hand a text file to the person. On a phone that opens the share sheet (save to Files, send by email or chat);
 * the web version (saveFile.web.ts) downloads it.
 */
export async function saveTextFile(
  filename: string,
  text: string,
  mime = 'text/csv',
): Promise<void> {
  void mime;
  await Share.share({ title: filename, message: text });
}
