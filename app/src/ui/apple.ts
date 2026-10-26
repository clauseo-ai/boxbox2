/* whether this device is apple's: its shortcuts are the command key's (⌘), shown and named as Meta; elsewhere the control
   key's, and no ⌘ hint shows */
export const APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
