import { createContext, useContext } from 'react';

/**
 * How shared components move between screens, without knowing the router. The web app implements it with Next's router
 * and the mobile app with expo-router; `Link`, `Tabs` and every screen call it through `useNavigation()`.
 */
export interface Navigation {
  /** The current path, for example `/products/123` (used to highlight the active menu item). */
  pathname: string;
  push(href: string): void;
  replace(href: string): void;
  back(): void;
}

export const NavigationContext = createContext<Navigation | null>(null);

export function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (!navigation)
    throw new Error('Navigation is missing: wrap the app in <NavigationContext.Provider>');
  return navigation;
}
