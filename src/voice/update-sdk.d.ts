/** Optional SDK capability, loaded only when installing an update. */
declare module '@deepseek-ai/dsh-plugin-manager/operations' {
  export const runPluginCommand:import('./update-driver.js').RunUpdate;
}
