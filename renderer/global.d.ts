import type { WisperApi } from '../electron/preload';

declare global {
  interface Window {
    wisper: WisperApi;
  }
}
export {};
