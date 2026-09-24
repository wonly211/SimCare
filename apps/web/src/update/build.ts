export interface BuildInfo {
  version: string;
  buildId: string;
}
declare const __SIMCARE_BUILD__: BuildInfo;
export const currentBuild: BuildInfo =
  typeof __SIMCARE_BUILD__ === 'undefined'
    ? { version: 'development', buildId: 'development' }
    : __SIMCARE_BUILD__;
export function isBuildInfo(value: unknown): value is BuildInfo {
  return (
    !!value &&
    typeof value === 'object' &&
    'version' in value &&
    typeof value.version === 'string' &&
    'buildId' in value &&
    typeof value.buildId === 'string' &&
    value.buildId.length > 0
  );
}
