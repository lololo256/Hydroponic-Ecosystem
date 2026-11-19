import React, { useState } from 'react';
import { NavProps } from '../types';
import { ArrowLeft, Loader2, UserPlus } from 'lucide-react';
import { useSmartFarm } from '../context/SmartFarmContext';
import { suggestEmailCorrection } from '../services/emailTypo';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const inputStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 48,
  padding: '12px 14px',
  borderRadius: 12,
  border: '1px solid #e2e8f0',
  fontSize: 15,
  color: '#0f172a',
  background: '#ffffff',
  boxSizing: 'border-box',
  outline: 'none',
  fontFamily: 'inherit',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 500,
  color: '#334155',
  margin: '0 0 6px',
  textAlign: 'left',
};

export default function SignUpScreen({ navigate }: NavProps) {
  const { signUpWithEmail, signUpWithGoogle, showConfirm } = useSmartFarm();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState<'email' | 'google' | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const createAccount = async (finalEmail: string) => {
    setLoading('email');
    const result = await signUpWithEmail(name, finalEmail, password);
    setLoading(null);
    if (result.success) navigate('home');
    else setErrorMessage(result.error || 'สมัครสมาชิกไม่สำเร็จ');
  };

  // Last check before the account is created: the e-mail is the login name and cannot be
  // changed by the user later, so show it in full once more.
  const confirmEmail = (finalEmail: string) => {
    showConfirm({
      title: 'ยืนยันอีเมล',
      message: `สร้างบัญชีด้วยอีเมล ${finalEmail} ใช่ไหม?\n\nอีเมลนี้ใช้เข้าสู่ระบบ ถ้าพิมพ์ผิดจะแก้เองภายหลังไม่ได้`,
      confirmText: 'ถูกต้อง สร้างบัญชี',
      cancelText: 'แก้ไขอีเมล',
      variant: 'info',
      onConfirm: () => createAccount(finalEmail),
      onCancel: () => document.getElementById('su-email')?.focus(),
    });
  };

  const handleSignUp = () => {
    setErrorMessage('');
    if (!name.trim()) return setErrorMessage('กรุณากรอกชื่อ');
    const typed = email.trim().toLowerCase();
    if (!EMAIL_RE.test(typed)) return setErrorMessage('รูปแบบอีเมลไม่ถูกต้อง');
    if (password.length < 8) return setErrorMessage('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
    if (password !== confirm) return setErrorMessage('รหัสผ่านทั้งสองช่องไม่ตรงกัน');

    const suggestion = suggestEmailCorrection(typed);
    if (suggestion) {
      const suggestedDomain = suggestion.slice(suggestion.lastIndexOf('@'));
      showConfirm({
        title: 'อีเมลพิมพ์ถูกไหม?',
        message: `คุณพิมพ์ ${typed}\n\nหมายถึง ${suggestedDomain} ใช่ไหม?\n(${suggestion})`,
        confirmText: `ใช่ ใช้ ${suggestedDomain}`,
        cancelText: 'ไม่ใช่ ใช้ตามที่พิมพ์',
        variant: 'warning',
        onConfirm: () => {
          setEmail(suggestion);
          confirmEmail(suggestion);
        },
        onCancel: () => confirmEmail(typed),
      });
      return;
    }
    confirmEmail(typed);
  };

  const handleGoogle = async () => {
    setErrorMessage('');
    if (password.length < 8) return setErrorMessage('ตั้งรหัสผ่านด้านบนก่อน (อย่างน้อย 8 ตัวอักษร) แล้วจึงกดสมัครด้วย Google');
    if (password !== confirm) return setErrorMessage('รหัสผ่านทั้งสองช่องไม่ตรงกัน');
    setLoading('google');
    const result = await signUpWithGoogle(password, name);
    setLoading(null);
    if (result.success) navigate('home');
    else setErrorMessage(result.error || 'สมัครด้วย Google ไม่สำเร็จ');
  };

  const busy = loading !== null;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f8fafc',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start', // ไม่ใช้ center: ถ้าเนื้อหาสูงกว่าจอ (แป้นพิมพ์ขึ้น) ส่วนบนจะถูกตัดจนเลื่อนไม่ถึง
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
        padding: '24px 16px',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 400,
          margin: 'auto 0', // จัดกลางแนวตั้งแบบปลอดภัย (ไม่ล้นขอบบน)
          background: '#ffffff',
          borderRadius: 20,
          padding: '28px 22px',
          boxShadow: '0 4px 20px rgba(0,0,0,0.06)',
          border: '1px solid #e2e8f0',
        }}
      >
        <button
          onClick={() => navigate('welcome')}
          disabled={busy}
          aria-label="กลับไปหน้าเข้าสู่ระบบ"
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
            cursor: 'pointer',
            fontSize: 14,
            marginBottom: 8,
          }}
        >
          <ArrowLeft size={18} strokeWidth={2} />
          <span>เข้าสู่ระบบ</span>
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              background: '#ecfdf5',
              color: '#059669',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <UserPlus size={22} strokeWidth={1.75} />
          </div>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 600, color: '#0f172a', margin: 0, letterSpacing: '-0.02em' }}>
              สมัครสมาชิก
            </h2>
            <p style={{ fontSize: 13, color: '#64748b', margin: '2px 0 0' }}>สร้างบัญชีใหม่ได้ทันที แล้วใช้อีเมลกับรหัสผ่านนี้เข้าสู่ระบบ</p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) handleSignUp();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div>
            <label style={labelStyle} htmlFor="su-name">ชื่อ</label>
            <input id="su-name" style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" disabled={busy} />
          </div>
          <div>
            <label style={labelStyle} htmlFor="su-email">อีเมล (ไม่ต้องกรอกถ้าสมัครด้วย Google)</label>
            <input id="su-email" style={inputStyle} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" disabled={busy} />
          </div>
          <div>
            <label style={labelStyle} htmlFor="su-pass">รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)</label>
            <input id="su-pass" style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" disabled={busy} />
          </div>
          <div>
            <label style={labelStyle} htmlFor="su-confirm">ยืนยันรหัสผ่าน</label>
            <input id="su-confirm" style={inputStyle} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" disabled={busy} />
          </div>

          {errorMessage && (
            <div role="alert" style={{ fontSize: 13, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '10px 12px' }}>
              {errorMessage}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            style={{
              minHeight: 48,
              borderRadius: 12,
              background: busy ? '#6ee7b7' : '#059669',
              color: '#ffffff',
              border: 'none',
              fontSize: 15,
              fontWeight: 500,
              cursor: busy ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {loading === 'email' && <Loader2 size={18} className="animate-spin" />}
            <span>{loading === 'email' ? 'กำลังสร้างบัญชี...' : 'สมัครสมาชิก'}</span>
          </button>
        </form>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0', color: '#94a3b8', fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
          <span>หรือ</span>
          <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
        </div>

        <button
          onClick={handleGoogle}
          disabled={busy}
          style={{
            width: '100%',
            minHeight: 48,
            borderRadius: 12,
            background: '#ffffff',
            color: '#0f172a',
            border: '1px solid #e2e8f0',
            fontSize: 15,
            fontWeight: 500,
            cursor: busy ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          {loading === 'google' && <Loader2 size={18} className="animate-spin" />}
          <span>{loading === 'google' ? 'กำลังยืนยันกับ Google...' : 'สมัครด้วย Google'}</span>
        </button>

        <p style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', margin: '14px 0 0', lineHeight: 1.6 }}>
          สมัครด้วย Google = ใช้อีเมลจากบัญชี Google และรหัสผ่านที่ตั้งด้านบน ครั้งต่อไปเข้าสู่ระบบด้วยอีเมลและรหัสผ่านนี้
          <br />
          การสมัครอาจใช้เวลาสูงสุด 1 นาที เพราะเซิร์ฟเวอร์อาจกำลังตื่นจากโหมดพัก
        </p>
      </div>
    </div>
  );
}
