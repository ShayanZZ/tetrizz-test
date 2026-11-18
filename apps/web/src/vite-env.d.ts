declare const __APP_VERSION__: string;
declare const __NETWORK_CONFIG__: unknown;

declare module "*?worker&inline" {
  const BotWorker: new (options?: { name?: string }) => Worker;
  export default BotWorker;
}
