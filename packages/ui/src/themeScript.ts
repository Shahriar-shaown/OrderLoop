// No imports on purpose: server code (the web layout) loads this on its own, without the component library.

/** Where the web remembers the choice (read by themeInitScript before the page paints, so there is no flash). */
export const THEME_STORAGE_KEY = 'ol-theme';

/** Run in <head> before first paint: applies a saved light/dark choice at once. Safe when storage is blocked. */
export const themeInitScript = `try{var p=localStorage.getItem('${THEME_STORAGE_KEY}');if(p==='light'||p==='dark')document.documentElement.dataset.scheme=p}catch(e){}`;
