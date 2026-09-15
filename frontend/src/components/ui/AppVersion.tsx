import { APP_VERSION } from '../../lib/version';

/** HitGO 品牌字样旁的版本号（App 导航栏与编辑器顶栏共用）。 */
export function AppVersion() {
  return (
    <span className="app-version" title={`HitGO ${APP_VERSION}`}>
      {APP_VERSION}
    </span>
  );
}
