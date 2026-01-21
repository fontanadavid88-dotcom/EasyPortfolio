declare module "vitest" {
  export const describe: (...args: any[]) => void;
  export const it: (...args: any[]) => void;
  export const expect: any;
}
