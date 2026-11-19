import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, AlertCircle, Info, Power, Loader2 } from 'lucide-react';

export type ModalVariant = 'danger' | 'success' | 'warning' | 'info';

export interface ModalState {
  isOpen: boolean;
  title: string;
  message: string;
  variant?: ModalVariant;
  confirmText?: string;
  cancelText?: string;
  isAlert?: boolean;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void;
}

interface Props {
  modalState: ModalState;
  onClose: () => void;
}

export default function ModernConfirmModal({ modalState, onClose }: Props) {
  const {
    isOpen,
    title,
    message,
    variant = 'info',
    confirmText = 'ยืนยัน',
    cancelText = 'ยกเลิก',
    isAlert = false,
    onConfirm,
    onCancel,
  } = modalState;

  // Pending state while onConfirm runs; the modal stays open until it resolves
  const [pending, setPending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Latest modal state: onConfirm may open another modal (e.g. showAlert) through the same shared
  // state; in that case we must not close the new one when the first onConfirm resolves.
  const latestStateRef = useRef(modalState);
  latestStateRef.current = modalState;

  useEffect(() => {
    setPending(false);
    setErrorText(null);
  }, [modalState]);

  const handleCancelClick = () => {
    if (pending) return;
    onClose();
    if (onCancel) {
      onCancel();
    }
  };

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) {
        if (onCancel) onCancel();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel, onClose, pending]);

  if (!isOpen) return null;

  const handleConfirmClick = async () => {
    if (pending) return;
    if (!onConfirm) {
      onClose();
      return;
    }
    const startedWith = modalState;
    setErrorText(null);
    setPending(true);
    try {
      await onConfirm();
    } catch (err: any) {
      if (latestStateRef.current === startedWith) {
        setPending(false);
        setErrorText(err?.message ? String(err.message) : 'ทำรายการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
      }
      return;
    }
    // Close only if onConfirm did not already replace this modal with another one
    if (latestStateRef.current === startedWith) {
      setPending(false);
      onClose();
    }
  };

  // Icon & Theme Styling based on variant
  const getVariantStyles = () => {
    switch (variant) {
      case 'danger':
        return {
          icon: <Power size={26} strokeWidth={2.2} />,
          badgeBg: '#fef2f2',
          badgeBorder: '#fecaca',
          badgeColor: '#dc2626',
          confirmBtnBg: '#dc2626',
          confirmBtnHover: '#b91c1c',
          confirmShadow: '0 4px 14px rgba(220, 38, 38, 0.35)',
        };
      case 'success':
        return {
          icon: <Power size={26} strokeWidth={2.2} />,
          badgeBg: '#ecfdf5',
          badgeBorder: '#a7f3d0',
          badgeColor: '#059669',
          confirmBtnBg: '#059669',
          confirmBtnHover: '#047857',
          confirmShadow: '0 4px 14px rgba(5, 150, 105, 0.35)',
        };
      case 'warning':
        return {
          icon: <AlertTriangle size={26} strokeWidth={2.2} />,
          badgeBg: '#fffbeb',
          badgeBorder: '#fde68a',
          badgeColor: '#d97706',
          confirmBtnBg: '#d97706',
          confirmBtnHover: '#b45309',
          confirmShadow: '0 4px 14px rgba(217, 119, 6, 0.35)',
        };
      case 'info':
      default:
        return {
          icon: <Info size={26} strokeWidth={2.2} />,
          badgeBg: '#f0f9ff',
          badgeBorder: '#bae6fd',
          badgeColor: '#0284c7',
          confirmBtnBg: '#0f172a',
          confirmBtnHover: '#1e293b',
          confirmShadow: '0 4px 14px rgba(15, 23, 42, 0.25)',
        };
    }
  };

  const vStyles = getVariantStyles();

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        background: 'rgba(15, 23, 42, 0.6)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'modalFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
        fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
      }}
      onClick={handleCancelClick}
    >
      <style>{`
        @keyframes modalFadeIn {
          from { opacity: 0; transform: scale(0.96); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div
        style={{
          width: '100%',
          maxWidth: 340,
          background: '#ffffff',
          borderRadius: 24,
          padding: '24px 20px 20px',
          boxSizing: 'border-box',
          boxShadow: '0 25px 50px -12px rgba(15, 23, 42, 0.28), 0 0 0 1px rgba(226, 232, 240, 0.8)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Icon Badge */}
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 18,
            background: vStyles.badgeBg,
            border: `1.5px solid ${vStyles.badgeBorder}`,
            color: vStyles.badgeColor,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 16,
            flexShrink: 0,
          }}
        >
          {vStyles.icon}
        </div>

        {/* Modal Title */}
        <h3
          style={{
            fontSize: 17,
            fontWeight: 700,
            color: '#0f172a',
            margin: '0 0 8px',
            lineHeight: 1.3,
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </h3>

        {/* Modal Message */}
        <p
          style={{
            fontSize: 13.5,
            fontWeight: 400,
            color: '#64748b',
            margin: '0 0 22px',
            lineHeight: 1.5,
            whiteSpace: 'pre-line',
            wordBreak: 'break-word',
          }}
        >
          {message}
        </p>

        {/* Error from onConfirm (modal stays open so the user can retry or cancel) */}
        {errorText && (
          <div
            role="alert"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              margin: '-10px 0 16px',
              padding: '8px 10px',
              borderRadius: 10,
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#b91c1c',
              fontSize: 12.5,
              lineHeight: 1.45,
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
              textAlign: 'left',
            }}
          >
            <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ wordBreak: 'break-word' }}>{errorText}</span>
          </div>
        )}

        {/* Actions */}
        <div
          style={{
            display: 'flex',
            gap: 10,
            width: '100%',
          }}
        >
          {!isAlert && (
            <button
              type="button"
              onClick={handleCancelClick}
              disabled={pending}
              style={{
                flex: 1,
                height: 44,
                borderRadius: 14,
                border: '1px solid #e2e8f0',
                background: '#f8fafc',
                color: '#475569',
                fontSize: 14,
                fontWeight: 600,
                cursor: pending ? 'not-allowed' : 'pointer',
                opacity: pending ? 0.6 : 1,
                transition: 'background 0.15s ease',
              }}
            >
              {cancelText}
            </button>
          )}

          <button
            type="button"
            onClick={handleConfirmClick}
            disabled={pending}
            aria-busy={pending}
            style={{
              flex: 1,
              height: 44,
              borderRadius: 14,
              border: 'none',
              background: vStyles.confirmBtnBg,
              color: '#ffffff',
              fontSize: 14,
              fontWeight: 600,
              cursor: pending ? 'wait' : 'pointer',
              opacity: pending ? 0.75 : 1,
              boxShadow: vStyles.confirmShadow,
              transition: 'all 0.15s ease',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            {pending && <Loader2 size={16} className="animate-spin" />}
            <span>{pending ? 'กำลังดำเนินการ...' : errorText ? 'ลองอีกครั้ง' : confirmText}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
