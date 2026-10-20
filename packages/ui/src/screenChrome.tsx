import { createContext, useContext, type ReactNode } from 'react';

interface ScreenChrome {
  titleInBar: boolean;
  /** Tells the native bar what the screen is called (the screen knows more than its route does: "#1003", a customer's name). */
  setTitle?: (title: string) => void;
}

/**
 * Set by a native app around a screen whose title is shown in the native navigation bar: the screen's own title and
 * breadcrumbs are then left out (the bar has them, with the back button), while its description and actions stay, and the
 * title it would have shown is handed to the bar.
 */
const ScreenChromeContext = createContext<ScreenChrome>({ titleInBar: false });

export function ScreenChromeProvider({
  titleInBar,
  onTitle,
  children,
}: {
  titleInBar: boolean;
  onTitle?: (title: string) => void;
  children: ReactNode;
}) {
  return (
    <ScreenChromeContext.Provider value={{ titleInBar, ...(onTitle ? { setTitle: onTitle } : {}) }}>
      {children}
    </ScreenChromeContext.Provider>
  );
}
export const useScreenChrome = () => useContext(ScreenChromeContext);
