declare module 'win-ca' {
  interface WinCaOptions {
    fallback?: boolean;
    inject?: string | boolean;
  }
  function winca(options?: WinCaOptions): void;
  export default winca;
}
