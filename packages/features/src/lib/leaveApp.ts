import { Linking } from 'react-native';

/**
 * Send the person to another site in this tab (Meta's sign-in comes back to OrderLoop afterwards). On the web it is a
 * normal navigation; in the phone app it opens the browser.
 */
export function leaveApp(url: string): void {
  if (typeof window !== 'undefined' && typeof window.location?.assign === 'function')
    window.location.assign(url);
  else void Linking.openURL(url);
}
