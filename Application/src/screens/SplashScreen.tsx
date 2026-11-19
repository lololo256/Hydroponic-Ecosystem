import { useState, useEffect, useCallback } from 'react';
import { Preferences } from '@capacitor/preferences';
import { NavProps } from '../types';
import { useSmartFarm } from '../context/SmartFarmContext';

export default function SplashScreen({ navigate }: NavProps) {
  const { currentUser, loading } = useSmartFarm();
  const [animationDone, setAnimationDone] = useState(false);
  const [hasNavigated, setHasNavigated] = useState(false);

  const proceed = useCallback(() => {
    setAnimationDone(true);
  }, []);

  useEffect(() => {
    // ซิงค์เวลาตามแอนิเมชันให้พืชเติบโตและผลไม้ออกครบ (~4.6 วินาที หรือแตะเพื่อข้ามได้ทันที)
    const timer = setTimeout(() => {
      proceed();
    }, 4600);

    return () => clearTimeout(timer);
  }, [proceed]);

  useEffect(() => {
    if (!animationDone) return;
    if (loading) return; // รอให้ระบบกู้คืนเซสชันและตรวจสอบโทเค็นเสร็จสมบูรณ์ก่อนเปลี่ยนหน้า
    if (hasNavigated) return;

    setHasNavigated(true);

    const determineRoute = async () => {
      let hasSeen = false;
      try {
        hasSeen = localStorage.getItem('has_seen_onboarding') === 'true';
      } catch {}
      if (!hasSeen) {
        try {
          const pref = await Preferences.get({ key: 'has_seen_onboarding' });
          if (pref?.value === 'true') hasSeen = true;
        } catch {}
      }

      if (currentUser) {
        navigate('home');
      } else if (hasSeen) {
        navigate('welcome');
      } else {
        navigate('onboarding');
      }
    };

    determineRoute();
  }, [animationDone, loading, currentUser, hasNavigated, navigate]);

  return (
    <div
      onClick={proceed}
      style={{
        width: '100vw',
        height: '100vh',
        background: '#EEF4F0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        margin: 0,
        padding: 0,
        position: 'relative',
        overflow: 'hidden',
        cursor: 'pointer',
      }}
    >
      <style>{`
        @keyframes draw {
          0% { stroke-dashoffset: 1; opacity: 1; }
          100% { stroke-dashoffset: 0; opacity: 1; }
        }
        @keyframes lp {
          0% { transform: scale(0); }
          70% { transform: scale(1.15); }
          100% { transform: scale(1); }
        }
        @keyframes pail {
          0% { transform: translate(120px, -260px) rotate(0); opacity: 0; }
          10% { transform: translate(30px, -30px) rotate(0); opacity: 1; }
          18%, 52% { transform: translate(0, 0) rotate(-60deg); opacity: 1; }
          60% { transform: translate(0, 0) rotate(0); opacity: 1; }
          72%, 100% { transform: translate(120px, -260px) rotate(0); opacity: 0; }
        }
        @keyframes env {
          0%, 18% { opacity: 0; }
          22%, 52% { opacity: 1; }
          56%, 100% { opacity: 0; }
        }
        @keyframes flow {
          to { stroke-dashoffset: -19; }
        }
        @keyframes sp {
          0% { transform: translate(0, 0) scale(1); opacity: 0; }
          15% { opacity: 1; }
          100% { transform: translate(var(--x), var(--y)) scale(0.4); opacity: 0; }
        }
        @keyframes eo {
          0%, 18% { opacity: 1; }
          22%, 85% { opacity: 0; }
          90%, 100% { opacity: 1; }
        }
        @keyframes eh {
          0%, 18% { opacity: 0; }
          22%, 85% { opacity: 1; }
          90%, 100% { opacity: 0; }
        }
        @keyframes blink {
          0%, 91%, 100% { transform: scaleY(1); }
          95% { transform: scaleY(0.08); }
        }
        @keyframes pop {
          0% { transform: scale(0.6); opacity: 0; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes sway {
          0%, 100% { transform: rotate(-1.2deg); }
          50% { transform: rotate(1.2deg); }
        }
        @keyframes swayL {
          0%, 100% { transform: rotate(-5deg); }
          50% { transform: rotate(3deg); }
        }
        @keyframes swayR {
          0%, 100% { transform: rotate(5deg); }
          50% { transform: rotate(-3deg); }
        }
        @keyframes bar {
          to { transform: scaleX(1); }
        }
        @keyframes fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes fp {
          0% { transform: scale(0); }
          70% { transform: scale(1.25); }
          100% { transform: scale(1); }
        }
        @keyframes fswing {
          0%, 100% { transform: rotate(-4deg); }
          50% { transform: rotate(4deg); }
        }
        .gr {
          fill: none;
          stroke: #4A6B45;
          stroke-linecap: round;
          stroke-dasharray: 1;
          stroke-dashoffset: 1;
          opacity: 0;
          animation: draw var(--d, 0.5s) ease-out var(--t, 0s) forwards;
        }
        .lf {
          transform-box: fill-box;
          transform-origin: 0% 50%;
          transform: scale(0);
          animation: lp 0.4s ease-out var(--t, 2s) forwards;
        }
        .l1 { fill: #4ADE80; }
        .l2 { fill: #16A34A; }
        .l3 { fill: #0B6B4A; }
        #tree {
          transform-origin: 195px 436px;
          animation: sway 4s ease-in-out 3.2s infinite;
        }
        .pail {
          opacity: 0;
          animation: pail 3.2s ease-in-out forwards;
        }
        .stream, .splash {
          opacity: 0;
          animation: env 3.2s forwards;
        }
        .flow {
          animation: flow 0.4s linear infinite;
        }
        .sd {
          animation: sp 0.7s ease-out infinite;
        }
        #hd, #bl, .lL, .lR {
          transform-box: fill-box;
        }
        #mas {
          animation: fade 0.5s ease-out both;
        }
        #eo {
          animation: eo 3.2s forwards;
        }
        #eh {
          opacity: 0;
          animation: eh 3.2s forwards;
        }
        #bl {
          transform-origin: 50% 50%;
          animation: blink 4.5s ease-in-out 3.2s infinite;
        }
        .lL {
          transform-origin: 100% 100%;
          animation: swayL 5s ease-in-out infinite;
        }
        .lR {
          transform-origin: 0% 100%;
          animation: swayR 5s ease-in-out infinite;
        }
        #hd {
          transform-origin: 50% 100%;
          animation: pop 0.6s ease-out both;
        }
        .bar {
          transform-box: fill-box;
          transform-origin: 0 50%;
          transform: scaleX(0);
          animation: bar 4.2s ease-in-out forwards;
        }
        #txt {
          animation: fade 0.8s ease-out 0.3s both;
        }
        .fp {
          transform-box: fill-box;
          transform-origin: 50% 0;
          transform: scale(0);
          animation: fp 0.35s ease-out var(--t) forwards;
        }
        .fs {
          transform-box: fill-box;
          transform-origin: 50% 0;
          animation: fswing 2.8s ease-in-out calc(var(--t) + 0.4s) infinite;
        }
      `}</style>

      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 390 750"
        role="img"
        aria-label="Hydroponic loading"
        style={{
          height: '100%',
          maxHeight: '100vh',
          width: 'auto',
          maxWidth: '100%',
        }}
      >
        <defs>
          <linearGradient id="gBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#E6F8EE" />
            <stop offset="1" stopColor="#FFFFFF" />
          </linearGradient>
          <linearGradient id="gBody" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#6BD3FB" />
            <stop offset="1" stopColor="#1C93EA" />
          </linearGradient>
          <radialGradient id="gHead" cx=".35" cy=".3" r=".8">
            <stop offset="0" stopColor="#8CF0A5" />
            <stop offset="1" stopColor="#2FBF67" />
          </radialGradient>
          <linearGradient id="gLeaf" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#4ADE80" />
            <stop offset="1" stopColor="#15803D" />
          </linearGradient>
          <filter id="blur" x="-20%" y="-100%" width="140%" height="300%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
          <path id="leaf" d="M0 0 C4 -9 16 -9 22 0 C16 9 4 9 0 0Z" />
          <g id="fTom">
            <circle cy="7" r="6.5" fill="#EF4444" />
            <ellipse cx="-2.5" cy="5" rx="1.8" ry="1.1" fill="#fff" opacity=".5" />
            <path d="M-4.5 1.5 L0 3.6 L4.5 1.5 L1.6 0 L0 1.2 L-1.6 0Z" fill="#15803D" />
          </g>
          <g id="fChi">
            <path d="M-2.5 1 C5 4 5 14 -1 20 C-1 13 -5 7 -2.5 1Z" fill="#DC2626" />
            <rect x="-4" y="-1" width="5" height="3.5" rx="1.2" fill="#15803D" />
          </g>
          <g id="fPep">
            <path d="M-6.5 3 C-9 10 -6 15.5 0 15.5 C6 15.5 9 10 6.5 3 C3 1 -3 1 -6.5 3Z" fill="#FBBF24" />
            <path d="M0 2 C-2 8 -2 12 0 15" stroke="#F59E0B" strokeWidth="1" fill="none" />
            <rect x="-1.2" y="-1.5" width="2.4" height="4.5" rx="1" fill="#15803D" />
          </g>
          <g id="fEgg">
            <path d="M-3.5 1 C-10 5 -8 16 -2 20 C4 23 7 14 4 6 C3 3 1 1 -3.5 1Z" fill="#7C3AED" />
            <ellipse cx="-3" cy="9" rx="1.2" ry="3" fill="#fff" opacity=".35" />
            <path d="M-6 0 L5 0 L3 4 L-4 4Z" fill="#15803D" />
          </g>
          <g id="fStr">
            <path d="M-6.5 3 C-7.5 11 -2 17.5 0 18.5 C2 17.5 7.5 11 6.5 3 C3 1 -3 1 -6.5 3Z" fill="#F43F5E" />
            <g fill="#FDE68A">
              <circle cx="-2.5" cy="7" r=".9" />
              <circle cx="2.5" cy="7" r=".9" />
              <circle cy="11" r=".9" />
              <circle cx="-2" cy="14" r=".8" />
              <circle cx="2" cy="14" r=".8" />
            </g>
            <path d="M-5 2.5 L0 5 L5 2.5 L2 .5 L0 2 L-2 .5Z" fill="#15803D" />
          </g>
          <g id="fOra">
            <circle cy="7" r="6.8" fill="#FB923C" />
            <ellipse cx="-2.5" cy="5" rx="1.8" ry="1.1" fill="#fff" opacity=".45" />
            <path d="M0 .5 C2 -2 6 -2 7 0 C5 2 2 2 0 .5Z" fill="#15803D" />
          </g>
        </defs>

        <rect id="bg" width="390" height="750" fill="url(#gBg)" />
        <ellipse cx="195" cy="598" rx="64" ry="7" fill="#0F172A" opacity=".13" filter="url(#blur)" />

        {/* Tree Growth */}
        <g id="tree">
          <path className="gr" strokeWidth="9" pathLength={1} style={{ ['--t' as any]: '0.6s', ['--d' as any]: '0.5s' }} d="M195 440 C195 400 195 340 195 300" />
          <path className="gr" strokeWidth="6.5" pathLength={1} style={{ ['--t' as any]: '1.0s', ['--d' as any]: '0.5s' }} d="M195 300 C195 260 195 230 195 200" />
          <path className="gr" strokeWidth="4.5" pathLength={1} style={{ ['--t' as any]: '1.4s', ['--d' as any]: '0.4s' }} d="M195 200 C195 175 195 160 195 142" />
          <path className="gr" strokeWidth="4.5" pathLength={1} style={{ ['--t' as any]: '0.9s', ['--d' as any]: '0.4s' }} d="M195 372 C169 360 137 346 111 312" />
          <path className="gr" strokeWidth="4.5" pathLength={1} style={{ ['--t' as any]: '0.9s', ['--d' as any]: '0.4s' }} d="M195 372 C221 360 253 346 279 312" />
          <path className="gr" strokeWidth="4.0" pathLength={1} style={{ ['--t' as any]: '1.2s', ['--d' as any]: '0.4s' }} d="M195 320 C165 308 129 294 99 258" />
          <path className="gr" strokeWidth="4.0" pathLength={1} style={{ ['--t' as any]: '1.2s', ['--d' as any]: '0.4s' }} d="M195 320 C225 308 261 294 291 258" />
          <path className="gr" strokeWidth="3.5" pathLength={1} style={{ ['--t' as any]: '1.4s', ['--d' as any]: '0.4s' }} d="M195 268 C169 254 139 236 117 204" />
          <path className="gr" strokeWidth="3.5" pathLength={1} style={{ ['--t' as any]: '1.4s', ['--d' as any]: '0.4s' }} d="M195 268 C221 254 251 236 273 204" />
          <path className="gr" strokeWidth="3.0" pathLength={1} style={{ ['--t' as any]: '1.6s', ['--d' as any]: '0.4s' }} d="M195 222 C177 208 155 190 143 158" />
          <path className="gr" strokeWidth="3.0" pathLength={1} style={{ ['--t' as any]: '1.6s', ['--d' as any]: '0.4s' }} d="M195 222 C213 208 235 190 247 158" />

          {/* Leaves */}
          <g transform="translate(111.0 312.0) rotate(-167) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '1.80s' }}><use href="#leaf" /></g></g>
          <g transform="translate(111.0 312.0) rotate(-127) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '1.80s' }}><use href="#leaf" /></g></g>
          <g transform="translate(111.0 312.0) rotate(-87) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '1.70s' }}><use href="#leaf" /></g></g>
          <g transform="translate(142.6 343.1) rotate(-203) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '1.60s' }}><use href="#leaf" /></g></g>
          <g transform="translate(142.6 343.1) rotate(-88) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '1.60s' }}><use href="#leaf" /></g></g>
          <g transform="translate(279.0 312.0) rotate(-93) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '1.75s' }}><use href="#leaf" /></g></g>
          <g transform="translate(279.0 312.0) rotate(-53) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '1.80s' }}><use href="#leaf" /></g></g>
          <g transform="translate(279.0 312.0) rotate(-13) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '1.75s' }}><use href="#leaf" /></g></g>
          <g transform="translate(247.4 343.1) rotate(-97) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '1.70s' }}><use href="#leaf" /></g></g>
          <g transform="translate(247.4 343.1) rotate(18) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '1.65s' }}><use href="#leaf" /></g></g>
          <g transform="translate(99.0 258.0) rotate(-170) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.00s' }}><use href="#leaf" /></g></g>
          <g transform="translate(99.0 258.0) rotate(-130) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.10s' }}><use href="#leaf" /></g></g>
          <g transform="translate(99.0 258.0) rotate(-90) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '2.00s' }}><use href="#leaf" /></g></g>
          <g transform="translate(135.1 290.6) rotate(-206) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '2.00s' }}><use href="#leaf" /></g></g>
          <g transform="translate(135.1 290.6) rotate(-91) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '1.90s' }}><use href="#leaf" /></g></g>
          <g transform="translate(291.0 258.0) rotate(-90) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '1.90s' }}><use href="#leaf" /></g></g>
          <g transform="translate(291.0 258.0) rotate(-50) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.00s' }}><use href="#leaf" /></g></g>
          <g transform="translate(291.0 258.0) rotate(-10) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '1.95s' }}><use href="#leaf" /></g></g>
          <g transform="translate(254.9 290.6) rotate(-94) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '1.80s' }}><use href="#leaf" /></g></g>
          <g transform="translate(254.9 290.6) rotate(21) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '1.90s' }}><use href="#leaf" /></g></g>
          <g transform="translate(117.0 204.0) rotate(-165) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.10s' }}><use href="#leaf" /></g></g>
          <g transform="translate(117.0 204.0) rotate(-125) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.20s' }}><use href="#leaf" /></g></g>
          <g transform="translate(117.0 204.0) rotate(-85) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '2.00s' }}><use href="#leaf" /></g></g>
          <g transform="translate(144.9 235.0) rotate(-199) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.00s' }}><use href="#leaf" /></g></g>
          <g transform="translate(144.9 235.0) rotate(-84) scale(1.3)"><g className="lf l2" style={{ ['--t' as any]: '2.00s' }}><use href="#leaf" /></g></g>
          <g transform="translate(273.0 204.0) rotate(-95) scale(1.3)"><g className="lf l2" style={{ ['--t' as any]: '2.10s' }}><use href="#leaf" /></g></g>
          <g transform="translate(273.0 204.0) rotate(-55) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '2.10s' }}><use href="#leaf" /></g></g>
          <g transform="translate(273.0 204.0) rotate(-15) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.20s' }}><use href="#leaf" /></g></g>
          <g transform="translate(245.1 235.0) rotate(-101) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '2.10s' }}><use href="#leaf" /></g></g>
          <g transform="translate(245.1 235.0) rotate(14) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.05s' }}><use href="#leaf" /></g></g>
          <g transform="translate(143.0 158.0) rotate(-151) scale(1.3)"><g className="lf l2" style={{ ['--t' as any]: '2.20s' }}><use href="#leaf" /></g></g>
          <g transform="translate(143.0 158.0) rotate(-111) scale(1.3)"><g className="lf l2" style={{ ['--t' as any]: '2.30s' }}><use href="#leaf" /></g></g>
          <g transform="translate(143.0 158.0) rotate(-71) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '2.25s' }}><use href="#leaf" /></g></g>
          <g transform="translate(160.2 189.0) rotate(-188) scale(1.3)"><g className="lf l2" style={{ ['--t' as any]: '2.05s' }}><use href="#leaf" /></g></g>
          <g transform="translate(160.2 189.0) rotate(-73) scale(1.3)"><g className="lf l2" style={{ ['--t' as any]: '2.05s' }}><use href="#leaf" /></g></g>
          <g transform="translate(247.0 158.0) rotate(-109) scale(1.3)"><g className="lf l2" style={{ ['--t' as any]: '2.15s' }}><use href="#leaf" /></g></g>
          <g transform="translate(247.0 158.0) rotate(-69) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.20s' }}><use href="#leaf" /></g></g>
          <g transform="translate(247.0 158.0) rotate(-29) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.10s' }}><use href="#leaf" /></g></g>
          <g transform="translate(229.8 189.0) rotate(-112) scale(1.3)"><g className="lf l2" style={{ ['--t' as any]: '2.15s' }}><use href="#leaf" /></g></g>
          <g transform="translate(229.8 189.0) rotate(3) scale(1.3)"><g className="lf l2" style={{ ['--t' as any]: '2.10s' }}><use href="#leaf" /></g></g>
          <g transform="translate(195.0 142.0) rotate(-90) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.35s' }}><use href="#leaf" /></g></g>
          <g transform="translate(195.0 142.0) rotate(-135) scale(1.3)"><g className="lf l1" style={{ ['--t' as any]: '2.40s' }}><use href="#leaf" /></g></g>
          <g transform="translate(195.0 142.0) rotate(-45) scale(1.3)"><g className="lf l2" style={{ ['--t' as any]: '2.40s' }}><use href="#leaf" /></g></g>
          <g transform="translate(195.0 142.0) rotate(-165) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.30s' }}><use href="#leaf" /></g></g>
          <g transform="translate(195.0 142.0) rotate(-15) scale(1.3)"><g className="lf l3" style={{ ['--t' as any]: '2.15s' }}><use href="#leaf" /></g></g>

          {/* Fruit Pops */}
          <g className="fp" style={{ ['--t' as any]: '2.50s' }}><g className="fs"><path d="M153.0 350.2 L153.0 355.2" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fTom" transform="translate(153.0 355.2)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '2.58s' }}><g className="fs"><path d="M237.0 350.2 L237.0 355.2" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fChi" transform="translate(237.0 355.2)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '2.66s' }}><g className="fs"><path d="M125.6 328.5 L125.6 333.5" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fPep" transform="translate(125.6 333.5)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '2.74s' }}><g className="fs"><path d="M264.4 328.5 L264.4 333.5" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fEgg" transform="translate(264.4 333.5)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '2.82s' }}><g className="fs"><path d="M147.0 298.0 L147.0 303.0" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fStr" transform="translate(147.0 303.0)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '2.90s' }}><g className="fs"><path d="M243.0 298.0 L243.0 303.0" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fOra" transform="translate(243.0 303.0)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '2.98s' }}><g className="fs"><path d="M115.7 275.4 L115.7 280.4" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fTom" transform="translate(115.7 280.4)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '3.06s' }}><g className="fs"><path d="M274.3 275.4 L274.3 280.4" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fChi" transform="translate(274.3 280.4)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '3.14s' }}><g className="fs"><path d="M154.5 242.8 L154.5 247.8" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fPep" transform="translate(154.5 247.8)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '3.22s' }}><g className="fs"><path d="M235.5 242.8 L235.5 247.8" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fEgg" transform="translate(235.5 247.8)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '3.30s' }}><g className="fs"><path d="M129.6 220.0 L129.6 225.0" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fStr" transform="translate(129.6 225.0)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '3.38s' }}><g className="fs"><path d="M260.4 220.0 L260.4 225.0" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fOra" transform="translate(260.4 225.0)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '3.46s' }}><g className="fs"><path d="M153.7 179.5 L153.7 184.5" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fTom" transform="translate(153.7 184.5)" /></g></g>
          <g className="fp" style={{ ['--t' as any]: '3.54s' }}><g className="fs"><path d="M236.3 179.5 L236.3 184.5" stroke="#4A6B45" strokeWidth="1.6" strokeLinecap="round" /><use href="#fChi" transform="translate(236.3 184.5)" /></g></g>
        </g>

        {/* Hydroponic Mascot Character */}
        <g id="mas">
          <g transform="translate(65 355) scale(.65)">
            {/* Mascot Antenna matching logo */}
            <g>
              <line x1="200" y1="120" x2="200" y2="65" stroke="#EAB308" strokeWidth="4.5" strokeLinecap="round" />
              <circle cx="200" cy="58" r="9" fill="none" stroke="#EAB308" strokeWidth="3.5" />
              <circle cx="200" cy="58" r="4.5" fill="#EAB308" />
              <path d="M187 46 C194 40 206 40 213 46" fill="none" stroke="#FDE047" strokeWidth="2.5" strokeLinecap="round" opacity="0.85" />
            </g>
            <g className="lL"><path d="M200 120 C188 92 152 84 126 98 C148 116 176 122 200 120Z" fill="url(#gLeaf)" /></g>
            <g className="lR"><path d="M200 120 C212 92 248 84 274 98 C252 116 224 122 200 120Z" fill="url(#gLeaf)" /></g>
            <path d="M118 268 C118 332 154 366 200 366 C246 366 282 332 282 268 C282 232 250 222 200 222 C150 222 118 232 118 268Z" fill="url(#gBody)" />
            <ellipse cx="150" cy="310" rx="9" ry="22" transform="rotate(25 150 310)" fill="#fff" opacity=".45" />
            <g id="hd">
              <circle cx="200" cy="195" r="80" fill="url(#gHead)" />
              <ellipse cx="166" cy="150" rx="22" ry="12" transform="rotate(-30 166 150)" fill="#fff" opacity=".35" />
              <g id="eo">
                <g id="bl">
                  <circle cx="170" cy="198" r="11" fill="#10241A" />
                  <circle cx="230" cy="198" r="11" fill="#10241A" />
                  <circle cx="173.5" cy="194" r="4" fill="#fff" />
                  <circle cx="233.5" cy="194" r="4" fill="#fff" />
                </g>
              </g>
              <g id="eh" fill="none" stroke="#10241A" strokeWidth="4.5" strokeLinecap="round">
                <path d="M159 203 Q170 187 181 203" />
                <path d="M219 203 Q230 187 241 203" />
              </g>
              <path d="M182 225 Q200 242 218 225" fill="none" stroke="#14391F" strokeWidth="4.5" strokeLinecap="round" />
              <ellipse cx="148" cy="222" rx="13" ry="8" fill="#FF9EB5" opacity=".55" />
              <ellipse cx="252" cy="222" rx="13" ry="8" fill="#FF9EB5" opacity=".55" />
            </g>
          </g>
        </g>

        {/* Water Stream & Splash */}
        <g className="stream">
          <path className="flow" d="M195 362 L195 440" fill="none" stroke="#5BC0F8" strokeWidth="7" strokeLinecap="round" strokeDasharray="10 9" />
        </g>
        <g className="splash" fill="#7CCBF8" transform="translate(195 441)">
          <circle className="sd" r="3" style={{ ['--x' as any]: '-16px', ['--y' as any]: '-18px' }} />
          <circle className="sd" r="2.5" style={{ ['--x' as any]: '16px', ['--y' as any]: '-20px', animationDelay: '.2s' }} />
          <circle className="sd" r="2" style={{ ['--x' as any]: '-8px', ['--y' as any]: '-26px', animationDelay: '.35s' }} />
          <circle className="sd" r="2.5" style={{ ['--x' as any]: '26px', ['--y' as any]: '-8px', animationDelay: '.5s' }} />
        </g>

        {/* Watering Pail */}
        <g transform="translate(195 360)">
          <g className="pail">
            <path d="M4 0 C4 -34 60 -34 60 0" fill="none" stroke="#94A3B8" strokeWidth="3" />
            <path d="M0 0 L64 0 L56 62 Q56 66 52 66 L12 66 Q8 66 8 62 Z" fill="#CBD5E1" />
            <rect x="-2" y="-3" width="68" height="6" rx="3" fill="#94A3B8" />
            <path d="M12 20 L52 20" stroke="#fff" strokeOpacity=".6" strokeWidth="3" strokeLinecap="round" />
          </g>
        </g>

        {/* Title Typography */}
        <g id="txt" textAnchor="middle">
          <text x="195" y="650" fontFamily="Inter, 'Segoe UI', Arial, sans-serif" fontSize="30" fontWeight="700" letterSpacing="2" fill="#0F172A">
            Hydroponic
          </text>
          <text x="195" y="680" fontFamily="'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif" fontSize="14" fill="#64748B">
            ระบบจัดการไฮโดรโปนิกส์อัจฉริยะ
          </text>
        </g>

        {/* Progress Bar */}
        <rect x="145" y="708" width="100" height="4" rx="2" fill="#D3EEDF" />
        <rect className="bar" x="145" y="708" width="100" height="4" rx="2" fill="#1D9E75" />
      </svg>
    </div>
  );
}
