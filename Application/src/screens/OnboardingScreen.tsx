import { useState } from 'react';
import { Preferences } from '@capacitor/preferences';
import { NavProps } from '../types';
import { ArrowRight, Sprout } from 'lucide-react';

/* ─── Inline SVG Illustrations ─── */

function IllustrationMonitor() {
  return (
    <svg viewBox="0 0 240 200" fill="none" style={{ width: '100%', maxWidth: 260 }}>
      {/* Water drop bg */}
      <ellipse cx="120" cy="110" rx="90" ry="75" fill="#dbeafe" opacity=".45" />
      {/* Sensor housing */}
      <rect x="82" y="60" width="76" height="100" rx="16" fill="white" />
      <rect x="82" y="60" width="76" height="100" rx="16" stroke="#bfdbfe" strokeWidth="2" />
      {/* Screen */}
      <rect x="92" y="72" width="56" height="40" rx="8" fill="#eff6ff" />
      {/* Chart line */}
      <polyline points="96,102 104,94 112,98 120,88 128,93 136,86 144,91" stroke="#60a5fa" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {/* Labels */}
      <rect x="92" y="118" width="18" height="6" rx="3" fill="#bbf7d0" />
      <rect x="116" y="118" width="22" height="6" rx="3" fill="#bfdbfe" />
      <rect x="92" y="130" width="16" height="6" rx="3" fill="#fde68a" />
      <rect x="116" y="130" width="20" height="6" rx="3" fill="#e9d5ff" />
      {/* Probe */}
      <rect x="112" y="160" width="16" height="28" rx="8" fill="#93c5fd" />
      <circle cx="120" cy="188" r="6" fill="#60a5fa" />
      {/* Wifi arcs */}
      <path d="M60 52 Q120 30 180 52" stroke="#a78bfa" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity=".6" />
      <path d="M75 40 Q120 20 165 40" stroke="#a78bfa" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".4" />
      {/* Neutral metric chips (no numbers: illustration only) */}
      <rect x="22" y="78" width="50" height="24" rx="12" fill="white" />
      <circle cx="36" cy="90" r="5" fill="#bbf7d0" />
      <rect x="45" y="87" width="18" height="6" rx="3" fill="#16a34a" opacity=".35" />
      <rect x="168" y="78" width="52" height="24" rx="12" fill="white" />
      <circle cx="182" cy="90" r="5" fill="#bfdbfe" />
      <rect x="191" y="87" width="20" height="6" rx="3" fill="#2563eb" opacity=".35" />
      <rect x="22" y="116" width="52" height="24" rx="12" fill="white" />
      <circle cx="36" cy="128" r="5" fill="#e9d5ff" />
      <rect x="45" y="125" width="20" height="6" rx="3" fill="#7c3aed" opacity=".35" />
      <rect x="168" y="116" width="52" height="24" rx="12" fill="white" />
      <circle cx="182" cy="128" r="5" fill="#a5f3fc" />
      <rect x="191" y="125" width="20" height="6" rx="3" fill="#0891b2" opacity=".35" />
    </svg>
  );
}

