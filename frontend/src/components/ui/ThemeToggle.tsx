// 深色 / 浅色切换按钮：编辑页顶栏和列表页导航共用；主题类由 App.tsx 挂在 <html> 上。
import { useEditor } from '../../store/editor';
import { IconMoon, IconSun } from './Icons';

export function ThemeToggle() {
  const theme = useEditor((s) => s.theme);
  const toggleTheme = useEditor((s) => s.toggleTheme);
  return (
    <button className="btn icon" onClick={toggleTheme} aria-label={theme === 'dark' ? '切换为浅色' : '切换为深色'} title={theme === 'dark' ? '切换为浅色界面' : '切换为深色界面（看画面颜色更准）'}>
      {theme === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}
