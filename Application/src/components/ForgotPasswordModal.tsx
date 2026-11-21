import { useEffect, useState } from 'react';
import { KeyRound, MailCheck, X } from 'lucide-react';
import { thingsboard } from '../services/thingsboard';
import { suggestEmailCorrection } from '../services/emailTypo';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface Props {
  open: boolean;
  initialEmail?: string;
  onClose: () => void;
}

/**
 * ลืมรหัสผ่าน: ขอให้ ThingsBoard ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมล
 * (ลิงก์เปิดหน้าตั้งรหัสใหม่ของ ThingsBoard แล้วกลับมาเข้าแอปด้วยรหัสใหม่)
 */
export default function ForgotPasswordModal({ open, initialEmail = '', onClose }: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEmail(initialEmail);
      setError('');
      setSentTo(null);
      setBusy(false);
    }
  }, [open, initialEmail]);

  if (!open) return null;

  const suggestion = email.trim() ? suggestEmailCorrection(email.trim()) : null;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const value = email.trim();
    setError('');
    if (!EMAIL_RE.test(value)) {
      setError('กรุณากรอกอีเมลให้ถูกต้อง');
      return;
    }
    setBusy(true);
    try {
      await thingsboard.requestPasswordReset(value);
      setSentTo(value);
    } catch (err: any) {
      setError(err?.message || 'ส่งคำขอไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="forgot-title"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.45)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 360,
          background: '#ffffff',
          borderRadius: 22,
          padding: '22px 20px 20px',
          boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
          position: 'relative',
          fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="ปิด"
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            width: 36,
            height: 36,
            borderRadius: 10,
            border: 'none',
            background: 'transparent',
            color: '#94a3b8',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={18} />
        </button>

        <div
          style={{
            width: 52,
            height: 52,
            margin: '0 auto 12px',
            borderRadius: 14,
            background: sentTo ? '#ecfdf5' : '#f0f9ff',
            border: `1px solid ${sentTo ? '#a7f3d0' : '#bae6fd'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: sentTo ? '#059669' : '#0284c7',
          }}
        >
          {sentTo ? <MailCheck size={24} /> : <KeyRound size={24} />}
        </div>

        <h2 id="forgot-title" style={{ textAlign: 'center', fontSize: 16, fontWeight: 700, color: '#0f172a', margin: '0 0 6px' }}>
          {sentTo ? 'ตรวจสอบอีเมลของคุณ' : 'รีเซ็ตรหัสผ่าน'}
        </h2>

        {sentTo ? (
          <>
            <p style={{ textAlign: 'center', fontSize: 13, color: '#64748b', lineHeight: 1.6, margin: '0 0 18px' }}>
              ถ้ามีบัญชีของ <strong style={{ color: '#0f172a', wordBreak: 'break-all' }}>{sentTo}</strong> ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้
              กดลิงก์ในอีเมล ตั้งรหัสใหม่ แล้วกลับมาเข้าสู่ระบบในแอปด้วยรหัสใหม่ (ถ้าไม่เจอ ลองดูในจดหมายขยะ)
            </p>
            <button
              type="button"
              onClick={onClose}
              style={{
                width: '100%',
                minHeight: 46,
                borderRadius: 14,
                border: 'none',
                background: '#0f172a',
                color: '#ffffff',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              กลับไปเข้าสู่ระบบ
            </button>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <p style={{ textAlign: 'center', fontSize: 13, color: '#64748b', lineHeight: 1.6, margin: '0 0 14px' }}>
              กรอกอีเมลที่ใช้สมัคร ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปให้ทางอีเมล
            </p>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 6 }}>อีเมล</label>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              value={email}
              placeholder="name@example.com"
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              style={{
                width: '100%',
                minHeight: 46,
                padding: '0 14px',
                borderRadius: 12,
                border: `1px solid ${error ? '#fca5a5' : '#cbd5e1'}`,
                fontSize: 14,
                color: '#0f172a',
                background: '#ffffff',
                boxSizing: 'border-box',
                outline: 'none',
              }}
            />
            {suggestion && (
              <button
                type="button"
                onClick={() => setEmail(suggestion)}
                style={{ marginTop: 6, padding: 0, border: 'none', background: 'none', color: '#0284c7', fontSize: 12, cursor: 'pointer' }}
              >
                หมายถึง {suggestion} ใช่ไหม?
              </button>
            )}
            {error && (
              <p role="alert" style={{ fontSize: 12, color: '#dc2626', margin: '8px 0 0' }}>
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              style={{
                width: '100%',
                minHeight: 46,
                marginTop: 16,
                borderRadius: 14,
                border: 'none',
                background: busy ? '#94a3b8' : '#0f172a',
                color: '#ffffff',
                fontSize: 14,
                fontWeight: 600,
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
            >
              {busy ? 'กำลังส่ง...' : 'ส่งลิงก์รีเซ็ตรหัสผ่าน'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
