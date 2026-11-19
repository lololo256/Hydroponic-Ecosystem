import React, { Component, ErrorInfo, ReactNode } from 'react';
import { RotateCw, Home, AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error caught by ErrorBoundary:', error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleReset = () => {
    try {
      localStorage.removeItem('connected_board_id');
    } catch (_) {}
    window.location.href = '/';
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: '100vh',
            width: '100vw',
            background: 'linear-gradient(180deg, #F0FBF6 0%, #FFFFFF 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            fontFamily: "'IBM Plex Sans Thai', 'Noto Sans Thai', sans-serif",
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              maxWidth: '380px',
              width: '100%',
              background: '#FFFFFF',
              borderRadius: '24px',
              padding: '28px 24px',
              boxShadow: '0 20px 40px rgba(16, 185, 129, 0.08), 0 1px 3px rgba(0,0,0,0.05)',
              border: '1px solid #E2E8F0',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '50%',
                background: '#FEF2F2',
                color: '#EF4444',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px auto',
              }}
            >
              <AlertTriangle size={28} />
            </div>

            <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#0F172A', marginBottom: '8px' }}>
              ระบบตรวจพบข้อผิดพลาดชั่วคราว
            </h2>

            <p style={{ fontSize: '13px', color: '#64748B', lineHeight: '1.6', marginBottom: '20px' }}>
              แอปพลิเคชันได้รับการป้องกันไม่ให้ค้าง กรุณากดรีโหลดเพื่อเริ่มการทำงานใหม่ หรือเริ่มใช้งานจากหน้าหลัก
            </p>

            {this.state.error && (
              <div
                style={{
                  textAlign: 'left',
                  background: '#FEF2F2',
                  border: '1px solid #FECACA',
                  borderRadius: '12px',
                  padding: '12px',
                  marginBottom: '18px',
                  fontSize: '11px',
                  fontFamily: 'monospace',
                  color: '#991B1B',
                  overflowX: 'auto',
                  maxHeight: '160px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: '4px' }}>
                  {this.state.error.name}: {this.state.error.message}
                </div>
                {this.state.error.stack && (
                  <div style={{ color: '#B91C1C', fontSize: '10px', opacity: 0.85 }}>
                    {this.state.error.stack}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                onClick={this.handleReload}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  borderRadius: '14px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #059669 0%, #10B981 100%)',
                  color: '#FFFFFF',
                  fontSize: '14px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(16, 185, 129, 0.25)',
                }}
              >
                <RotateCw size={16} />
                รีโหลดแอปพลิเคชัน
              </button>

              <button
                onClick={this.handleReset}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  borderRadius: '14px',
                  border: '1px solid #E2E8F0',
                  background: '#F8FAFC',
                  color: '#475569',
                  fontSize: '13px',
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                }}
              >
                <Home size={15} />
                กลับหน้าหลัก
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
