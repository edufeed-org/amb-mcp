/**
 * Type declarations for qrcode-terminal
 */

declare module 'qrcode-terminal' {
  interface Options {
    small?: boolean;
  }

  function generate(text: string, options?: Options, callback?: (qrcode?: string) => void): void;
  function generate(text: string, callback?: (qrcode?: string) => void): void;

  export { generate };
  export default { generate };
}
