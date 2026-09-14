import { useState, type FormEvent } from 'react';
import { api } from '../api';

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.authLogin(code.trim());
      const r = await api.authStatus();
      if (r.required && !r.ok) throw new Error('访问码无效');
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : '访问码无效');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card form-col" onSubmit={submit}>
        <div className="brand" style={{ fontSize: 18 }}>
          Hit<b>GO</b>
        </div>
        <div className="muted">请输入访问码以继续</div>
        <label className="field">
          访问码
          <input className="input" type="password" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        {error && <div className="error-text">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy || !code.trim()}>
          {busy ? '验证中…' : '进入'}
        </button>
      </form>
    </div>
  );
}
