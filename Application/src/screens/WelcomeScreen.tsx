import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, AlertCircle, Loader2 } from 'lucide-react';
import { NavProps } from '../types';
import { useSmartFarm } from '../context/SmartFarmContext';

const fieldLabel: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 500,
  color: '#475569',
  marginBottom: 6,
};

const fieldInput: React.CSSProperties = {
  width: '100%',
  minHeight: 48,
  padding: '12px 14px',
  borderRadius: 12,
  border: '1px solid #cbd5e1',
  background: '#ffffff',
  fontSize: 15,
  color: '#0f172a',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s',
  fontFamily: 'inherit',
};

export default function WelcomeScreen({ navigate }: NavProps) {
  const { currentUser, loginWithEmail, showAlert } = useSmartFarm();
  const [errorMsg, setErrorMsg] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  // If already logged in, navigate straight to home
  useEffect(() => {
    if (currentUser) {
      navigate('home');
    }
  }, [currentUser, navigate]);

  const triggerHaptic = () => {
    try {
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(10);
      }
    } catch {
      // Ignore vibration error on unsupported platforms
    }
  };

  // Login goes directly to ThingsBoard with e-mail + password (same as the old login screen).
  const handleEmailLogin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (loading) return;
    setErrorMsg('');
    if (!email.trim()) return setErrorMsg('กรุณากรอกอีเมล');
    if (!password) return setErrorMsg('กรุณากรอกรหัสผ่าน');
    triggerHaptic();
    setLoading(true);
    const result = await loginWithEmail(email, password);
    setLoading(false);
    if (result.success) navigate('home');
    else setErrorMsg(result.error || 'เข้าสู่ระบบไม่สำเร็จ');
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
        width: '100%',
        backgroundColor: '#F6F8F7',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
        padding: '16px 24px 28px',
        boxSizing: 'border-box',
        overflowX: 'hidden',
        position: 'relative',
      }}
    >
      <style>{`
        /* --- Water Drop Fall (0-1s) --- */
        @keyframes welcomeDropFall {
          0% {
            transform: translateY(-90px);
            opacity: 0;
          }
          20% {
            opacity: 0.95;
          }
          65% {
            transform: translateY(0);
            opacity: 0.95;
          }
          80% {
            transform: translateY(0) scale(1.6, 0.25);
            opacity: 0.7;
          }
          100% {
            transform: translateY(0) scale(0);
            opacity: 0;
          }
        }

        @keyframes welcomeDropRipple {
          0%, 60% {
            transform: scale(0);
            opacity: 0;
          }
          70% {
            opacity: 0.8;
          }
          100% {
            transform: scale(1);
            opacity: 0;
          }
        }

        /* --- Roots Growth (0.7-1.3s) --- */
        @keyframes welcomeRootGrow {
          0%, 55% {
            stroke-dashoffset: 35;
          }
          100% {
            stroke-dashoffset: 0;
          }
        }

        /* --- Trunk Growth (1-3s) --- */
        @keyframes welcomeTrunkGrow {
          0%, 30% {
            stroke-dashoffset: 170;
          }
          100% {
            stroke-dashoffset: 0;
          }
        }

        @keyframes welcomeTrunkBaseGrow {
          0%, 30% {
            stroke-dashoffset: 85;
          }
          100% {
            stroke-dashoffset: 0;
          }
        }

        /* --- Branches Growth (2-4s) --- */
        @keyframes welcomeBranchGrow {
          0% {
            stroke-dashoffset: 75;
          }
          100% {
            stroke-dashoffset: 0;
          }
        }

        /* --- Leaves Growth (3-5s) --- */
        @keyframes welcomeLeafGrow {
          0% {
            transform: scale(0);
            opacity: 0;
          }
          65% {
            transform: scale(1.18);
            opacity: 1;
          }
          100% {
            transform: scale(1);
            opacity: 1;
          }
        }

        /* --- Gentle Wind Sway (Post 5s, Infinite) --- */
        @keyframes welcomeTreeSway {
          0%, 100% {
            transform: rotate(0deg);
          }
          32% {
            transform: rotate(1.25deg);
          }
          68% {
            transform: rotate(-0.95deg);
          }
        }

        /* --- Floating Light Blue Droplets (Post 5s, Infinite) --- */
        @keyframes welcomeDropletRise {
          0% {
            transform: translateY(0);
            opacity: 0;
          }
          25% {
            opacity: 0.7;
          }
          75% {
            opacity: 0.45;
          }
          100% {
            transform: translateY(-55px);
            opacity: 0;
          }
        }

        /* --- Text and Buttons Entrance --- */
        @keyframes welcomeFadeUp {
          0% {
            opacity: 0;
            transform: translateY(22px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .welcome-tree-group {
          animation: welcomeTreeSway 5.5s ease-in-out 5.0s infinite;
          transform-origin: 160px 245px;
        }

        .welcome-drop-initial {
          animation: welcomeDropFall 1.05s ease-in forwards;
          transform-origin: 160px 245px;
        }

        .welcome-drop-ripple {
          animation: welcomeDropRipple 1.1s ease-out forwards;
          transform-origin: 160px 245px;
        }

        .welcome-root {
          stroke-dasharray: 35;
          stroke-dashoffset: 35;
          animation: welcomeRootGrow 1.3s cubic-bezier(0.25, 1, 0.5, 1) forwards;
        }

        .welcome-trunk-main {
          stroke-dasharray: 170;
          stroke-dashoffset: 170;
          animation: welcomeTrunkGrow 3.0s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }

        .welcome-trunk-base {
          stroke-dasharray: 85;
          stroke-dashoffset: 85;
          animation: welcomeTrunkBaseGrow 2.2s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }

        .welcome-branch {
          stroke-dasharray: 75;
          stroke-dashoffset: 75;
          animation: welcomeBranchGrow 0.9s cubic-bezier(0.25, 1, 0.5, 1) forwards;
        }

        .welcome-leaf-node {
          transform: scale(0);
          opacity: 0;
          transform-origin: 0 0;
          animation: welcomeLeafGrow 0.65s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }

        .welcome-ambient-bubble {
          opacity: 0;
          animation: welcomeDropletRise 4.2s ease-in-out infinite;
        }

        .welcome-buttons-container {
          animation: welcomeFadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) 3.2s both;
        }

        .welcome-title-container {
          animation: welcomeFadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) 2.6s both;
        }

        /* --- Reduced Motion --- */
        @media (prefers-reduced-motion: reduce) {
          .welcome-tree-group,
          .welcome-ambient-bubble,
          .welcome-buttons-container,
          .welcome-title-container,
          .welcome-root,
          .welcome-trunk-main,
          .welcome-trunk-base,
          .welcome-branch,
          .welcome-leaf-node {
            animation: none !important;
            transform: none !important;
            opacity: 1 !important;
            stroke-dashoffset: 0 !important;
          }
          .welcome-drop-initial,
          .welcome-drop-ripple {
            display: none !important;
          }
        }
      `}</style>

      {/* Top half: SVG Tree */}
      <div
        style={{
          width: '100%',
          maxWidth: 380,
          flex: '0 0 auto',
          height: '40vh',
          minHeight: 230,
          maxHeight: 340,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 10,
        }}
      >
        <svg
          viewBox="0 0 320 280"
          style={{
            width: '100%',
            height: '100%',
            maxHeight: '100%',
            overflow: 'visible',
          }}
          aria-hidden="true"
        >
          <defs>
            {/* 3 Green Gradients for Leaves */}
            <linearGradient id="leafLightGrad" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#4ade80" />
              <stop offset="100%" stopColor="#86efac" />
            </linearGradient>
            <linearGradient id="leafEmeraldGrad" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#059669" />
              <stop offset="100%" stopColor="#34d399" />
            </linearGradient>
            <linearGradient id="leafDarkGrad" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#065f46" />
              <stop offset="100%" stopColor="#047857" />
            </linearGradient>
          </defs>

          {/* 0-1s Initial Water Droplet and Soil Ripple */}
          <g className="welcome-drop-ripple">
            <ellipse cx="160" cy="245" rx="16" ry="4.5" fill="none" stroke="#7dd3fc" strokeWidth="1.5" />
          </g>
          <g className="welcome-drop-initial">
            <path
              d="M 160 238 C 157 241, 155 244, 160 247 C 165 244, 163 241, 160 238 Z"
              fill="#38bdf8"
            />
          </g>

          {/* Tree Structure with Wind Sway */}
          <g className="welcome-tree-group">
            {/* 0.7-1.3s Roots spreading slightly downwards */}
            <g fill="none" stroke="#364b38" strokeWidth="1.8" strokeLinecap="round">
              <path d="M 160 245 Q 148 252 138 258" className="welcome-root" />
              <path d="M 160 245 Q 172 253 182 257" className="welcome-root" />
              <path d="M 160 245 Q 160 255 161 264" className="welcome-root" />
            </g>

            {/* 1-3s Trunk with organic taper and slight curve */}
            <g fill="none" stroke="#2d4532" strokeLinecap="round">
              {/* Thicker base segment */}
              <path
                d="M 160 245 C 160 215, 158 190, 157 165"
                strokeWidth="5.5"
                className="welcome-trunk-base"
              />
              {/* Main stem reaching upward */}
              <path
                d="M 160 245 C 159 190, 155 140, 158 92"
                strokeWidth="3.6"
                className="welcome-trunk-main"
              />
            </g>

            {/* 2-4s Branches in alternating pairs from bottom to top with sub-branches */}
            <g fill="none" stroke="#2d4532" strokeLinecap="round">
              {/* Pair 1 - Lower (Left & Right) */}
              <path
                d="M 159 188 C 146 178, 126 175, 110 158"
                strokeWidth="2.8"
                className="welcome-branch"
                style={{ animationDelay: '2.0s' }}
              />
              <path
                d="M 134 174 C 128 163, 124 152, 118 140"
                strokeWidth="2.0"
                className="welcome-branch"
                style={{ animationDelay: '2.3s' }}
              />
              <path
                d="M 158 178 C 172 170, 192 165, 210 146"
                strokeWidth="2.8"
                className="welcome-branch"
                style={{ animationDelay: '2.2s' }}
              />
              <path
                d="M 183 166 C 191 154, 198 142, 204 128"
                strokeWidth="2.0"
                className="welcome-branch"
                style={{ animationDelay: '2.5s' }}
              />

              {/* Pair 2 - Middle (Left & Right) */}
              <path
                d="M 157 142 C 145 132, 130 125, 116 106"
                strokeWidth="2.5"
                className="welcome-branch"
                style={{ animationDelay: '2.6s' }}
              />
              <path
                d="M 134 124 C 130 112, 128 100, 128 88"
                strokeWidth="1.9"
                className="welcome-branch"
                style={{ animationDelay: '2.9s' }}
              />
              <path
                d="M 158 132 C 170 122, 186 114, 202 92"
                strokeWidth="2.5"
                className="welcome-branch"
                style={{ animationDelay: '2.8s' }}
              />
              <path
                d="M 180 114 C 187 102, 191 90, 193 78"
                strokeWidth="1.9"
                className="welcome-branch"
                style={{ animationDelay: '3.1s' }}
              />

              {/* Pair 3 - Upper fork & apex */}
              <path
                d="M 158 92 C 151 78, 144 65, 138 52"
                strokeWidth="2.2"
                className="welcome-branch"
                style={{ animationDelay: '3.2s' }}
              />
              <path
                d="M 158 92 C 165 78, 172 65, 178 50"
                strokeWidth="2.2"
                className="welcome-branch"
                style={{ animationDelay: '3.3s' }}
              />
              <path
                d="M 158 92 C 158 76, 157 64, 157 44"
                strokeWidth="2.2"
                className="welcome-branch"
                style={{ animationDelay: '3.4s' }}
              />
            </g>

            {/* 3-5s Leaves sprouting in sequence across 3 shades of green */}
            {/* Leaf 1: Lower Left Main - Dark */}
            <g transform="translate(110, 158) rotate(-55)">
              <g className="welcome-leaf-node" style={{ animationDelay: '3.0s' }}>
                <path d="M 0 0 C -4.5 -6 -7.5 -13 0 -21 C 7.5 -13 4.5 -6 0 0 Z" fill="url(#leafDarkGrad)" />
              </g>
            </g>
            {/* Leaf 2: Lower Left Sub - Light */}
            <g transform="translate(118, 140) rotate(-25)">
              <g className="welcome-leaf-node" style={{ animationDelay: '3.2s' }}>
                <path d="M 0 0 C -4.5 -6 -7.5 -13 0 -20 C 7.5 -13 4.5 -6 0 0 Z" fill="url(#leafLightGrad)" />
              </g>
            </g>
            {/* Leaf 3: Lower Right Main - Emerald */}
            <g transform="translate(210, 146) rotate(55)">
              <g className="welcome-leaf-node" style={{ animationDelay: '3.3s' }}>
                <path d="M 0 0 C -4.5 -6 -7.5 -13 0 -21 C 7.5 -13 4.5 -6 0 0 Z" fill="url(#leafEmeraldGrad)" />
              </g>
            </g>
            {/* Leaf 4: Lower Right Sub - Light */}
            <g transform="translate(204, 128) rotate(25)">
              <g className="welcome-leaf-node" style={{ animationDelay: '3.5s' }}>
                <path d="M 0 0 C -4.5 -6 -7.5 -13 0 -20 C 7.5 -13 4.5 -6 0 0 Z" fill="url(#leafLightGrad)" />
              </g>
            </g>
            {/* Leaf 5: Middle Left Main - Emerald */}
            <g transform="translate(116, 106) rotate(-50)">
              <g className="welcome-leaf-node" style={{ animationDelay: '3.7s' }}>
                <path d="M 0 0 C -4.5 -6 -7.5 -13 0 -20 C 7.5 -13 4.5 -6 0 0 Z" fill="url(#leafEmeraldGrad)" />
              </g>
            </g>
            {/* Leaf 6: Middle Left Sub - Dark */}
            <g transform="translate(128, 88) rotate(-15)">
              <g className="welcome-leaf-node" style={{ animationDelay: '3.9s' }}>
                <path d="M 0 0 C -4 -5.5 -7 -12 0 -19 C 7 -12 4 -5.5 0 0 Z" fill="url(#leafDarkGrad)" />
              </g>
            </g>
            {/* Leaf 7: Middle Right Main - Light */}
            <g transform="translate(202, 92) rotate(50)">
              <g className="welcome-leaf-node" style={{ animationDelay: '4.1s' }}>
                <path d="M 0 0 C -4.5 -6 -7.5 -13 0 -20 C 7.5 -13 4.5 -6 0 0 Z" fill="url(#leafLightGrad)" />
              </g>
            </g>
            {/* Leaf 8: Middle Right Sub - Emerald */}
            <g transform="translate(193, 78) rotate(15)">
              <g className="welcome-leaf-node" style={{ animationDelay: '4.3s' }}>
                <path d="M 0 0 C -4 -5.5 -7 -12 0 -19 C 7 -12 4 -5.5 0 0 Z" fill="url(#leafEmeraldGrad)" />
              </g>
            </g>
            {/* Leaf 9: Upper Left - Light */}
            <g transform="translate(138, 52) rotate(-35)">
              <g className="welcome-leaf-node" style={{ animationDelay: '4.4s' }}>
                <path d="M 0 0 C -4 -5.5 -7 -12 0 -19 C 7 -12 4 -5.5 0 0 Z" fill="url(#leafLightGrad)" />
              </g>
            </g>
            {/* Leaf 10: Upper Right - Emerald */}
            <g transform="translate(178, 50) rotate(35)">
              <g className="welcome-leaf-node" style={{ animationDelay: '4.5s' }}>
                <path d="M 0 0 C -4 -5.5 -7 -12 0 -19 C 7 -12 4 -5.5 0 0 Z" fill="url(#leafEmeraldGrad)" />
              </g>
            </g>
            {/* Leaf 11: Crown Apex - Light */}
            <g transform="translate(157, 44) rotate(0)">
              <g className="welcome-leaf-node" style={{ animationDelay: '4.7s' }}>
                <path d="M 0 0 C -4 -5.5 -7 -12 0 -19 C 7 -12 4 -5.5 0 0 Z" fill="url(#leafLightGrad)" />
              </g>
            </g>
            {/* Leaf 12: Crown Companion - Dark */}
            <g transform="translate(153, 62) rotate(-20)">
              <g className="welcome-leaf-node" style={{ animationDelay: '4.8s' }}>
                <path d="M 0 0 C -3.5 -5 -6 -10 0 -16 C 6 -10 3.5 -5 0 0 Z" fill="url(#leafDarkGrad)" />
              </g>
            </g>
          </g>

          {/* Floating Light Blue Droplets (Endless loop after full growth, max 6) */}
          <circle cx="144" cy="215" r="2.8" fill="#38bdf8" className="welcome-ambient-bubble" style={{ animationDelay: '5.1s', animationDuration: '4.6s' }} />
          <circle cx="178" cy="195" r="2.4" fill="#7dd3fc" className="welcome-ambient-bubble" style={{ animationDelay: '5.8s', animationDuration: '4.2s' }} />
          <circle cx="122" cy="165" r="3.0" fill="#38bdf8" className="welcome-ambient-bubble" style={{ animationDelay: '6.6s', animationDuration: '5.0s' }} />
          <circle cx="196" cy="135" r="2.2" fill="#7dd3fc" className="welcome-ambient-bubble" style={{ animationDelay: '7.4s', animationDuration: '4.4s' }} />
          <circle cx="140" cy="115" r="2.6" fill="#38bdf8" className="welcome-ambient-bubble" style={{ animationDelay: '8.2s', animationDuration: '4.8s' }} />
          <circle cx="168" cy="90"  r="2.5" fill="#7dd3fc" className="welcome-ambient-bubble" style={{ animationDelay: '9.0s', animationDuration: '4.5s' }} />
        </svg>
      </div>

      {/* Middle section: App Name and Subtitle */}
      <div
        className="welcome-title-container"
        style={{
          width: '100%',
          maxWidth: 360,
          textAlign: 'center',
          marginTop: 0,
          marginBottom: 28,
          padding: '0 16px',
        }}
      >
        <h1
          style={{
            fontSize: 'clamp(30px, 7vw, 36px)',
            fontWeight: 800,
            color: '#0F172A',
            margin: 0,
            letterSpacing: '-0.025em',
            lineHeight: 1.2,
          }}
        >
          Hydroponic
        </h1>
        <p
          style={{
            fontSize: '15px',
            color: '#64748B',
            margin: '8px 0 0',
            fontWeight: 400,
            lineHeight: 1.5,
          }}
        >
          ระบบจัดการไฮโดรโปนิกส์อัจฉริยะ
        </p>

      </div>

      {/* Bottom section: e-mail login (Google is offered on the sign-up screen) */}
      <div className="welcome-buttons-container" style={{ width: '100%', maxWidth: 360, marginTop: 'auto', paddingTop: 8 }}>
        {errorMsg && (
          <div
            role="alert"
            style={{
              background: '#fef2f2',
              border: '1px solid #fee2e2',
              borderRadius: 12,
              padding: '10px 12px',
              marginBottom: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: '#dc2626',
              fontSize: 13,
            }}
          >
            <AlertCircle size={16} strokeWidth={1.75} style={{ flexShrink: 0 }} />
            <span style={{ lineHeight: 1.4 }}>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleEmailLogin} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={fieldLabel} htmlFor="wl-email">อีเมล</label>
            <input
              id="wl-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              style={fieldInput}
              onFocus={(e) => (e.target.style.borderColor = '#059669')}
              onBlur={(e) => (e.target.style.borderColor = '#cbd5e1')}
            />
          </div>

          <div>
            <label style={fieldLabel} htmlFor="wl-pass">รหัสผ่าน</label>
            <div style={{ position: 'relative' }}>
              <input
                id="wl-pass"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="อย่างน้อย 8 ตัวอักษร"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                style={{ ...fieldInput, paddingRight: 46 }}
                onFocus={(e) => (e.target.style.borderColor = '#059669')}
                onBlur={(e) => (e.target.style.borderColor = '#cbd5e1')}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                style={{
                  position: 'absolute',
                  right: 2,
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
                {showPassword ? <EyeOff size={17} strokeWidth={1.5} /> : <Eye size={17} strokeWidth={1.5} />}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -8 }}>
            <button
              type="button"
              onClick={handleForgotPassword}
              disabled={loading}
              style={{ fontSize: 13, color: '#059669', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', minHeight: 44, fontWeight: 500, fontFamily: 'inherit' }}
            >
              ลืมรหัสผ่าน
            </button>
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              height: 52,
              marginTop: -4,
              borderRadius: 9999,
              backgroundColor: '#059669',
              color: '#FFFFFF',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              fontSize: 15,
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.75 : 1,
              boxShadow: '0 4px 14px rgba(5, 150, 105, 0.25)',
              fontFamily: 'inherit',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {loading && <Loader2 size={18} className="animate-spin" />}
            <span>{loading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}</span>
          </button>
        </form>

        <p style={{ textAlign: 'center', fontSize: 13, color: '#64748b', margin: '20px 0 0' }}>
          ยังไม่มีบัญชีผู้ใช้?{' '}
          <button
            type="button"
            onClick={() => navigate('signup')}
            disabled={loading}
            style={{ fontWeight: 600, fontSize: 14, color: '#059669', background: 'none', border: 'none', cursor: 'pointer', padding: '0 6px', minHeight: 44, fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: 3 }}
          >
            สร้างบัญชีใหม่
          </button>
        </p>
      </div>
    </div>
  );
}