function IllustrationControl() {
  return (
    <svg viewBox="0 0 240 200" fill="none" style={{ width: '100%', maxWidth: 260 }}>
      <ellipse cx="120" cy="115" rx="90" ry="70" fill="#dcfce7" opacity=".45" />
      {/* ESP32 board */}
      <rect x="75" y="70" width="90" height="55" rx="10" fill="white" stroke="#bbf7d0" strokeWidth="2" />
      <rect x="85" y="80" width="70" height="35" rx="6" fill="#f0fdf4" />
      {/* Board details */}
      {[0,1,2,3].map(i => <rect key={i} x={89+i*16} y={84} width={10} height={10} rx={3} fill="#bbf7d0" />)}
      <rect x="89" y="100" width="66" height="4" rx="2" fill="#4ade80" opacity=".5" />
      {/* Pump A */}
      <circle cx="62" cy="150" r="22" fill="white" stroke="#bfdbfe" strokeWidth="2" />
      <circle cx="62" cy="150" r="14" fill="#eff6ff" />
      <path d="M55 150 Q62 142 69 150 Q62 158 55 150Z" fill="#60a5fa" />
      {/* Pump B */}
      <circle cx="178" cy="150" r="22" fill="white" stroke="#fde68a" strokeWidth="2" />
      <circle cx="178" cy="150" r="14" fill="#fffbeb" />
      <path d="M171 150 Q178 142 185 150 Q178 158 171 150Z" fill="#fbbf24" />
      {/* Connect lines */}
      <line x1="84" y1="125" x2="80" y2="140" stroke="#4ade80" strokeWidth="2" strokeDasharray="3 3" />
      <line x1="80" y1="140" x2="70" y2="148" stroke="#60a5fa" strokeWidth="2" strokeDasharray="3 3" />
      <line x1="156" y1="125" x2="160" y2="140" stroke="#4ade80" strokeWidth="2" strokeDasharray="3 3" />
      <line x1="160" y1="140" x2="170" y2="148" stroke="#fbbf24" strokeWidth="2" strokeDasharray="3 3" />
      {/* Automation hint (neutral, no state text) */}
      <rect x="105" y="50" width="30" height="14" rx="7" fill="#bbf7d0" />
      <circle cx="113" cy="57" r="3.5" fill="#059669" />
    </svg>
  );
}

function IllustrationAlert() {
  return (
    <svg viewBox="0 0 240 200" fill="none" style={{ width: '100%', maxWidth: 260 }}>
      <ellipse cx="120" cy="115" rx="90" ry="70" fill="#fef9c3" opacity=".55" />
      {/* Phone */}
      <rect x="75" y="45" width="90" height="145" rx="18" fill="white" stroke="#e2e8f0" strokeWidth="2" />
      <rect x="85" y="58" width="70" height="115" rx="10" fill="#f8fafc" />
      {/* Notification card 1 – warning */}
      <rect x="89" y="65" width="62" height="36" rx="8" fill="#fef3c7" />
      <circle cx="99" cy="83" r="8" fill="#fbbf24" />
      <path d="M99 79v5M99 86.5h.01" stroke="white" strokeWidth="1.75" strokeLinecap="round" />
      <rect x="111" y="69" width="36" height="5" rx="2.5" fill="#d97706" opacity=".7" />
      <rect x="111" y="77" width="28" height="4" rx="2" fill="#d97706" opacity=".4" />
      <rect x="111" y="84" width="32" height="4" rx="2" fill="#d97706" opacity=".4" />
      {/* Notification card 2 – ok */}
      <rect x="89" y="107" width="62" height="30" rx="8" fill="#dcfce7" />
      <circle cx="99" cy="122" r="7" fill="#4ade80" />
      <rect x="110" y="113" width="36" height="4" rx="2" fill="#16a34a" opacity=".7" />
      <rect x="110" y="121" width="26" height="4" rx="2" fill="#16a34a" opacity=".4" />
      {/* Notification card 3 – error */}
      <rect x="89" y="143" width="62" height="24" rx="8" fill="#ffe4e6" />
      <circle cx="99" cy="155" r="6" fill="#fb7185" />
      <rect x="109" y="148" width="34" height="4" rx="2" fill="#e11d48" opacity=".7" />
      <rect x="109" y="156" width="24" height="4" rx="2" fill="#e11d48" opacity=".4" />
      {/* Bell */}
      <circle cx="178" cy="62" r="20" fill="white" stroke="#fde68a" strokeWidth="2" />
      <path d="M178 54c-3.3 0-6 2.7-6 6v4l-2 2v1h16v-1l-2-2v-4c0-3.3-2.7-6-6-6zM176 68a2 2 0 004 0" fill="#f59e0b" stroke="#d97706" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="186" cy="54" r="5" fill="#fb7185" />
    </svg>
  );
}

