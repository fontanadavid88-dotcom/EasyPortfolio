declare module "vitest" {
  export const beforeEach: (...args: any[]) => void;
  export const describe: (...args: any[]) => void;
  export const it: (...args: any[]) => void;
  export const expect: any;
  export const afterEach: (...args: any[]) => void;
  export const vi: any;
}
