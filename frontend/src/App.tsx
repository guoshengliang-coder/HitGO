import { useCallback, useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import { LoginPage } from './pages/LoginPage';
import { BatchesPage } from './pages/BatchesPage';
import { AssetsPage } from './pages/AssetsPage';
import { EditorPage } from './pages/EditorPage';
import { AllOutputsPage } from './pages/AllOutputsPage';
import { useEditor } from './store/editor';
import { ThemeToggle } from './components/ui/ThemeToggle';
import { AppVersion } from './components/ui/AppVersion';

type AuthState = 'checking' | 'ok' | 'required';

function Shell() {
  return (
    <>
      <nav className="app-nav">
        <span className="brand-group">
          <NavLink to="/" className="brand">
            Hit<b>GO</b>
          </NavLink>
          <AppVersion />
        </span>
        <NavLink to="/" end className={({ isActive }) => `navlink ${isActive ? 'active' : ''}`}>
          批次
        </NavLink>
        <NavLink to="/assets" className={({ isActive }) => `navlink ${isActive ? 'active' : ''}`}>
          素材库
        </NavLink>
        <NavLink to="/outputs" className={({ isActive }) => `navlink ${isActive ? 'active' : ''}`}>
          产物
        </NavLink>
        <span className="spacer" />
        <ThemeToggle />
      </nav>
      <Outlet />
    </>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>('checking');
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useEditor((s) => s.theme);

  // 主题类挂在 <html> 上：body 背景、原生控件（color-scheme）和所有页面一起生效
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const check = useCallback(async () => {
    try {
      const r = await api.authStatus();
      setAuth(r.required && !r.ok ? 'required' : 'ok');
    } catch {
      setAuth('ok');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    if (auth === 'required' && location.pathname !== '/login') navigate('/login', { replace: true });
  }, [auth, location.pathname, navigate]);

  if (auth === 'checking') return <div className="empty">加载中…</div>;

  return (
    <Routes>
      <Route
        path="/login"
        element={
          auth === 'ok' ? (
            <Navigate to="/" replace />
          ) : (
            <LoginPage
              onSuccess={() => {
                setAuth('ok');
                navigate('/', { replace: true });
              }}
            />
          )
        }
      />
      <Route element={<Shell />}>
        <Route path="/" element={<BatchesPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/outputs" element={<AllOutputsPage />} />
        <Route path="/batches/:id/outputs" element={<LegacyBatchOutputs />} />
      </Route>
      <Route path="/batches/:id" element={<EditorPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** 旧的批次「已回传」页地址，HIG-28 起并入产物页；保留跳转，书签和外部链接不失效。 */
function LegacyBatchOutputs() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={id ? `/outputs?batch=${encodeURIComponent(id)}` : '/outputs'} replace />;
}