const pages = [
  {
    bg: ['#f0fdf6', '#eff6ff'],
    accent: '#60a5fa',
    pill: 'bg-blue-100 text-blue-700',
    bar: 'bg-blue-400',
    title: 'ติดตามคุณภาพน้ำ',
    desc: 'ดูค่า pH, EC และอุณหภูมิน้ำจากเซนเซอร์ของอุปกรณ์แบบเรียลไทม์',
    illustration: <IllustrationMonitor />,
  },
  {
    bg: ['#f0fdf6', '#f0fdf4'],
    accent: '#4ade80',
    pill: 'bg-green-100 text-green-700',
    bar: 'bg-green-400',
    title: 'ควบคุมปั๊มอัตโนมัติ',
    desc: 'ระบบสามารถควบคุมปั๊มและเติมสารละลายโดยอัตโนมัติ',
    illustration: <IllustrationControl />,
  },
  {
    bg: ['#fefce8', '#fff7ed'],
    accent: '#fbbf24',
    pill: 'bg-amber-100 text-amber-700',
    bar: 'bg-amber-400',
    title: 'รู้ก่อนเกิดปัญหา',
    desc: 'รับการแจ้งเตือนเมื่อคุณภาพน้ำ ระดับน้ำ หรือสารละลายผิดปกติ',
    illustration: <IllustrationAlert />,
  },
];

export default function OnboardingScreen({ navigate }: NavProps) {
  const [page, setPage] = useState(0);
  const p = pages[page];

  const handleFinishOnboarding = () => {
    try {
      localStorage.setItem('has_seen_onboarding', 'true');
    } catch {}
    Preferences.set({ key: 'has_seen_onboarding', value: 'true' }).catch(() => {});
    navigate('welcome');
  };

  return (
    <div className="min-h-screen flex justify-center" style={{ background: '#f2fdf8' }}>
      <div className="w-full max-w-md min-h-screen flex flex-col">
        {/* Illustration area */}
        <div
          className="flex-1 flex flex-col items-center justify-center px-8 pb-4 pt-16 gap-6 relative"
          style={{ background: `linear-gradient(160deg,${p.bg[0]} 0%,${p.bg[1]} 100%)` }}
        >
          {/* Pill tag */}
          <span className={`text-[11px] font-bold px-3 py-1 rounded-full ${p.pill}`}>
            ขั้นตอน {page + 1} จาก {pages.length}
          </span>
          <div className="w-full max-w-xs">{p.illustration}</div>
        </div>

        {/* Text + controls */}
        <div className="bg-white px-7 pt-7 pb-10 flex flex-col gap-5 rounded-t-3xl -mt-4 relative z-10">
          {/* Dots */}
          <div className="flex" style={{ marginLeft: -14, marginTop: -12, marginBottom: -12 }}>
            {pages.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`ไปหน้าที่ ${i + 1}`}
                onClick={() => setPage(i)}
                style={{ minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                <div className={`h-2 rounded-full transition-all duration-300 ${i === page ? `w-7` : 'w-2 bg-slate-200'}`}
                  style={{ background: i === page ? p.accent : undefined }} />
              </button>
            ))}
          </div>

          <div>
            <h2 style={{ fontSize: 24, fontWeight: 900, color: '#1e293b', lineHeight: 1.25 }}>
              {p.title}
            </h2>
            <p style={{ fontSize: 14, color: '#64748b', marginTop: 8, lineHeight: 1.65 }}>{p.desc}</p>
          </div>

          {page < 2 ? (
            <div className="flex items-center justify-between">
              <button type="button" onClick={handleFinishOnboarding} style={{ fontSize: 14, fontWeight: 600, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', minHeight: 44, padding: '0 8px', marginLeft: -8 }}>ข้าม</button>
              <button
                onClick={() => setPage(page + 1)}
                style={{ background: p.accent, color: 'white', fontWeight: 800, fontSize: 15, padding: '0 24px', minHeight: 44, borderRadius: 14, border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <span>ถัดไป</span>
                <ArrowRight size={16} strokeWidth={2.2} />
              </button>
            </div>
          ) : (
            <button
              onClick={handleFinishOnboarding}
              style={{ width: '100%', background: '#4ade80', color: 'white', fontWeight: 900, fontSize: 16, padding: '15px', borderRadius: 18, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            >
              <span>เริ่มต้นใช้งาน</span>
              <Sprout size={20} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
