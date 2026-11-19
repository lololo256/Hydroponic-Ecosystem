import { FlaskConical } from 'lucide-react';

/**
 * Shown when the board reports `sim === true` (CYD demo board compiled with DEMO_SIM).
 * Makes it impossible to mistake simulated readings for real sensor values.
 */
export default function DemoBoardBadge({ compact = false }: { compact?: boolean }) {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: compact ? '4px 10px' : '8px 12px',
        borderRadius: 12,
        background: '#fffbeb',
        border: '1px solid #fcd34d',
        color: '#92400e',
        fontSize: compact ? 11 : 12,
        fontWeight: 600,
        lineHeight: 1.4,
      }}
    >
      <FlaskConical size={compact ? 13 : 15} strokeWidth={2.2} style={{ flexShrink: 0 }} />
      <span>
        โหมดสาธิต (อุปกรณ์จำลอง)
        {!compact && (
          <span style={{ display: 'block', fontWeight: 500, color: '#a16207', fontSize: 11 }}>
            ค่าที่แสดงมาจากอุปกรณ์จำลอง ไม่ใช่การตรวจวัดจากน้ำจริง
          </span>
        )}
      </span>
    </div>
  );
}
