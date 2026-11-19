import { NavProps, Screen } from '../types';
import { ArrowLeft, Menu } from 'lucide-react';

interface TopBarProps {
  title: string;
  onBack?: () => void;
  onMenu?: () => void;
  navigate?: (s: Screen) => void;
  action?: React.ReactNode;
}

export default function TopBar({ title, onBack, onMenu, navigate, action }: TopBarProps) {
  return (
    <div className="sticky top-0 z-30 bg-[#f0fdf9]/90 backdrop-blur-md px-4 pt-10 pb-3 flex items-center gap-3">
      {onBack && (
        <button onClick={onBack} aria-label="ย้อนกลับ" className="w-11 h-11 rounded-xl bg-white shadow-sm flex items-center justify-center text-slate-600 hover:bg-slate-50 transition-colors">
          <ArrowLeft size={18} strokeWidth={2} />
        </button>
      )}
      {onMenu && (
        <button onClick={onMenu} aria-label="เมนู" className="w-11 h-11 rounded-xl bg-white shadow-sm flex items-center justify-center text-slate-600 hover:bg-slate-50 transition-colors">
          <Menu size={18} strokeWidth={2} />
        </button>
      )}
      <h1 className="flex-1 text-lg font-black text-slate-800" style={{ fontFamily: 'Nunito, sans-serif' }}>
        {title}
      </h1>
      {action}
    </div>
  );
}
