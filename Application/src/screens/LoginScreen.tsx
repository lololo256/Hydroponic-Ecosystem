import { useState } from 'react';
import { NavProps } from '../types';
import { useSmartFarm } from '../context/SmartFarmContext';
import { Eye, EyeOff, AlertCircle, ArrowLeft } from 'lucide-react';

export default function LoginScreen({ navigate }: NavProps) {
  const { loginWithEmail, showAlert } = useSmartFarm();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const handleEmailLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setErrorMessage('');

    if (!email.trim()) {
      setErrorMessage('กรุณากรอกอีเมล');
      return;
    }
    if (!password.trim()) {
      setErrorMessage('กรุณากรอกรหัสผ่าน');
      return;
    }

    setLoading(true);
    const result = await loginWithEmail(email, password);
    setLoading(false);

    if (result.success) {
      navigate('home');
    } else {
      setErrorMessage(result.error || 'เข้าสู่ระบบไม่สำเร็จ');
    }
  };

  const handleForgotPassword = () => {
    showAlert({
      title: 'รีเซ็ตรหัสผ่าน',
      message: 'กรุณาติดต่อผู้ดูแลระบบ ThingsBoard เพื่อดำเนินการรีเซ็ตรหัสผ่านของคุณ',
      variant: 'info',
    });
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f8fafc',
        display: 'flex',
        justifyContent: 'center',
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 400,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '48px 24px 32px',
          boxSizing: 'border-box',
        }}
      >
        <div>
          <button
            type="button"
            onClick={() => navigate('welcome')}
            disabled={loading}
            aria-label="กลับไปหน้า Hydroponic"
            style={{
              minWidth: 44,
              minHeight: 44,
              border: 'none',
              background: 'transparent',
              color: '#475569',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: 0,
              margin: '-28px 0 12px',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: 14,
            }}
          >
            <ArrowLeft size={18} strokeWidth={2} />
            <span>กลับ</span>
          </button>

          {/* Brand header */}
          <div style={{ marginBottom: 32 }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: '#ffffff',
                border: '2px solid rgba(16, 185, 129, 0.2)',
                boxShadow: '0 4px 14px rgba(16, 185, 129, 0.12)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 20,
                overflow: 'hidden',
              }}
            >
              <img
                src="/logo.png"
                alt="Hydroponic Ecosystem"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </div>
            <h1
              style={{
                fontSize: 22,
                fontWeight: 600,
                color: '#0f172a',
                margin: 0,
                letterSpacing: '-0.02em',
              }}
            >
              ยินดีต้อนรับกลับ
            </h1>
            <p style={{ fontSize: 13, color: '#64748b', margin: '6px 0 0' }}>
              เข้าสู่ระบบเพื่อดูแลฟาร์มของคุณ
            </p>
          </div>

          {/* Error notice */}
          {errorMessage && (
            <div
              style={{
                background: '#fef2f2',
                border: '1px solid #fee2e2',
                borderRadius: 12,
                padding: '12px 14px',
                marginBottom: 20,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: '#dc2626',
                fontSize: 13,
              }}
            >
              <AlertCircle size={16} strokeWidth={1.75} style={{ flexShrink: 0 }} />
              <span style={{ lineHeight: 1.4 }}>{errorMessage}</span>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleEmailLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: 12,
                  fontWeight: 500,
                  color: '#475569',
                  marginBottom: 6,
                }}
              >
                อีเมล
              </label>
              <input
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  borderRadius: 12,
                  border: '1px solid #cbd5e1',
                  background: '#ffffff',
                  fontSize: 14,
                  color: '#0f172a',
                  outline: 'none',
                  boxSizing: 'border-box',
                  transition: 'border-color 0.15s',
                }}
                onFocus={(e) => (e.target.style.borderColor = '#059669')}
                onBlur={(e) => (e.target.style.borderColor = '#cbd5e1')}
              />
            </div>

            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: 12,
                  fontWeight: 500,
                  color: '#475569',
                  marginBottom: 6,
                }}
              >
                รหัสผ่าน
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="อย่างน้อย 8 ตัวอักษร"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  style={{
                    width: '100%',
                    padding: '12px 42px 12px 14px',
                    borderRadius: 12,
                    border: '1px solid #cbd5e1',
                    background: '#ffffff',
                    fontSize: 14,
                    color: '#0f172a',
                    outline: 'none',
                    boxSizing: 'border-box',
                    transition: 'border-color 0.15s',
                  }}
                  onFocus={(e) => (e.target.style.borderColor = '#059669')}
                  onBlur={(e) => (e.target.style.borderColor = '#cbd5e1')}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    width: 44,
                    height: 44,
                    cursor: 'pointer',
                    color: '#64748b',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {showPassword ? <EyeOff size={16} strokeWidth={1.5} /> : <Eye size={16} strokeWidth={1.5} />}
                </button>
              </div>
            </div>

            {/* Forgot password (sessions are always remembered on this device) */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: -6 }}>
              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={loading}
                style={{
                  fontSize: 13,
                  color: '#059669',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '0 4px',
                  minHeight: 44,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                }}
              >
                ลืมรหัสผ่าน
              </button>
            </div>

            {/* Login button */}
            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                padding: '13px',
                borderRadius: 12,
                background: '#059669',
                color: '#ffffff',
                border: 'none',
                fontSize: 14,
                fontWeight: 500,
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
                marginTop: 8,
                transition: 'opacity 0.15s',
              }}
            >
              {loading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
            </button>
          </form>
        </div>

        {/* Footer link to sign up */}
        <p style={{ textAlign: 'center', fontSize: 13, color: '#64748b', margin: '24px 0 0' }}>
          ยังไม่มีบัญชีผู้ใช้?{' '}
          <button
            type="button"
            onClick={() => navigate('signup')}
            disabled={loading}
            style={{
              fontWeight: 600,
              fontSize: 14,
              color: '#059669',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0 6px',
              minHeight: 44,
              fontFamily: 'inherit',
              textDecoration: 'underline',
              textUnderlineOffset: 3,
            }}
          >
            สร้างบัญชีใหม่
          </button>
        </p>
      </div>
    </div>
  );
}
